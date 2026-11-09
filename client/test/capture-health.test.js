import {test} from 'node:test'
import assert from 'node:assert/strict'
import {setImmediate} from 'node:timers'
import {CaptureHealthOutbox} from '../src/lib/capture-health.js'
const flush = () => new Promise(resolve => setImmediate(resolve))

test('offline setup failures survive reload and upload with original time and stable IDs', async () => {
  const saved = new Map(), storage = {getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v)}
  let now = 10000, online = false, request, serial = 0
  const fetcher = async (_url, body) => {
    if (!online) throw new Error('offline')
    request = JSON.parse(body.body)
    return {ok: true, json: async () => ({accepted: request.events.map(e => e.eventId)})}
  }
  const box = new CaptureHealthOutbox('session', {storage, fetcher, now: () => now, id: () => `event-${++serial}`})
  box.add({reason: 'capture_setup', stage: 'transport_connect', status: 'failed', captureId: 'new-capture', runId: 'run', audio: 'never-store-this', apiKey: 'secret'})
  await flush(); assert.equal(box.events.length, 1)
  now = 20000; online = true
  const reloaded = new CaptureHealthOutbox('session', {storage, fetcher, now: () => now})
  await reloaded.flush()
  assert.equal(request.events[0].occurredAt, 10000)
  assert.equal(request.events[0].eventId, 'event-1')
  assert.equal(request.events[0].captureId, 'new-capture')
  assert.equal(request.events[0].audio, undefined); assert.equal(request.events[0].apiKey, undefined)
  assert.equal(reloaded.events.length, 0)
  assert.deepEqual(JSON.parse(saved.get(box.key)), [])
})

test('unacknowledged health events stay bounded and do not disappear after a failed request', async () => {
  let serial = 0
  const box = new CaptureHealthOutbox('s', {fetcher: async () => ({ok: false}), id: () => `e-${++serial}`})
  for (let i = 0; i < 300; i++) box.add({reason: 'capture_transport', rttMs: i})
  await flush()
  assert.equal(box.events.length, 256)
  assert.equal(box.events.at(-1).rttMs, 299)
})

test('offline health storage retains packet joins and signed clocks without PCM', async () => {
  const box = new CaptureHealthOutbox('session', {now: () => 1794139146049,
    fetcher: async () => {throw new Error('offline')}, id: () => 'timing-1'})
  box.add({reason: 'capture_packet_timing', streamId: 'asr', sentAt: 1794139146049,
    clockOffsetMs: -1500, clockUncertaintyMs: 40, pcm: 'never'})
  await flush()
  assert.equal(box.events[0].sentAt, 1794139146049)
  assert.equal(box.events[0].clockOffsetMs, -1500)
  assert.equal(box.events[0].streamId, 'asr')
  assert.equal(box.events[0].pcm, undefined)
})

test('disconnect diagnostics retain reason and heartbeat evidence in offline outbox', async () => {
  const box = new CaptureHealthOutbox('session', {now: () => 10000,
    fetcher: async () => {throw new Error('offline')}, id: () => 'disconnect-test'})
  box.add({reason: 'capture_socket_disconnect', disconnectReason: 'ping timeout',
    socketCloseCode: 1006, lastHeartbeatAgeMs: 25000, lastSocketPacketAgeMs: 100,
    rawError: 'do not store arbitrary error details'})
  await flush()
  assert.equal(box.events[0].disconnectReason, 'ping timeout')
  assert.equal(box.events[0].socketCloseCode, 1006)
  assert.equal(box.events[0].lastHeartbeatAgeMs, 25000)
  assert.equal(box.events[0].rawError, undefined)
});
