// Opt-in browser regression: fake microphone + real AudioWorklet/Worker/socket.
// Isolated local fake ASR; never opens the application store or a paid API.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {spawn} = require('node:child_process');
const {Server} = require('socket.io');
const WebSocket = require('ws');
const net = require('node:net');
const {AUDIO_WIRE, decodeAudioPacket} = require('../src/capture-wire.mjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {if (Date.now() > deadline) throw new Error('Browser capture test timed out'); await wait(50);}
}
async function cdp(url) {
  const ws = new WebSocket(url); let serial = 0; const pending = new Map();
  const errors = [];
  ws.on('message', data => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    const request = pending.get(message.id);
    if (request) {pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);}
  });
  await new Promise((resolve, reject) => {ws.once('open', resolve); ws.once('error', reject);});
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial; pending.set(id, {resolve, reject}); ws.send(JSON.stringify({id, method, params}));
  });
  return {ws, errors, send, evaluate: async expression => {
    const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }};
}

async function main() {
  const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await fs.access(chromePath);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-capture-browser-'));
  let chrome, browser, vite, io, proxy;
  const proxySockets = new Set();
  try {
    const {createServer} = await import(pathToFileURL(require.resolve('../../client/node_modules/vite')).href);
    vite = await createServer({configFile: false, root: path.resolve(__dirname, '../..', 'client'),
      server: {host: '127.0.0.1', port: 0}, plugins: [{name: 'capture-test-page', configureServer(server) {
        server.middlewares.use('/__capture_test', (_req, res) => {
          res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><script type="module">
            import {CaptureSession} from '/src/lib/capture-session.js';
            window.events = []; window.capture = new CaptureSession();
            capture.onEvent = event => {events.push(event); if(events.length > 100) events.shift()};
            capture.report = event => {events.push(event); if(events.length > 100) events.shift()};
            window.start = origin => capture.start({origin: origin || location.origin,
              clientInfo: {captureOwnerId: 'browser-test'}, request: {sessionId: 'browser-test', autoFollow: true}});
          </script>`);
        });
      }}]});
    io = new Server(vite.httpServer);
    const stats = {frames: 0, starts: 0, connections: 0, probes: 0, lostReceipts: false, rejectProvider: false, stops: 0,
      receiptDelayMs: 0, sourceGaps: 0};
    io.on('connection', socket => {
      stats.connections++;
      socket.on('transcription:start', (data, ack) => {
        stats.starts++; socket.data.captureId = data.clientInfo.captureId; socket.data.audioMs = 0; socket.data.sourceEndMs = null;
        ack({ok: true, audioWire: AUDIO_WIRE});
      });
      const receive = data => {
        assert.equal(data.durationMs, data.pcm.length / 48, 'browser PCM clock must match binary bytes');
        if (socket.data.sourceEndMs !== null && Math.abs(data.sourceStartMs - socket.data.sourceEndMs) > 1) stats.sourceGaps++;
        socket.data.sourceEndMs = data.sourceEndMs;
        stats.frames++; socket.data.sequence = data.sequence; socket.data.audioMs += data.durationMs;
        if (stats.rejectProvider) {
          stats.rejectProvider = false;
          socket.emit('transcription:audio-ack', {captureId: data.captureId, sequence: data.sequence,
            ok: false, recoverable: true, recoveryReason: 'provider_backpressure'});
        } else if (!stats.lostReceipts) {
          const receipt = {ok: true, captureId: data.captureId, sequence: data.sequence, serverAudioMs: socket.data.audioMs};
          if (stats.receiptDelayMs) setTimeout(() => {if (socket.connected) socket.emit('transcription:audio-ack', receipt);}, stats.receiptDelayMs).unref();
          else socket.emit('transcription:audio-ack', receipt);
        }
      };
      socket.on('transcription:audio-pcm', receive);
      socket.on('transcription:audio-packed', bytes => {
        const decoded = decodeAudioPacket(bytes);
        receive({...decoded, pcm: Buffer.from(decoded.pcm), captureId: socket.data.captureId});
      });
      socket.on('transcription:capture-probe', (_data, ack) => {
        stats.probes++;
        const receipt = {ok: true, captureId: socket.data.captureId, sequence: socket.data.sequence, serverAudioMs: socket.data.audioMs};
        if (stats.receiptDelayMs) setTimeout(() => ack(receipt), stats.receiptDelayMs).unref();
        else ack(receipt);
      });
      socket.on('transcription:stop', () => stats.stops++);
    });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    let uploadBps = Infinity, maximumProxyQueue = 0;
    proxy = net.createServer(downstream => {
      const upstream = net.connect(vite.httpServer.address().port, '127.0.0.1');
      proxySockets.add(downstream); proxySockets.add(upstream);
      let handshake = true, queue = [], queued = 0, budget = 0, lastAt = Date.now();
      const drain = () => {
        const now = Date.now(); budget = Number.isFinite(uploadBps) ? Math.min(uploadBps / 10, budget + uploadBps * (now - lastAt) / 1000) : Infinity; lastAt = now;
        while (queue.length && budget >= 1) {
          const bytes = queue[0], size = Math.min(bytes.length, Math.floor(budget));
          upstream.write(bytes.subarray(0, size)); budget -= size; queued -= size;
          if (size === bytes.length) queue.shift(); else queue[0] = bytes.subarray(size);
        }
      };
      const timer = setInterval(drain, 10); timer.unref();
      downstream.on('data', bytes => {
        if (handshake) {handshake = false; upstream.write(bytes); return;}
        queue.push(bytes); queued += bytes.length; maximumProxyQueue = Math.max(maximumProxyQueue, queued); drain();
      });
      upstream.pipe(downstream);
      const close = () => {clearInterval(timer); queue = []; upstream.destroy(); downstream.destroy(); proxySockets.delete(upstream); proxySockets.delete(downstream);};
      downstream.on('close', close); downstream.on('error', close); upstream.on('error', close);
    });
    await new Promise((resolve, reject) => {proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve);});
    const audioOrigin = `http://127.0.0.1:${proxy.address().port}`;
    const wavPath = path.join(profile, 'speech-like.wav'), frames = 48000 * 30, wav = Buffer.alloc(44 + frames * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
    for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(655 * Math.sin(2 * Math.PI * 180 * i / 48000)), 44 + i * 2);
    await fs.writeFile(wavPath, wav);
    chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      `--use-file-for-fake-audio-capture=${wavPath}`,
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {stdio: 'ignore'});
    let port;
    await until(async () => {try {port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0;} catch {return false;}});
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(origin + '/__capture_test')}`, {method: 'PUT'})).json();
    browser = await cdp(target.webSocketDebuggerUrl); await browser.send('Runtime.enable');
    await until(() => browser.evaluate('typeof window.start === "function"'));
    assert.equal(await browser.evaluate(`start(${JSON.stringify(audioOrigin)})`), true);
    await until(() => stats.frames >= 15);
    const source = await browser.evaluate('({id:capture.sourceId,track:capture.mediaStream.id,state:capture.audioContext.state})');
    const beforeBusy = stats.frames;
    await browser.evaluate('(() => {const until=performance.now()+1600; while(performance.now()<until) {} return true})()');
    assert.ok(stats.frames - beforeBusy >= 12, 'audio must keep arriving while the UI thread is blocked');
    assert.equal(stats.starts, 1);
    console.log('PASS: UI blocked for 1.6 seconds while direct worker audio continues');
    stats.lostReceipts = true; await wait(6500);
    assert.equal(stats.starts, 1); assert.ok(stats.probes >= 1);
    console.log('PASS: missing receipts beyond four seconds do not restart capture or ASR');
    stats.lostReceipts = false; stats.receiptDelayMs = 3000;
    const beforeDelayed = {frames: stats.frames, gaps: stats.sourceGaps};
    await wait(8000);
    assert.ok(stats.frames - beforeDelayed.frames >= 90, 'three-second receipts must still deliver continuous source audio');
    assert.equal(stats.sourceGaps, beforeDelayed.gaps, 'receipt latency must not cut words out of the microphone stream');
    assert.equal(stats.starts, 1);
    console.log('PASS: real three-second PCM/probe receipts preserve source continuity without restarting ASR');
    stats.receiptDelayMs = 0;
    stats.lostReceipts = false; uploadBps = 28000;
    const beforeLimited = stats.frames; await wait(5500);
    assert.equal(stats.starts, 1); assert.ok(stats.frames - beforeLimited >= 55, 'limited uplink must still deliver continuous PCM');
    assert.ok(maximumProxyQueue < 65536, 'upload queue must remain bounded');
    console.log('PASS: lossless audio stays continuous through a real 28 kB/s upload proxy');
    uploadBps = Infinity;
    stats.lostReceipts = false; stats.rejectProvider = true;
    await until(() => stats.starts === 2); await wait(500);
    assert.equal(stats.connections, 1, 'provider failure must reuse the audio transport');
    assert.deepEqual(await browser.evaluate('({id:capture.sourceId,track:capture.mediaStream.id,state:capture.audioContext.state})'), source);
    console.log('PASS: provider replacement keeps the same microphone, AudioContext and WebSocket');
    for (const socket of io.sockets.sockets.values()) socket.disconnect(true);
    await until(() => stats.starts === 3); await wait(500);
    assert.equal(stats.connections, 2);
    assert.deepEqual(await browser.evaluate('({id:capture.sourceId,track:capture.mediaStream.id,state:capture.audioContext.state})'), source);
    console.log('PASS: real socket replacement keeps the same microphone and AudioContext');
    await browser.evaluate('capture.stop(); true'); await wait(500);
    const stopped = stats.frames; await wait(400); assert.equal(stats.frames, stopped); assert.ok(stats.stops >= 1);
    assert.deepEqual(browser.errors, []);
    console.log('PASS: explicit stop releases the source and prevents retries');
  } finally {
    browser?.ws.terminate(); chrome?.kill('SIGTERM');
    for (const socket of proxySockets) socket.destroy();
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    if (io) await new Promise(resolve => io.close(resolve));
    await vite?.close();
    if (chrome && chrome.exitCode === null) await new Promise(resolve => {chrome.once('exit', resolve); setTimeout(resolve, 3000).unref();});
    await fs.rm(profile, {recursive: true, force: true, maxRetries: 3});
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
