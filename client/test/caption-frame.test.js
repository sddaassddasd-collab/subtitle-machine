import {test} from 'node:test'
import assert from 'node:assert/strict'
import {captionFrame, latestCaptionRows} from '../src/lib/caption-frame.js'

test('a source switch with no usable words retains the visible caption without clearing it', () => {
  const script = captionFrame({scope: 'show:zh', enabled: true, source: 'script', entryId: 'cue', scriptRows: [{id: 'zh', text: '先前台詞'}]})
  assert.equal(captionFrame({scope: 'show:zh', enabled: true, source: 'transcription', liveRows: []}, script), script)
  const live = captionFrame({scope: 'show:zh', enabled: true, source: 'transcription', entryId: 'item', liveRows: [{id: 'zh', text: '演員即興'}]}, script)
  assert.equal(live.rows[0].text, '演員即興')
  assert.equal(captionFrame({scope: 'show:zh', enabled: true, source: 'transcription', entryId: 'item', liveRows: [{id: 'zh', text: '演員即興補充'}]}, live).key, live.key)
})
test('hide, stage direction, waiting and language/session changes cannot revive cached words', () => {
  const previous = {scope: 'show:zh', rows: [{text: '先前台詞'}]}
  for (const source of ['hidden', 'waiting', 'direction']) assert.deepEqual(captionFrame({scope: 'show:zh', enabled: true, source}, previous).rows, [])
  assert.deepEqual(captionFrame({scope: 'show:zh', enabled: false, source: 'transcription'}, previous).rows, [])
  assert.deepEqual(captionFrame({scope: 'show:en', enabled: true, source: 'transcription'}, previous).rows, [])
})
test('bilingual captions use the same newest utterance and reserve missing translations without borrowing older ones', () => {
  const entries = [{id: 'old', text: '上一句', translations: {en: 'Old line'}}, {id: 'new', text: '這一句', translations: {}}]
  const languages = [{id: 'primary', source: true}, {id: 'english', code: 'en'}]
  assert.deepEqual(latestCaptionRows(entries, languages), [{id: 'primary', text: '這一句'}, {id: 'english', text: ''}])
  entries[1].translations.en = 'This line'
  assert.equal(latestCaptionRows(entries, languages)[1].text, 'This line')
})
