import {test} from 'node:test'
import assert from 'node:assert/strict'
import {RecordingPlayback} from '../src/lib/recording-playback.js'

class Context {
  currentTime = 0
  destination = {}
  started = []
  resume() { return Promise.resolve() }
  close() { this.closed = true; return Promise.resolve() }
  createGain() { return {gain: {}, connect() {}, disconnect() {}} }
  createBuffer(channels, length, sampleRate) {
    return {length, sampleRate, channels: [], copyToChannel(data, i) { this.channels[i] = data.slice() }}
  }
  createBufferSource() {
    const context = this
    return {connect() {}, disconnect() {}, stop() { this.stopped = true },
      start(at, offset, duration) { context.started.push({node: this, at, offset, duration}) }}
  }
}
const pcm = (start, end) => ({start, sampleRate: 1000,
  channels: [Float32Array.from({length: Math.round((end - start) * 1000)}, (_, i) => start + i / 1000).buffer]})
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return {promise, resolve} }
async function setup(t, decode = async (start, end) => pcm(start, end)) {
  const context = new Context(), requests = [], states = []
  const decoder = {ready: Promise.resolve({duration: 14400, sampleRate: 1000}),
    decode(start, end) { requests.push([start, end]); return decode(start, end) }, cancel() {}, close() { this.closed = true }}
  const player = new RecordingPlayback({decoderFactory: () => decoder, contextFactory: () => context,
    onUpdate: state => states.push(state)})
  t.after(() => player.dispose())
  await player.open({file: {}})
  return {player, context, requests, states, decoder}
}

test('cue 014 auditions exactly 31.36–33.52, without including decode preroll or waiting for timeupdate', async t => {
  const {player, context, requests} = await setup(t)
  await player.play(31.36, 33.52)
  assert.deepEqual(requests, [[20, 40]])
  const part = context.started[0]
  assert.equal(part.offset, 11.36); assert.equal(part.duration, 2.16)
  assert.ok(Math.abs(part.node.buffer.channels[0][11360] - 31.36) < .00001)
  context.currentTime = part.at + 1
  assert.equal(player.currentTime, 32.36)
  part.node.onended()
  assert.equal(player.currentTime, 33.52); assert.equal(player.playing, false)
})

test('a clip spanning a cache boundary schedules adjacent sample ranges with no duplication or gap', async t => {
  const {player, context} = await setup(t)
  await player.play(19.5, 20.5)
  const [first, second] = context.started
  assert.equal(first.offset, 19.5); assert.equal(first.duration, .5)
  assert.equal(second.offset, 0); assert.equal(second.duration, .5)
  assert.equal(second.at, first.at + first.duration)
  assert.equal(second.node.buffer.channels[0][0], 20)
  context.currentTime = second.at + .25
  assert.equal(player.currentTime, 20.25)
})

test('a late result from an earlier cue cannot replace the final selection', async t => {
  const earlier = deferred()
  const {player, context} = await setup(t, (start, end) => start === 20 ? earlier.promise : Promise.resolve(pcm(start, end)))
  const first = player.play(31.36, 33.52)
  await Promise.resolve()
  await player.play(60, 61)
  earlier.resolve(pcm(20, 40))
  await first
  assert.equal(context.started.length, 1)
  assert.equal(context.started[0].node.buffer.channels[0][0], 60)
  assert.equal(player.currentTime, 60)
})

test('slow decoding freezes the original-file clock and resumes at the next sample instead of skipping sound', async t => {
  const next = deferred()
  const {player, context} = await setup(t, (start, end) => start === 20 ? next.promise : Promise.resolve(pcm(start, end)))
  const playing = player.play(19.5, 20.5)
  // Let the first block be scheduled while the following block is still decoding.
  for (let i = 0; i < 8; i++) await Promise.resolve()
  const first = context.started[0]
  context.currentTime = first.at + 8
  assert.equal(player.currentTime, 20)
  assert.equal(player.snapshot.preparing, true)
  next.resolve(pcm(20, 40)); await playing
  const second = context.started[1]
  assert.ok(second.at > context.currentTime)
  assert.equal(second.offset, 0)
  assert.equal(player.currentTime, 20)
  context.currentTime = second.at + .25
  assert.equal(player.currentTime, 20.25)
})

test('pause during decode cancels playback intent and closing prevents late playback', async t => {
  const pending = deferred()
  const {player, context, decoder} = await setup(t, () => pending.promise)
  const playing = player.play(60, 61)
  await Promise.resolve(); player.pause(); player.dispose()
  pending.resolve(pcm(60, 80)); await playing
  assert.equal(context.started.length, 0)
  assert.equal(player.playing, false); assert.equal(decoder.closed, true)
})

test('seeking into a four-hour recording retains only the bounded cache and exact original-file time', async t => {
  const {player, context, requests} = await setup(t)
  for (const start of [36.254, 60, 298, 600, 10801, 14398]) await player.play(start, start + .5)
  assert.ok(player.cache.size <= 3)
  assert.ok(requests.every(([from, to]) => to - from <= 20))
  assert.equal(player.currentTime, 14398)
  assert.equal(context.started.filter(item => !item.node.stopped).length, 1)
})

test('seeking to EOF stops there; playing after a completed clip continues from its end', async t => {
  const {player, context} = await setup(t)
  await player.play(31.36, 33.52)
  context.started[0].node.onended()
  await player.play()
  assert.equal(player.currentTime, 33.52)
  assert.equal(context.started[1].offset, 13.52)
  await player.seek(player.duration)
  assert.equal(player.currentTime, player.duration)
  assert.equal(player.playing, false)
  assert.equal(await player.play(61, 60), false)
})
