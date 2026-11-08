import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

test('audio batches go directly to the worker port with the original sample clock, without UI messages', () => {
  let Processor
  const sent = [], ui = [], context = vm.createContext({sampleRate: 48000, currentFrame: 0,
    AudioWorkletProcessor: class {constructor() {this.port = {postMessage: value => ui.push(value)}}},
    registerProcessor: (_name, value) => {Processor = value}})
  vm.runInContext(fs.readFileSync(new URL('../src/worklets/mic-capture-processor.js', import.meta.url), 'utf8'), context)
  const processor = new Processor(), port = {postMessage: value => sent.push(value), close() {}}
  processor.port.onmessage({data: {type: 'connect', port}})
  for (let i = 0; i < 750; i++) {context.currentFrame = i * 128; processor.process([[new Float32Array(128)]])}
  assert.equal(sent.length, 50); assert.equal(ui.length, 0)
  assert.equal(sent[0].endTime, .04); assert.equal(sent.at(-1).endTime, 2)
  processor.port.onmessage({data: {type: 'disconnect'}})
  for (let i = 750; i < 1500; i++) {context.currentFrame = i * 128; processor.process([[new Float32Array(128)]])}
  assert.equal(sent.length, 50)
})
