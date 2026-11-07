import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {CaptureTransport, CAPTURE_TRANSPORT_LIMITS as L, reconnectCaptureSocket, needsCaptureConnectionReset} from '../src/lib/capture-transport.js'

function fixture() {
  let now = 0
  const sent = [], blocked = [], reports = [], acknowledgements = []
  const socket = {connected: true, io: {engine: {writeBuffer: [], transport: {name: 'websocket', ws: {bufferedAmount: 0}}}},
    emit(name, packet, ack) {sent.push({name, packet, ack})}}
  const transport = new CaptureTransport(socket, {now: () => now, onBlocked: x => blocked.push(x),
    onReport: x => reports.push(x), onAck: x => acknowledgements.push(x)})
  const send = i => transport.send({sequence: i, durationMs: 20, audio: 'pcm'})
  return {transport, socket, sent, blocked, reports, acknowledgements, send, clock: value => {now = value}}
}

test('healthy 50 Hz audio is forwarded immediately with bounded ACK accounting and transport telemetry', () => {
  const f = fixture()
  for (let i = 0; i < 500; i++) {
    f.clock(i * 20); assert.equal(f.send(i), true)
    f.clock(i * 20 + 10); f.sent.at(-1).ack({ok: true})
  }
  assert.equal(f.sent.length, 500); assert.equal(f.blocked.length, 0)
  assert.equal(f.transport.details().inFlightAudioMs, 0)
  assert.equal(f.transport.details().rttMs, 10)
  assert.ok(f.reports.some(x => x.reason === 'capture_transport' && x.transportType === 'websocket'))
})

test('the reported slow delivery cannot accumulate 9 seconds of reliable audio emits', () => {
  const f = fixture()
  for (let i = 0; i < 500; i++) {f.clock(i * 20); f.send(i)}
  assert.equal(f.sent.length, L.maximumInFlightMs / 20)
  assert.deepEqual(f.blocked, ['capture_transport_backlog'])
  assert.equal(f.transport.details().inFlightAudioMs, L.maximumInFlightMs)
  assert.equal(f.reports.at(-1).reason, 'capture_transport_blocked')
  assert.equal(f.transport.blocked, true, 'late ACKs cannot restart the old audio clock')
  f.sent[0].ack({ok: true}); assert.equal(f.send(501), false)
})

test('native WebSocket queues, Engine.IO queues, polling queues and ACK silence all trigger recovery before more PCM is enqueued', () => {
  for (const backlog of [f => {f.socket.io.engine.transport.ws.bufferedAmount = L.maximumBufferedBytes + 1},
    f => {f.socket.io.engine.writeBuffer = [{data: 'x'.repeat(L.maximumBufferedBytes + 1)}]},
    f => {f.socket.io.engine.transport.ws.bufferedAmount = L.maximumBufferedBytes - 1},
    f => {f.socket.io.engine.transport.name = 'polling'; f.socket.io.engine.writeBuffer = Array.from({length: 65}, () => ({data: ''}))}]) {
    const f = fixture(); backlog(f)
    assert.equal(f.send(1), false); assert.equal(f.sent.length, 0)
    assert.deepEqual(f.blocked, ['capture_transport_backlog'])
  }
  const f = fixture(); f.send(1); f.clock(L.acknowledgementMs)
  assert.equal(f.transport.check(), false); assert.deepEqual(f.blocked, ['capture_transport_timeout'])
  assert.equal(f.reports.at(-1).oldestAckAgeMs, L.acknowledgementMs)
})

test('closing a capture invalidates old acknowledgements and keeps a new capture independent', () => {
  const f = fixture(); f.send(1); f.transport.close(); f.sent[0].ack({ok: true})
  assert.equal(f.acknowledgements.length, 0); assert.equal(f.transport.details().inFlightPackets, 0)
  assert.equal(f.send(2), false)
})

test('blocked recovery replaces the physical transport and retains existing control rejoin listeners', async () => {
  const socket = new EventEmitter(), order = []
  socket.io = {engine: {transport: {close: () => order.push('old transport closed')}}}
  socket.disconnect = () => order.push('disconnect')
  socket.connect = () => {order.push('connect'); socket.emit('connect')}
  socket.on('connect', () => order.push('control rejoin'))
  assert.equal(await reconnectCaptureSocket(socket), true)
  assert.deepEqual(order, ['disconnect', 'old transport closed', 'connect', 'control rejoin'])
  assert.equal(socket.listenerCount('connect'), 1); assert.equal(socket.listenerCount('connect_error'), 0)
})

test('canceled or failed reconnects do not leave extra listeners or start another connection', async () => {
  const socket = new EventEmitter(); let connects = 0
  socket.disconnect = () => {}; socket.connect = () => {connects++; socket.emit('connect_error', new Error('offline'))}
  assert.equal(await reconnectCaptureSocket(socket, () => true), false); assert.equal(connects, 0)
  await assert.rejects(reconnectCaptureSocket(socket), /offline/)
  assert.equal(socket.listenerCount('connect'), 0); assert.equal(socket.listenerCount('connect_error'), 0)
  assert.equal(needsCaptureConnectionReset('capture_transport_backlog'), true)
  assert.equal(needsCaptureConnectionReset('stale_capture'), true)
  assert.equal(needsCaptureConnectionReset('capture_backlog'), false)
})
