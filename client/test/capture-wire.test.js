import {test} from 'node:test'
import assert from 'node:assert/strict'
import {encodeAudioPacket, decodeAudioPacket} from '../src/lib/capture-wire.mjs'

test('packed audio round-trips silence, quiet speech-like waves and full-range PCM exactly', () => {
  let random = 17
  for (const count of [1, 63, 64, 65, 960, 1920, 2400]) for (const kind of ['silence', 'constant', 'wave', 'noise']) {
    const pcm = Int16Array.from({length: count}, (_, i) => {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0
      return kind === 'silence' ? 0 : kind === 'constant' ? -1700 : kind === 'wave' ? Math.round(655 * Math.sin(i * Math.PI / 65)) : (random & 65535) - 32768
    })
    const wire = encodeAudioPacket({pcm: pcm.buffer, sequence: 5, capturedAt: 1700000000000,
      sourceEndMs: 12000, captureAgeMs: 42, droppedInputMs: 80}, 12345)
    const result = decodeAudioPacket(wire)
    assert.deepEqual(new Int16Array(result.pcm), pcm)
    assert.equal(result.sequence, 5); assert.equal(result.epoch, 12345)
    assert.equal(result.capturedAt, 1700000000000); assert.equal(result.durationMs, count / 24)
    assert.equal(result.sourceStartMs, 12000 - count / 24)
    assert.ok(wire.byteLength <= pcm.byteLength + 40)
    if (count >= 960 && kind === 'silence') assert.ok(wire.byteLength < pcm.byteLength / 20)
    if (count >= 960 && kind === 'wave') assert.ok(wire.byteLength < pcm.byteLength * .6)
    assert.throws(() => decodeAudioPacket(wire.slice(0, wire.byteLength - 1)))
  }
})

test('invalid packed headers and oversized data are rejected before PCM allocation', () => {
  for (const length of [0, 12, 39, 5000]) assert.throws(() => decodeAudioPacket(new ArrayBuffer(length)))
  const valid = encodeAudioPacket({pcm: new Int16Array(960).buffer, sequence: 1, capturedAt: 1000, sourceEndMs: 40}, 1)
  for (const mutate of [v => v.setUint16(32, 65000, true), v => v.setFloat64(8, NaN, true),
    v => v.setUint8(3, 2), v => v.setUint8(40, 19)]) {
    const copy = valid.slice(0); mutate(new DataView(copy)); assert.throws(() => decodeAudioPacket(copy))
  }
})
