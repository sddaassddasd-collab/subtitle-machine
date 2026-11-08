import {test} from 'node:test'
import assert from 'node:assert/strict'
import {setImmediate} from 'node:timers'
import {CaptureSession} from '../src/lib/capture-session.js'
const flush = () => new Promise(resolve => setImmediate(resolve))
const config = {origin: 'http://local', request: {sessionId: 'show', autoFollow: true}, clientInfo: {captureOwnerId: 'operator'}}

function fixture({waitPermission = false, waitResume = false} = {}) {
  let permissionResolve, resumeResolve
  const counters = {permissions: 0, tracksStopped: 0, contextsClosed: 0, listeners: 0}, workers = [], contexts = []
  const listeners = {addEventListener() {counters.listeners++}, removeEventListener() {counters.listeners--}}
  const track = {readyState: 'live', stop() {this.readyState = 'ended'; counters.tracksStopped++}, getSettings: () => ({sampleRate: 48000}), addEventListener() {}}
  const media = {getTracks: () => [track], getAudioTracks: () => [track]}
  const node = () => ({connect() {}, disconnect() {}, gain: {value: 1}, port: {postMessage() {}}})
  class AudioContext {
    constructor() {this.state = 'running'; this.sampleRate = 48000; this.currentTime = 1; this.audioWorklet = {addModule: async () => {}}; contexts.push(this)}
    resume() {if (waitResume) return new Promise(resolve => {resumeResolve = resolve}); this.state = 'running'; return Promise.resolve()}
    close() {this.state = 'closed'; counters.contextsClosed++; return Promise.resolve()}
    createMediaStreamSource() {return node()} createGain() {return node()}
    addEventListener() {counters.listeners++} removeEventListener() {counters.listeners--}
  }
  const env = {...listeners, document: listeners, AudioContext, AudioWorkletNode: class {constructor() {return node()}},
    MessageChannel: class {constructor() {this.port1 = {}; this.port2 = {}}},
    navigator: {mediaDevices: {getUserMedia() {counters.permissions++; return waitPermission ? new Promise(resolve => {permissionResolve = resolve}) : Promise.resolve(media)}}}}
  const session = new CaptureSession({environment: env, makeId: () => 'source', createWorker: () => {
    const worker = {messages: [], postMessage(value) {this.messages.push(value)}, terminate() {}}
    workers.push(worker); return worker
  }})
  return {session, counters, workers, contexts, allowPermission: () => permissionResolve(media), allowResume: () => resumeResolve()}
}

test('network/provider recovery requests never stop or reacquire the microphone', async () => {
  const f = fixture(); assert.equal(await f.session.start(config), true)
  for (const reason of ['capture_transport_timeout', 'provider_backpressure', 'stale_capture', 'capture_stalled']) f.session.request(reason)
  assert.equal(f.counters.permissions, 1); assert.equal(f.counters.tracksStopped, 0); assert.equal(f.counters.contextsClosed, 0)
  assert.equal(f.workers[0].messages.filter(m => m.type === 'recover').length, 3)
  assert.equal(f.session.desired, true)
  f.session.stop(); assert.equal(f.counters.tracksStopped, 1); assert.equal(f.counters.contextsClosed, 1)
  assert.equal(f.counters.listeners, 0)
})

test('explicit provider reconfiguration reuses the source and fences late events from the old worker', async () => {
  const f = fixture(), events = []; f.session.onEvent = event => events.push(event)
  await f.session.start(config); const context = f.session.audioContext, first = f.workers[0]
  await f.session.start({...config, request: {...config.request, language: 'en'}})
  assert.equal(f.session.audioContext, context); assert.equal(f.counters.permissions, 1)
  assert.equal(f.counters.contextsClosed, 0); assert.equal(f.counters.tracksStopped, 0)
  first.onmessage({data: {type: 'state', status: 'fatal', message: 'obsolete failure'}})
  assert.equal(f.session.desired, true); assert.equal(events.length, 0)
  assert.equal(f.workers.length, 2); assert.equal(first.messages.at(-1).type, 'stop')
  f.workers[1].onmessage({data: {type: 'epoch', captureId: 'new'}})
  assert.equal(f.session.captureId, 'new'); f.session.stop()
})

test('canceling a pending permission request releases only its own eventual media', async () => {
  const f = fixture({waitPermission: true}), started = f.session.start(config)
  await flush(); f.session.cancel(); f.allowPermission()
  assert.equal(await started, false); assert.equal(f.counters.tracksStopped, 1); assert.equal(f.workers.length, 0)
})

test('a late context resume after cancellation cannot publish a source or worker', async () => {
  const f = fixture({waitResume: true}), started = f.session.start(config)
  await flush(); f.session.stop(); f.allowResume()
  assert.equal(await started, false); assert.equal(f.counters.contextsClosed, 1)
  assert.equal(f.counters.tracksStopped, 1); assert.equal(f.workers.length, 0)
})

test('resuming a suspended audio source updates its worker clock without reopening media', async () => {
  const f = fixture(); await f.session.start(config)
  f.contexts[0].state = 'suspended'; f.contexts[0].currentTime = 5
  await f.session.resume()
  const clock = f.workers[0].messages.at(-1)
  assert.equal(clock.type, 'clock'); assert.equal(clock.clock.contextTime, 5)
  assert.equal(f.counters.permissions, 1); assert.equal(f.counters.contextsClosed, 0)
  f.session.stop()
})
