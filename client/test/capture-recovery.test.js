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
