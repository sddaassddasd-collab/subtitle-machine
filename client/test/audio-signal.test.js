import {test} from 'node:test'
import assert from 'node:assert/strict'
import {signalMetrics} from '../src/lib/audio-signal.js'

test('capture metrics distinguish quiet sound from clipping without changing the audio', () => {
  const input = new Float32Array([0, 0.5, -1, 1.2])
  const before = input.slice(), stats = signalMetrics(input)
  assert.ok(stats.peak > 1.19); assert.equal(stats.clippedSamples, 2); assert.equal(stats.samples, 4)
  assert.deepEqual(input, before)
  assert.equal(signalMetrics(new Float32Array(480)).level, 0)
  assert.equal(signalMetrics([]).peak, 0)
})
