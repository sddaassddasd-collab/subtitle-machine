import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {CaptureTransport, CAPTURE_TRANSPORT_LIMITS as L, connectCaptureSocket, captureStage} from '../src/lib/capture-transport.js'

function fixture() {
  let now = 0
  const sent = [], blocked = [], reports = [], acknowledgements = [], listeners = new EventEmitter()
  const socket = {connected: true, io: {engine: {writeBuffer: [], transport: {name: 'websocket', ws: {bufferedAmount: 0}}}},
    on: (...args) => listeners.on(...args), off: (...args) => listeners.off(...args),
    emit(name, packet) {sent.push({name, packet})}}
  const transport = new CaptureTransport(socket, {now: () => now, onBlocked: x => blocked.push(x),
    onReport: x => reports.push(x), onAck: x => acknowledgements.push(x)})
  const send = i => transport.send({captureId: 'capture', sequence: i, durationMs: 40, pcm: new ArrayBuffer(1920)})
  const ack = (sequence, extra) => listeners.emit('transcription:audio-ack', {captureId: 'capture', sequence, ok: true, ...extra})
  return {transport, socket, sent, blocked, reports, acknowledgements, send, ack, clock: value => {now = value}}
}

test('binary audio uses cumulative ACKs and remains bounded through forty minutes of capture', () => {
  const f = fixture()
  for (let i = 1; i <= 60000; i++) {
    f.clock(i * 40); assert.equal(f.send(i), true)
    if (i % 3 === 0) {f.clock(i * 40 + 10); f.ack(i); f.sent.length = 0}
  }
  assert.equal(f.transport.sentPackets, 60000); assert.equal(f.blocked.length, 0)
  assert.equal(f.transport.details().inFlightAudioMs, 0)
  assert.equal(f.transport.details().rttMs, 10)
  assert.equal(f.acknowledgements.length, 20000)
  assert.ok(f.reports.some(x => x.reason === 'capture_transport' && x.transportType === 'websocket'))
})

test('missing receipts pause only upload credit and keep the source intent alive with bounded end-to-end audio', () => {
  const f = fixture()
  let next = 1
  for (let i = 1; i <= 1000; i++) {f.clock(i * 40); if (f.send(next)) next++}
  assert.equal(f.sent.length, L.maximumOutstandingAudioMs / 40)
  assert.deepEqual(f.blocked, [])
  assert.equal(f.transport.details().outstandingAudioMs, L.maximumOutstandingAudioMs)
  assert.ok(f.transport.creditEnds.size <= L.maximumOutstandingAudioMs / 40)
  assert.ok(f.transport.expiredReceipts > 0)
  f.ack(next - 1)
  assert.equal(f.transport.details().outstandingAudioMs, 0)
  assert.equal(f.send(next), true)
  assert.ok(f.reports.some(e => e.reason === 'capture_flow_control'))
  assert.ok(f.reports.some(e => e.reason === 'capture_flow_resumed'))
})

test('delayed receipts release credit without replacing the connection or allowing unlimited upload', () => {
  const f = fixture(), queue = []
  let next = 1
  for (let i = 1; i <= 400; i++) {
    const now = i * 40; f.clock(now)
    while (queue[0]?.due <= now) f.ack(queue.shift().sequence, {networkAgeMs: 0})
    if (f.send(next)) {queue.push({sequence: next, due: now + 1300}); next++}
    assert.ok(f.transport.details().outstandingAudioMs <= L.maximumOutstandingAudioMs)
  }
  assert.deepEqual(f.blocked, [])
  assert.ok(f.transport.sentPackets > 300)
  assert.ok(f.reports.some(e => e.reason === 'capture_transport_delayed'))
})

test('provider connection setup time alone does not report audio transport delay', () => {
  const f = fixture(); f.clock(7000); f.send(1)
  assert.equal(f.reports.some(e => e.reason === 'capture_transport_delayed'), false)
  f.clock(7100); f.ack(1, {networkAgeMs: 0})
  assert.equal(f.reports.some(e => e.reason === 'capture_transport_delayed'), false)
})

test('old network measurements expire and fresh PCM receipts clear the delay indication', () => {
  const f = fixture(); f.send(1); f.clock(2000); f.ack(1, {networkAgeMs: 5000})
  assert.equal(f.transport.delayed, true)
  f.clock(7000); f.transport.check()
  assert.equal(f.transport.delayed, false)
  f.send(2); f.clock(7010); f.ack(2, {networkAgeMs: 0})
  assert.equal(f.transport.delayed, false)
})

test('real sender congestion drops unsent frames, then replaces only a persistently blocked transport', () => {
  for (const backlog of [f => {f.socket.io.engine.transport.ws.bufferedAmount = L.maximumBufferedBytes + 1},
    f => {f.socket.io.engine.writeBuffer = [{data: 'x'.repeat(L.maximumBufferedBytes + 1)}]},
    f => {f.socket.io.engine.writeBuffer = Array.from({length: 65}, () => ({data: ''}))}]) {
    const f = fixture(); backlog(f)
    assert.equal(f.send(1), false); assert.equal(f.sent.length, 0)
    assert.deepEqual(f.blocked, [])
    f.clock(L.congestionMs + 1); assert.equal(f.send(2), false)
    assert.deepEqual(f.blocked, ['capture_transport_backlog'])
    f.ack(1); assert.equal(f.send(3), false)
  }
  const recovered = fixture()
  recovered.socket.io.engine.transport.ws.bufferedAmount = L.maximumBufferedBytes + 1
  assert.equal(recovered.send(1), false)
  recovered.clock(300); recovered.socket.io.engine.transport.ws.bufferedAmount = 0
  assert.equal(recovered.send(2), true); assert.deepEqual(recovered.blocked, [])
  const offline = fixture(); offline.socket.connected = false
  assert.equal(offline.send(1), false); assert.deepEqual(offline.blocked, ['capture_transport_disconnected'])
})

test('cumulative receipts cannot cross captures, invent sequences or release newer unreceived audio', () => {
  const f = fixture(); f.send(1); f.send(2); f.send(3)
  f.ack(3, {captureId: 'previous'}); f.ack(100)
  assert.equal(f.transport.details().inFlightPackets, 3)
  f.ack(2); assert.equal(f.transport.details().inFlightPackets, 1)
  assert.equal(f.transport.details().inFlightAudioMs, 40)
  f.transport.close(); f.ack(3)
  assert.equal(f.acknowledgements.length, 1); assert.equal(f.send(4), false)
})

test('a fresh audio connection never disconnects the control connection', async () => {
  const audio = new EventEmitter(), order = []
  audio.connected = false
  audio.connect = () => {order.push('audio connect'); audio.connected = true; audio.emit('connect')}
  assert.equal(await connectCaptureSocket(audio), true)
  assert.deepEqual(order, ['audio connect'])
  assert.equal(audio.listenerCount('connect'), 0); assert.equal(audio.listenerCount('connect_error'), 0)
  audio.connected = false
  assert.equal(await connectCaptureSocket(audio, () => true), false)
  audio.connect = () => audio.emit('connect_error', new Error('offline'))
  await assert.rejects(connectCaptureSocket(audio), /offline/)
  assert.equal(audio.listenerCount('connect_error'), 0)
})

test('a hung setup stage terminates and reports its exact phase', async () => {
  const reports = []
  await assert.rejects(captureStage(new Promise(() => {}), 'permission', 10, e => reports.push(e)), /permission/)
  assert.deepEqual(reports.map(e => e.status), ['started', 'failed'])
})

test('packet timing joins source and server clocks with signed offset and explicit uncertainty', () => {
  const f = fixture()
  f.clock(1000)
  f.transport.send({captureId: 'capture', sequence: 1, durationMs: 40, pcm: new ArrayBuffer(1920),
    capturedAt: 800, queuedAt: 900, sourceStartMs: 0, sourceEndMs: 40})
  f.clock(1200)
  f.ack(1, {serverReceivedAt: 600, acknowledgedAt: 620, providerSubmittedAt: 610,
    streamId: 'asr', receivedAudioMs: 40, providerSubmittedAudioMs: 40, recognizedAudioMs: 0})
  const chain = f.reports.find(r => r.reason === 'capture_packet_timing')
  assert.equal(chain.generatedAt, 800)
  assert.equal(chain.sentAt, 1000)
  assert.equal(chain.queueWaitMs, 100)
  assert.equal(chain.clockOffsetMs, -490)
  assert.equal(chain.clockUncertaintyMs, 90)
  assert.equal(chain.streamId, 'asr')
  assert.equal(chain.recognizedAudioMs, 0)
})
