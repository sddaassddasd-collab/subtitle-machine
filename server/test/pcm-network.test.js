const {test} = require('node:test');
const assert = require('node:assert/strict');
const {io} = require('../../client/node_modules/socket.io-client');
const createFixture = require('./helpers/audio-server-fixture');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {if (Date.now() > deadline) throw new Error('local audio receipt timed out'); await wait(10);}
}

test('real isolated WebSocket PCM survives an audio disconnect while control remains connected', {timeout: 10000}, async t => {
  const f = createFixture({lineCount: 1000}); f.allowSettings();
  const clients = [];
  t.after(async () => {for (const socket of clients) socket.disconnect(); f.closeConnections(); f.dispose();});
  await new Promise((resolve, reject) => {f.server.once('error', reject); f.server.listen(0, '127.0.0.1', resolve);});
  const url = `http://127.0.0.1:${f.server.address().port}`;
  const connect = async () => {
    const socket = io(url, {forceNew: true, autoConnect: false, transports: ['websocket'], reconnection: false,
      extraHeaders: {Cookie: f.cookie}}); clients.push(socket);
    await new Promise((resolve, reject) => {socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect();});
    return socket;
  };
  const control = await connect(), first = await connect();
  const {CaptureTransport} = await import('../../client/src/lib/capture-transport.js');
  const pcm = new Int16Array(960).fill(100);
  const packet = (captureId, sequence) => ({sessionId: f.session.id, captureId, sequence, durationMs: 40,
    pcm: pcm.buffer, level: .001, capturedAt: Date.now(), captureAgeMs: 0});
  f.attachCapture(first.id, 'first');
  const old = new CaptureTransport(first);
  for (let i = 1; i <= 8; i++) assert.equal(old.send(packet('first', i)), true);
  await until(() => old.acknowledgedPackets === 8);
  assert.equal(f.stream.autoFollowAudioMs, 320);
  assert.equal(f.sent.at(-1).equals(Buffer.from(pcm.buffer)), true);
  old.close(); first.disconnect();
  await until(() => f.stream.closing);
  assert.equal(control.connected, true);

  const second = await connect(); f.attachCapture(second.id, 'second');
  const fresh = new CaptureTransport(second);
  for (let i = 1; i <= 5; i++) assert.equal(fresh.send(packet('second', i)), true);
  await until(() => fresh.acknowledgedPackets === 5);
  assert.equal(f.stream.autoFollowAudioMs, 200, 'replacement PCM has a new clock');
  assert.equal(old.send(packet('first', 9)), false, 'old samples cannot enter the replacement connection');
  assert.equal(control.connected, true); fresh.close();
});
