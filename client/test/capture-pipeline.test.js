import {test} from 'node:test'
import assert from 'node:assert/strict'
import {setImmediate} from 'node:timers'
import {CapturePipeline, PcmResampler, PIPELINE_SETTINGS as S} from '../src/lib/capture-pipeline.js'
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture({receipt = true, dropped = false, receiptDelay = 0, probeProgress = true} = {}) {
  let now = 0, network = true, provider = true
  const sockets = [], events = [], stats = {frames: 0, starts: 0, stops: 0, probes: 0}
  const timers = {setInterval: () => 1, clearInterval() {}}
  const callbacks = []
  const later = fn => receiptDelay ? callbacks.push({at: now + receiptDelay, fn}) : fn()
  const clock = ms => {
    now = ms
    while (callbacks[0]?.at <= now) callbacks.shift().fn()
  }
  const createSocket = () => {
    const handlers = new Map()
    const socket = {connected: false, io: {engine: {writeBuffer: [], transport: {name: 'websocket', ws: {bufferedAmount: 0}}}},
      on(name, fn) {if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn)},
      off(name, fn) {handlers.get(name)?.delete(fn)},
      server(name, value) {for (const fn of handlers.get(name) || []) fn(value)},
      connect() {if (network) {this.connected = true; this.server('connect')} else this.server('connect_error', new Error('offline'))},
      disconnect() {this.connected = false; this.server('disconnect')}, timeout() {return this},
      emit(name, data, ack) {
        if (name === 'transcription:start') {stats.starts++; this.captureId = data.clientInfo.captureId; this.received = 0; this.audioMs = 0; ack(null, {ok: true})}
        if (name === 'transcription:stop') stats.stops++
        if (name === 'transcription:audio-pcm') {
          stats.frames++; stats.last = data; this.received = data.sequence; this.audioMs += data.durationMs
          stats.droppedInputMs = (stats.droppedInputMs || 0) + (data.droppedInputMs || 0)
          const response = {captureId: data.captureId, sequence: data.sequence,
            ok: provider, dropped, serverAudioMs: this.audioMs, networkAgeMs: 0, reason: provider ? '' : 'provider_backpressure'}
          if (receipt) later(() => this.server('transcription:audio-ack', response))
        }
        if (name === 'transcription:capture-probe') {
          stats.probes++
          const response = {ok: true, captureId: this.captureId, sequence: probeProgress ? this.received : 0, serverAudioMs: probeProgress ? this.audioMs : 0}
          later(() => ack(null, response))
        }
      }}
    sockets.push(socket); return socket
  }
  const pipeline = new CapturePipeline({createSocket, now: () => now, timers,
    notify: event => {events.push(event); if (events.length > 100) events.shift()}})
  pipeline.start({origin: 'http://local', sourceId: 'microphone', inputRate: 24000, clock: {wallTime: 0, contextTime: 0},
    request: {sessionId: 'session', autoFollow: true}, clientInfo: {captureOwnerId: 'owner', captureGeneration: 100}})
  const samples = new Float32Array(960).fill(.1)
  return {pipeline, events, stats, sockets, frame(ms) {clock(ms); pipeline.receive({samples, endTime: ms / 1000})},
    clock, network(value) {network = value}, provider(value) {provider = value}}
}

test('three hours of source frames stay in one provider epoch with bounded memory and an exact PCM clock', async () => {
  const f = fixture(); await flush()
  for (let i = 1; i <= 270000; i++) {f.frame(i * 40); if (i % 25 === 0) f.pipeline.tick()}
  assert.equal(f.stats.frames, 270000); assert.equal(f.stats.last.sourceEndMs, 10800000)
  assert.equal(f.stats.last.sequence, 270000); assert.equal(f.sockets[0].audioMs, 10800000)
  assert.equal(f.stats.starts, 1); assert.equal(f.sockets.length, 1)
  assert.equal(f.pipeline.queue.length, 0); assert.ok(f.pipeline.transport.pending.size < 3)
  f.pipeline.stop()
})

test('receipts lost for more than four seconds are confirmed by a separate progress probe without restarting', async () => {
  const f = fixture({receipt: false}); await flush()
  for (let i = 1; i <= 300; i++) {f.frame(i * 40); f.pipeline.tick()}
  assert.equal(f.stats.frames, 300); assert.ok(f.stats.probes > 0)
  assert.equal(f.stats.starts, 1); assert.equal(f.sockets.length, 1)
  assert.ok(f.pipeline.transport.pending.size <= 101); f.pipeline.stop()
})

test('discard receipts lasting beyond five seconds never trigger a stale-input reconnect loop', async () => {
  const f = fixture({dropped: true}); await flush()
  for (let i = 1; i <= 500; i++) {f.frame(i * 40); f.pipeline.tick()}
  assert.equal(f.stats.starts, 1); assert.equal(f.sockets.length, 1)
  assert.equal(f.pipeline.desired, true); assert.equal(f.stats.frames, 500)
  f.pipeline.stop()
})

test('a provider failure changes only the provider epoch on the existing audio transport', async () => {
  const f = fixture(); await flush(); f.frame(40)
  const oldId = f.pipeline.captureId
  f.provider(false); f.frame(80)
  assert.equal(f.pipeline.ready, false); assert.equal(f.pipeline.desired, true)
  for (let i = 3; i <= 30; i++) f.frame(i * 40)
  assert.ok(f.pipeline.queuedMs <= S.maximumQueuedMs)
  f.provider(true); f.pipeline.tick(); await flush(); f.frame(1240)
  assert.notEqual(f.pipeline.captureId, oldId); assert.equal(f.stats.starts, 2)
  assert.equal(f.sockets.length, 1); assert.equal(f.stats.last.sourceId, 'microphone')
  assert.equal(f.stats.last.sourceEndMs, 1240); assert.equal(f.stats.last.sequence, 29)
  assert.equal(f.sockets[0].audioMs, 1160, 'the bounded provider outage queue is retained without a second crop')
  f.pipeline.stop()
})

test('network failures keep consuming source audio and bounded retries resume after more than three failures', async () => {
  const f = fixture(); await flush(); f.frame(40); f.network(false); f.sockets[0].disconnect()
  for (let round = 1; round <= 8; round++) {
    const at = round * 15000
    f.frame(at); f.pipeline.tick(); await flush()
    assert.equal(f.pipeline.desired, true); assert.ok(f.pipeline.queuedMs <= S.maximumQueuedMs)
  }
  f.network(true); f.frame(150000); f.pipeline.tick(); await flush(); f.frame(150040)
  assert.equal(f.pipeline.firstReceipt, true); assert.equal(f.stats.last.sourceEndMs, 150040)
  assert.equal(f.pipeline.queue.length, 0); f.pipeline.stop()
  const starts = f.stats.starts; f.clock(999999); f.pipeline.tick(); assert.equal(f.stats.starts, starts)
})

test('only source batches beyond retention are dropped without rebuilding capture or connections', async () => {
  const f = fixture(); await flush(); f.frame(40)
  f.clock(S.maximumAgeMs + 2000); f.pipeline.receive({samples: new Float32Array(960), endTime: .08})
  assert.equal(f.stats.frames, 1); assert.equal(f.stats.starts, 1)
  f.frame(S.maximumAgeMs + 2040)
  assert.equal(f.stats.frames, 2); assert.ok(f.stats.last.droppedInputMs >= 40)
  assert.equal(f.stats.last.sourceEndMs, S.maximumAgeMs + 2040); f.pipeline.stop()
})

test('44.1 kHz conversion preserves fractional sample counts and nonzero samples across batch boundaries', () => {
  const r = new PcmResampler(44100), input = new Float32Array(128).fill(.25)
  let output = 0
  for (let i = 0; i < 10000; i++) {
    const pcm = r.convert(input); output += pcm.length
    assert.ok(pcm.every(value => value === 8192))
  }
  assert.equal(output, Math.round(1280000 * 24000 / 44100))
})

test('worklet posting time keeps fresh samples usable after sample-clock drift or suspension', async () => {
  const f = fixture(); await flush(); f.frame(40)
  f.clock(10800000)
  f.pipeline.receive({samples: new Float32Array(960), endTime: 10000, postedAt: 10800000})
  assert.equal(f.stats.frames, 2); assert.equal(f.stats.last.captureAgeMs, 0)
  f.clock(10800000 + S.maximumAgeMs + 2000)
  f.pipeline.receive({samples: new Float32Array(960), endTime: 10000.04, postedAt: 10800040})
  assert.equal(f.stats.frames, 2, 'old queued worklet messages must remain stale')
  f.pipeline.stop()
})

test('three-second receipts preserve every sample instead of shredding speech at the upload-credit boundary', async () => {
  const f = fixture({receiptDelay: 3000}); await flush()
  for (let i = 1; i <= 1500; i++) {f.frame(i * 40); if (i % 3 === 0) f.pipeline.tick()}
  assert.equal(f.stats.frames, 1500)
  assert.equal(f.sockets[0].audioMs, 60000)
  assert.equal(f.pipeline.droppedMs || 0, 0)
  assert.equal(f.stats.starts, 1)
  assert.ok(f.stats.probes < 40, 'one probe at a time; no overlapping probe storm')
  f.pipeline.stop()
})

test('a six-second receipt outage queues continuous PCM and catches up without a source gap', async () => {
  const f = fixture({receipt: false}); await flush()
  for (let i = 1; i <= 150; i++) f.frame(i * 40)
  assert.equal(f.pipeline.droppedMs || 0, 0)
  assert.ok(f.pipeline.queuedMs > 0)
  const socket = f.sockets[0]
  for (let i = 0; i < 4 && f.pipeline.queuedMs; i++) {
    socket.server('transcription:audio-ack', {ok: true, captureId: f.pipeline.captureId, sequence: socket.received})
    f.pipeline.drain()
  }
  assert.equal(f.stats.frames, 150)
  assert.equal(socket.audioMs, 6000)
  assert.equal(f.pipeline.queuedMs, 0)
  assert.equal(f.pipeline.droppedMs || 0, 0)
  f.pipeline.stop()
})

test('receipt delay recovery produces a running state after the first receipt, not a permanently sticky warning', async () => {
  const f = fixture({receipt: false}); await flush(); f.frame(40)
  f.sockets[0].server('transcription:audio-ack', {ok: true, captureId: f.pipeline.captureId, sequence: 1})
  f.frame(80); f.clock(2000); f.pipeline.tick()
  assert.ok(f.events.some(e => e.reason === 'capture_transport_delayed'))
  f.sockets[0].server('transcription:audio-ack', {ok: true, captureId: f.pipeline.captureId, sequence: 2, networkAgeMs: 1800})
  f.frame(2040); f.clock(2050)
  f.sockets[0].server('transcription:audio-ack', {ok: true, captureId: f.pipeline.captureId, sequence: 3, networkAgeMs: 0})
  assert.equal(f.events.at(-1).type, 'state')
  assert.equal(f.events.at(-1).status, 'running')
  f.pipeline.stop()
})

test('a sustained outage overflows in bounded blocks and the next second of speech remains continuous', async () => {
  const f = fixture({receipt: false}); await flush()
  for (let i = 1; i <= 1000; i++) {
    f.frame(i * 40)
    assert.ok(f.pipeline.queuedMs <= S.maximumQueuedMs)
    assert.ok(f.pipeline.transport.details().outstandingAudioMs <= 4000)
  }
  assert.ok(f.pipeline.droppedMs > 0)
  const socket = f.sockets[0]
  for (let i = 0; i < 4 && f.pipeline.queuedMs; i++) {
    socket.server('transcription:audio-ack', {ok: true, captureId: f.pipeline.captureId, sequence: socket.received})
    f.pipeline.drain()
  }
  assert.equal(f.stats.last.sourceEndMs, 40000)
  assert.equal(socket.audioMs + f.stats.droppedInputMs, 40000)
  assert.equal(f.pipeline.droppedMs, 0)
  const previous = f.stats.last.sourceEndMs
  socket.server('transcription:audio-ack', {ok: true, captureId: f.pipeline.captureId, sequence: socket.received})
  f.frame(40040)
  assert.equal(f.stats.last.sourceStartMs, previous)
  assert.equal(f.stats.last.droppedInputMs, 0)
  f.pipeline.stop()
})


for (const receiptDelay of [5000, 10000, 11000]) test(`sustained ${receiptDelay} ms receipts catch up without reconnecting or losing audio`, async () => {
  const f = fixture({receiptDelay}); await flush()
  for (let i = 1; i <= 2000; i++) {f.frame(i * 40); f.pipeline.tick(); await flush()}
  // Stop producing while delayed receipts drain the last packets.
  for (let i = 1; i <= 15; i++) {f.clock(80000 + i * 1000); f.pipeline.tick(); await flush()}
  assert.equal(f.stats.starts, 1)
  assert.equal(f.sockets.length, 1)
  assert.equal(f.pipeline.droppedAudioMs, 0)
  assert.equal(f.sockets[0].audioMs, 80000)
  assert.equal(f.pipeline.queuedMs, 0)
  assert.ok(f.pipeline.transport.uploadWindowMs <= 12000)
  assert.equal(f.pipeline.desired, true)
  f.pipeline.stop()
})

test('drop ranges and recovery snapshots retain the source timeline and cumulative progress', async () => {
  const f = fixture(); await flush()
  f.frame(40); f.frame(80)
  f.pipeline.ready = false
  f.frame(120); f.frame(160)
  f.pipeline.trimQueue(40, 'reconnect_trim')
  const drop = f.events.find(e => e.reason === 'capture_drop_range')
  assert.equal(drop.cause, 'reconnect_trim')
  assert.equal(drop.sourceStartMs, 80)
  assert.equal(drop.sourceEndMs, 120)
  assert.equal(drop.droppedInputMs, 40)
  f.pipeline.ready = true
  f.clock(6000); f.pipeline.tick()
  assert.ok(f.events.some(e => e.reason === 'capture_recovery_after' && e.recoveryElapsedMs === 5000))
  f.clock(11000); f.pipeline.tick()
  assert.ok(f.events.some(e => e.reason === 'capture_recovery_after' && e.recoveryElapsedMs === 10000))
  assert.ok(f.events.some(e => e.reason === 'capture_progress' && e.generatedAudioMs === 160))
  f.pipeline.stop()
})

test('successful probes with no advancing receipt do not hide a stalled upload', async () => {
  const f = fixture({receipt: false, probeProgress: false}); await flush()
  for (let i = 1; i <= 550; i++) {f.frame(i * 40); f.pipeline.tick(); await flush()}
  assert.ok(f.events.some(e => e.reason === 'capture_reception_stalled'))
  assert.ok(f.stats.starts > 1)
  assert.equal(f.pipeline.desired, true)
  f.pipeline.stop()
})

test('a brief real disconnection retains all queued speech through transport replacement', async () => {
  const f = fixture(); await flush(); f.frame(40)
  f.network(false); f.sockets[0].disconnect()
  for (let i = 2; i <= 100; i++) {
    if (i === 25) f.network(true)
    f.frame(i * 40); f.pipeline.tick(); await flush()
  }
  assert.equal(f.stats.starts, 2)
  assert.equal(f.pipeline.droppedAudioMs, 0)
  assert.equal(f.pipeline.queuedMs, 0)
  assert.equal(f.sockets.reduce((sum, socket) => sum + (socket.audioMs || 0), 0), 4000)
  f.pipeline.stop()
})
