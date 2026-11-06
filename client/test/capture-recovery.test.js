import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {CaptureRecovery, captureAgeMs} from '../src/lib/capture-recovery.js'

test('queued worklet batches retain their original sample clock, including partial render frames', () => {
  let Processor
  const sent = [], context = vm.createContext({sampleRate: 48000, currentFrame: 0,
    AudioWorkletProcessor: class {constructor() {this.port = {postMessage: value => sent.push(value)}}},
    registerProcessor: (_name, value) => {Processor = value}})
  vm.runInContext(fs.readFileSync(new URL('../src/worklets/mic-capture-processor.js', import.meta.url), 'utf8'), context)
  const processor = new Processor()
  for (let i = 0; i < 750; i++) { context.currentFrame = i * 128; processor.process([[new Float32Array(128)]]) }
  assert.equal(sent.length, 100)
  assert.equal(sent[0].endTime, .02)
  assert.equal(sent.at(-1).endTime, 2)
  assert.ok(captureAgeMs(2, sent[0].endTime) > 1900, 'UI receipt time cannot make old samples fresh')
})
test('recovery waits for connectivity, coalesces failures and stops after three retries', () => {
  const r = new CaptureRecovery(); r.arm({autoFollow: true})
  let now = 1000
  for (let i = 1; i <= 3; i++) {
    assert.equal(r.request('capture_backlog', now), true)
    assert.equal(r.request('duplicate', now), false)
    assert.equal(r.take(false, now + 10000), null)
    const attempt = r.take(true, now + 10000)
    assert.equal(attempt.recovery.attempt, i); assert.equal(attempt.autoFollow, true)
    assert.equal(r.take(true, now + 20000), null)
    r.complete(attempt.generation, true, now + 10000); now += 11000
  }
  assert.equal(r.request('capture_backlog', now), false)
  assert.equal(r.exhausted, true)
})
test('manual stop invalidates both scheduled and in-flight retries; stable capture replenishes the retry budget', () => {
  const r = new CaptureRecovery(); r.arm({autoFollow: true}); r.request('disconnect', 1000)
  const attempt = r.take(true, 2000)
  r.cancel(); r.complete(attempt.generation, false, 3000)
  assert.equal(r.take(true, 10000), null)
  r.arm({autoFollow: true}); r.request('disconnect', 1000)
  r.complete(r.take(true, 2000).generation, true, 2000)
  r.request('disconnect', 40000)
  assert.equal(r.take(true, 41000).recovery.attempt, 1)
})
test('an error received before a restart completes is retried and each recovery stage is observable', () => {
  const r = new CaptureRecovery(), events = []; r.report = e => events.push(e)
  r.arm({autoFollow: true}); r.request('disconnect', 1000)
  const attempt = r.take(true, 2000)
  r.request('provider_backpressure', 2100)
  r.complete(attempt.generation, true, 2200)
  assert.equal(r.pending, true)
  assert.equal(r.reason, 'provider_backpressure')
  assert.equal(r.take(true, 4000).recovery.attempt, 2)
  r.cancel('manual_stop')
  assert.ok(events.some(e => e.reason === 'recovery_scheduled'))
  assert.ok(events.some(e => e.reason === 'recovery_attempt'))
  assert.equal(events.at(-1).cause, 'manual_stop')
})
test('a hung setup expires and its late promise cannot finish the replacement attempt', () => {
  const r = new CaptureRecovery(); r.arm({autoFollow: true}); r.request('disconnect', 1000)
  const first = r.take(true, 2000)
  assert.equal(r.expire(13000), false)
  assert.equal(r.expire(14000), true)
  const second = r.take(true, 16000)
  assert.equal(second.recovery.attempt, 2)
  r.complete(first.generation, false, 17000)
  assert.equal(r.inFlight, true)
  r.complete(second.generation, true, 18000)
  assert.equal(r.inFlight, false)
})
test('a stable-period budget reset applies once and subsequent failed attempts stay bounded', () => {
  const r = new CaptureRecovery(); r.arm({autoFollow: true}); r.request('first', 1000)
  r.complete(r.take(true, 2000).generation, true, 2000)
  r.request('later', 40000)
  for (const now of [41000, 43000, 46000]) {
    const attempt = r.take(true, now)
    assert.ok(attempt); r.complete(attempt.generation, false, now)
  }
  assert.equal(r.exhausted, true)
})
