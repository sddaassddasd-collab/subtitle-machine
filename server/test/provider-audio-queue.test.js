const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ProviderAudioQueue, PROVIDER_QUEUE_SETTINGS: S} = require('../src/provider-audio-queue');
function fixture() {
  let now = 0, bytes = 0;
  const sent = [], failures = [], reports = [];
  const q = new ProviderAudioQueue({now: () => now, bufferedBytes: () => bytes,
    submit: p => sent.push(p.id), fail: reason => failures.push(reason),
    report: (reason, data) => reports.push({reason, ...data}),
    timers: {setInterval: () => 1, clearInterval() {}}});
  return {q, sent, failures, reports, clock: t => {now = t}, buffer: n => {bytes = n},
    add: id => q.enqueue({id, durationMs: 80, sourceStartMs: id * 80, sourceEndMs: (id + 1) * 80, packetSequence: id + 1})};
}
test('normal audio is immediate, provider pressure queues without stopping capture, and recovery preserves order', () => {
  const f = fixture(); f.add(0); assert.deepEqual(f.sent, [0]);
  f.buffer(S.highWaterBytes + 1000);
  for (let i = 1; i <= 50; i++) f.add(i);
  f.clock(5000); f.q.drain(); assert.deepEqual(f.sent, [0]); assert.deepEqual(f.failures, []);
  f.buffer(0);
  for (let t = 5020; t <= 10000; t += 20) {f.clock(t); f.q.drain();}
  assert.deepEqual(f.sent, Array.from({length: 51}, (_, i) => i));
  assert.equal(f.q.queuedMs, 0); assert.deepEqual(f.failures, []);
  assert.ok(f.reports.some(e => e.reason === 'provider_queue_drained'));
  f.q.close();
});
test('recovered backlog is paced instead of flushed as one burst', () => {
  const f = fixture(); f.buffer(S.highWaterBytes);
  for (let i = 0; i < 100; i++) f.add(i);
  f.buffer(0); f.clock(1000); f.q.drain();
  for (let i = 0; i < 100; i++) f.q.drain();
  assert.equal(f.sent.length, 1);
  f.clock(1060); f.q.drain(); assert.equal(f.sent.length, 1);
  f.clock(1080); f.q.drain(); assert.equal(f.sent.length, 2);
  f.q.close();
});
test('permanent provider stalls fail once and discard bounded queued data with source diagnostics', () => {
  const f = fixture(); f.buffer(S.highWaterBytes); f.add(0); f.add(1);
  f.clock(S.stallMs); f.q.drain(); f.q.drain();
  assert.deepEqual(f.failures, ['provider_queue_stalled']);
  assert.equal(f.q.queuedMs, 0); assert.deepEqual(f.sent, []);
  assert.ok(f.reports.some(e => e.reason === 'provider_queue_abandoned' && e.sourceEndMs === 160));
});
test('queue capacity and stream closure prevent unbounded storage or stale submissions', () => {
  const f = fixture(); f.buffer(S.highWaterBytes);
  for (let i = 0; i < 200; i++) f.add(i);
  assert.deepEqual(f.failures, ['provider_queue_full']);
  assert.equal(f.q.queuedMs, 0);
  f.buffer(0); f.clock(10000); f.q.drain(); assert.equal(f.add(300), false);
  assert.deepEqual(f.sent, []);
});

test('continuous live audio survives a five-second provider pause and catches up with bounded buffers', () => {
  let now = 0, bytes = 0, produced = 0, submitted = 0, maxQueue = 0, maxBytes = 0;
  const failures = [];
  const q = new ProviderAudioQueue({now: () => now, bufferedBytes: () => bytes,
    submit: p => {submitted += p.durationMs; bytes += p.durationMs * 48;}, fail: r => failures.push(r),
    timers: {setInterval: () => 1, clearInterval() {}}});
  for (now = 0; now < 60000; now += 20) {
    if (now < 1000 || now >= 6000) bytes = Math.max(0, bytes - 20 * 48 * 1.5);
    if (now % 40 === 0) {produced += 40; q.enqueue({durationMs: 40});}
    q.drain(); maxQueue = Math.max(maxQueue, q.queuedMs); maxBytes = Math.max(maxBytes, bytes);
  }
  assert.deepEqual(failures, []);
  assert.equal(submitted, produced);
  assert.equal(q.queuedMs, 0);
  assert.ok(maxQueue > 3000 && maxQueue <= S.maximumQueuedMs);
  assert.ok(maxBytes <= S.highWaterBytes + 40 * 48);
  q.close();
});
