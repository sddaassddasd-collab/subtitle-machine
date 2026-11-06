const {test} = require('node:test');
const assert = require('node:assert/strict');
const {corroborateCurrentMatch} = require('../src/semantic-corroboration');
const {SemanticTranscript} = require('../src/semantic-transcript');
const {prepareScript, localSupportCandidates} = require('../src/auto-follow');
const {textSupportCandidates} = require('../src/live-script');
function fixture(text = '讓人的心裡頭是悶悶的') {
  const lines = [{text: '旋律聽起來都好奇怪'}, {text: '讓人心裡悶悶的'}, {text: '我以為自己休息一下就好'}];
  const script = prepareScript(lines), memory = new SemanticTranscript();
  const speech = {text, itemId: 'a', startMs: 6500, endMs: 8000, isFinal: true,
    words: [{word: text, start: 6.5, end: 8}]};
  memory.remember(speech, 8000);
  const context = {displayIndex: 1, predicted: true, predictionSource: 'opening', audioMs: 8000,
    anchor: {literal: true, index: 0, confidence: 1, atMs: 1000}, allowed: () => true};
  const state = {memory, handlers: {corroborationContext: () => context,
    textCandidates: s => textSupportCandidates(s, part => localSupportCandidates(script, 1, part.text))}};
  const match = {index: 1, tier: 'high', matchConfidence: .9, text: lines[1].text, speech};
  return {state, context, match};
}
test('current-cue corroboration covers the reported filler-heavy utterance while rejecting unsupported meaning and stale scope', () => {
  const {state, match} = fixture(); assert.ok(corroborateCurrentMatch(state, match));
  for (const text of ['讓人心裡不悶悶的', '讓我心裡悶悶的', '天氣真的非常的晴朗']) {
    const f = fixture(text); assert.equal(corroborateCurrentMatch(f.state, f.match), null, text);
  }
  for (const change of [f => {f.match.index = 2}, f => {f.context.predictionSource = 'onset'},
    f => {f.context.anchor.atMs = -40000}, f => {f.context.audioMs = 15000},
    f => {f.match.matchConfidence = .85}, f => {f.context.allowed = () => false}]) {
    const f = fixture(); change(f); assert.equal(corroborateCurrentMatch(f.state, f.match), null);
  }
});
