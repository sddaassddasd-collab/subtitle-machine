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
  let chrome, browser, vite, io;
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
            window.start = () => capture.start({origin: location.origin,
              clientInfo: {captureOwnerId: 'browser-test'}, request: {sessionId: 'browser-test', autoFollow: true}});
          </script>`);
        });
      }}]});
    io = new Server(vite.httpServer);
    const stats = {frames: 0, starts: 0, connections: 0, probes: 0, lostReceipts: false, rejectProvider: false, stops: 0};
    io.on('connection', socket => {
      stats.connections++;
      socket.on('transcription:start', (data, ack) => {
        stats.starts++; socket.data.captureId = data.clientInfo.captureId; socket.data.audioMs = 0;
        ack({ok: true});
      });
      socket.on('transcription:audio-pcm', data => {
        assert.equal(data.durationMs, data.pcm.length / 48, 'browser PCM clock must match binary bytes');
        stats.frames++; socket.data.sequence = data.sequence; socket.data.audioMs += data.durationMs;
        if (stats.rejectProvider) {
          stats.rejectProvider = false;
          socket.emit('transcription:audio-ack', {captureId: data.captureId, sequence: data.sequence,
            ok: false, recoverable: true, recoveryReason: 'provider_backpressure'});
        } else if (!stats.lostReceipts) socket.emit('transcription:audio-ack', {
          ok: true, captureId: data.captureId, sequence: data.sequence, serverAudioMs: socket.data.audioMs,
        });
      });
      socket.on('transcription:capture-probe', (_data, ack) => {stats.probes++; ack({ok: true,
        captureId: socket.data.captureId, sequence: socket.data.sequence, serverAudioMs: socket.data.audioMs});});
      socket.on('transcription:stop', () => stats.stops++);
    });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {stdio: 'ignore'});
    let port;
    await until(async () => {try {port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0;} catch {return false;}});
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(origin + '/__capture_test')}`, {method: 'PUT'})).json();
    browser = await cdp(target.webSocketDebuggerUrl); await browser.send('Runtime.enable');
    await until(() => browser.evaluate('typeof window.start === "function"'));
    assert.equal(await browser.evaluate('start()'), true);
    await until(() => stats.frames >= 15);
    const source = await browser.evaluate('({id:capture.sourceId,track:capture.mediaStream.id,state:capture.audioContext.state})');
    const beforeBusy = stats.frames;
    await browser.evaluate('(() => {const until=performance.now()+1600; while(performance.now()<until) {} return true})()');
    assert.ok(stats.frames - beforeBusy >= 20, 'audio must keep arriving while the UI thread is blocked');
    assert.equal(stats.starts, 1);
    console.log('PASS: UI blocked for 1.6 seconds while direct worker audio continues');
    stats.lostReceipts = true; await wait(6500);
    assert.equal(stats.starts, 1); assert.ok(stats.probes >= 1);
    console.log('PASS: missing receipts beyond four seconds do not restart capture or ASR');
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
    if (io) await new Promise(resolve => io.close(resolve));
    await vite?.close();
    if (chrome && chrome.exitCode === null) await new Promise(resolve => {chrome.once('exit', resolve); setTimeout(resolve, 3000).unref();});
    await fs.rm(profile, {recursive: true, force: true, maxRetries: 3});
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
