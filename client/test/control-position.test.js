import {test} from 'node:test'
import assert from 'node:assert/strict'
import {resolveControlPosition} from '../src/lib/control-position.js'

const state = {sessionId: 'show', cellId: 'scene', lines: [{id: 'a'}, {id: 'b'}, {id: 'c'}], now: 1000, timeoutMs: 500}
const payload = {sessionId: 'show', cellId: 'scene', currentIndex: 1, lineId: 'b'}

test('position patches validate scene and line identity without changing the loaded script', () => {
  assert.deepEqual(resolveControlPosition(payload, state), {index: 1, lineId: 'b', pending: null})
  for (const patch of [{sessionId: 'other'}, {cellId: 'other'}, {currentIndex: -1}, {lineId: 'changed'}, {lineId: undefined}])
    assert.equal(resolveControlPosition({...payload, ...patch}, state), null)
  assert.deepEqual(state.lines, [{id: 'a'}, {id: 'b'}, {id: 'c'}])
})

test('manual cue requests survive old automatic patches until confirmed or expired', () => {
  const pending = {index: 2, requestedAt: 900}
  assert.deepEqual(resolveControlPosition(payload, {...state, pending}), {index: 2, lineId: 'c', pending})
  assert.equal(resolveControlPosition({...payload, currentIndex: 2, lineId: 'c'}, {...state, pending}).pending, null)
  assert.equal(resolveControlPosition(payload, {...state, pending, now: 1600}).index, 1)
  assert.equal(resolveControlPosition(payload, {...state, pending: {...pending, index: 30}}).index, 1)
})
