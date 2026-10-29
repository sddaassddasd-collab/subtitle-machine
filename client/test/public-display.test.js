import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PublicDisplayGate, publicViewMode, preventPrompterScroll} from '../src/lib/public-display.js'
import {normalizeDisplayPayload} from '../src/lib/displayPayload.js'

test('ordinary links always default to viewer; only explicit mode selects prompter', () => {
  assert.equal(publicViewMode(''), 'viewer')
  assert.equal(publicViewMode('?mode=other'), 'viewer')
  assert.equal(publicViewMode('?mode=prompter'), 'prompter')
})

test('switching modes accepts the same cue revision but rejects late recovery responses and older cues', () => {
  const gate = new PublicDisplayGate()
  const cue = revision => ({sessionId: 'show', viewerRevision: revision})
  assert.equal(gate.accepts(cue(10)), true)
  assert.equal(gate.accepts(cue(10)), false)
  const oldGeneration = gate.generation
  gate.select('prompter')
  assert.equal(gate.accepts(cue(11), 'viewer', oldGeneration), false)
  assert.equal(gate.accepts(cue(10), 'prompter'), true)
  assert.equal(gate.accepts(cue(12), 'prompter'), true)
  assert.equal(gate.accepts(cue(11), 'prompter'), false)
  gate.select('viewer')
  assert.equal(gate.accepts(cue(12), 'viewer', oldGeneration), false)
  assert.equal(gate.accepts(cue(12), 'viewer'), true)
  assert.equal(gate.accepts(cue(13), 'prompter'), false)
  gate.reset()
  assert.equal(gate.accepts(cue(12)), true)
})

test('locked prompter blocks scroll navigation while preserving controls and browser zoom', () => {
  const blocked = overrides => {
    let prevented = false
    preventPrompterScroll({type: 'keydown', key: 'PageDown', preventDefault() {prevented = true}, ...overrides})
    return prevented
  }
  for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']) assert.equal(blocked({key}), true)
  assert.equal(blocked({type: 'wheel'}), true)
  assert.equal(blocked({type: 'wheel', ctrlKey: true}), false)
  assert.equal(blocked({type: 'touchmove', touches: [{}]}), true)
  assert.equal(blocked({type: 'touchmove', touches: [{}, {}]}), false)
  assert.equal(blocked({target: {closest: () => ({tagName: 'SELECT'})}}), false)
  assert.equal(blocked({key: 'Tab'}), false)
})

test('nearby context must contain the current cue and disappears when hidden, live or waiting', () => {
  const lines = [3,4,5,6].map(i => ({id: 'cue-' + i, text: '台詞' + i}))
  const payload = {source: 'script', currentIndex: 4, line: lines[1], cueWindow: {startIndex: 3, currentIndex: 4, total: 1000, lines}}
  const normalized = normalizeDisplayPayload(payload)
  assert.equal(normalized.currentIndex, 4)
  assert.equal(normalized.cueWindow.lines[1].id, 'cue-4')
  assert.equal(normalized.lines.length, 0)
  for (const source of ['waiting', 'hidden', 'transcription']) assert.equal(normalizeDisplayPayload({...payload, source}).cueWindow, null)
  assert.equal(normalizeDisplayPayload({...payload, displayEnabled: false}).cueWindow, null)
  assert.equal(normalizeDisplayPayload({...payload, line: {id: 'wrong'}}).cueWindow, null)
  assert.equal(normalizeDisplayPayload({...payload, currentIndex: 20}).cueWindow, null)
  assert.equal(normalizeDisplayPayload({...payload, cueWindow: {...payload.cueWindow, currentIndex: 5}}).cueWindow, null)
})
