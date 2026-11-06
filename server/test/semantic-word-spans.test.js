const {test} = require('node:test');
const assert = require('node:assert/strict');
const {SemanticFollower, requestSemanticCandidate} = require('../src/semantic-follow');
const {prepareScript, localSupportCandidates} = require('../src/auto-follow');
const {compactInput, selectMatches} = require('../src/semantic-candidates');
const {SemanticTranscript} = require('../src/semantic-transcript');

const lines = ['目前已知的台詞位置', '你們的論點，', '既是對的，', '又是錯的，', '因為你們都沒有根據現在的情境解決問題。'].map(text => ({text}));
const script = prepareScript(lines);
const words = ['你們的', '論', '點', '哎', '其實', '對', '的'];
function observation(extra = {}) {
  return {currentIndex: 0, context: 'script', itemId: 'a', text: words.join(''), startMs: 0, endMs: 7000,
    isFinal: true, confidence: .123456, words: words.map((word, i) => ({word, start: i, end: i + 1, confidence: .876543})),
    candidates: lines.map((line, index) => ({index, text: line.text})), ...extra};
}
const match = (index, firstWordId, lastWordId, matchConfidence = .95) => ({index, firstWordId, lastWordId, matchConfidence});
const answer = (...matches) => ({matches, ambiguous: false});
function harness(request) {
  const accepted = [], records = [], stream = {};
  const f = new SemanticFollower({request, cooldownMs: 0});
  const h = {isCurrent: () => true, textCandidates: speech => localSupportCandidates(script, 0, speech.text),
    accept: (c, speech) => accepted.push({index: c.index, speech}), record: (status, data) => records.push({status, ...data})};
  return {f, h, stream, accepted, records};
}

test('one timed ASR item maps multiple cues and an independent literal prefix supports its final semantic span', async () => {
  const h = harness(async () => answer(match(1, 0, 2), match(2, 3, 6, .85)));
  await h.f.observe(h.stream, observation(), h.h);
  assert.equal(h.accepted.length, 1);
  assert.equal(h.accepted[0].index, 2, 'use the final supported cue, not the first similar line');
  assert.equal(h.accepted[0].speech.text, '哎其實對的');
  assert.equal(h.accepted[0].speech.startMs, 3000);
  assert.equal(h.accepted[0].speech.endMs, 7000);
  assert.equal(h.accepted[0].speech.supportingLastWordId, 2);
  assert.ok(h.records.some(r => r.status === 'supported' && r.reason === 'word_span_text' && r.matchConfidence === .85));
});
test('multiple model matches alone never change a cue when the other word range lacks clear literal support', async () => {
  const h = harness(async () => answer(match(1, 0, 2), match(2, 3, 6)));
  h.h.textCandidates = () => [];
  await h.f.observe(h.stream, observation(), h.h);
  assert.equal(h.accepted.length, 0);
  assert.ok(h.records.some(r => r.status === 'pending' && r.candidateIndex === 2));
});
test('an exact disjoint suffix in the same revision supports a medium-confidence semantic proposal', async () => {
  const texts = ['這句全部換了說法', '後面全新可靠的台詞'];
  const h = harness(async () => answer(match(1, 0, 0, .85)));
  h.h.textCandidates = speech => speech.text === texts[1]
    ? [{index: 2, confidence: 1, evidence: 10, matchedCharacters: 10}] : [];
  await h.f.observe(h.stream, observation({text: texts.join(''), endMs: 2000,
    words: texts.map((word, i) => ({word, start: i, end: i + 1}))}), h.h);
  assert.deepEqual(h.accepted.map(c => c.index), [2]);
  assert.equal(h.accepted[0].speech.startMs, 1000);
  assert.equal(h.accepted[0].speech.firstWordId, 1);
});
test('invented, reversed, overlapping or missing word spans cannot fabricate independent evidence', async () => {
  for (const matches of [
    [match(1, 99, 100)], [match(1, 3, 1)], [match(1, 0, null)],
    [match(1, 0, 3), match(2, 3, 6)], [match(2, 0, 2), match(1, 3, 6)],
    [match(1, null, null), match(2, null, null)],
  ]) {
    const h = harness(async () => answer(...matches));
    await h.f.observe(h.stream, observation(), h.h);
    assert.equal(h.accepted.length, 0);
    assert.ok(h.records.some(r => ['invalid_word_span', 'unordered_word_spans'].includes(r.reason)));
  }
});
test('medium-confidence proposals wait for independent text; two model answers do not suffice', async () => {
  let result = answer(match(1, null, null, .85));
  const h = harness(async () => result); h.h.textCandidates = () => [];
  await h.f.observe(h.stream, observation({words: []}), h.h);
  assert.ok(h.records.some(r => r.status === 'pending' && r.tier === 'provisional'));
  assert.equal(h.accepted.length, 0);
  result = answer(match(2, null, null));
  await h.f.observe(h.stream, observation({itemId: 'b', startMs: 7000, endMs: 8000, words: []}), h.h);
  assert.equal(h.accepted.length, 0);
  h.h.textCandidates = () => [{index: 3, confidence: 1, evidence: 8, matchedCharacters: 8}];
  await h.f.observe(h.stream, observation({itemId: 'c', startMs: 8000, endMs: 9000, words: []}), h.h);
  assert.deepEqual(h.accepted.map(c => c.index), [3]);
});
test('a same-cue semantic result is recorded as support without confirming an ending or moving the cue', async () => {
  const h = harness(async () => answer(match(0, null, null)));
  await h.f.observe(h.stream, observation(), h.h);
  assert.equal(h.accepted.length, 0);
  assert.ok(h.records.some(r => r.status === 'current_support' && r.reason === 'semantic_supports_current'));
  assert.ok(!h.records.some(r => r.reason === 'current_or_previous_cue'));
});
test('ASR confidence and clocks are absent from the exact prompt while word IDs and hypotheses remain', async () => {
  let body;
  const client = {chat: {completions: {create: async value => {
    body = value; return {choices: [{message: {content: '{"matches":[],"ambiguous":true}'}}]};
  }}}};
  const event = observation(), memory = new SemanticTranscript(), revision = memory.remember(event, 0);
  const input = compactInput(memory.input(revision));
  await requestSemanticCandidate(client, {...event, input});
  const prompt = JSON.parse(body.messages[1].content);
  assert.equal(prompt.latest.words[0].id, 0);
  assert.equal(prompt.latest.words[0].text, '你們的');
  assert.ok(!body.messages[1].content.includes('confidence'));
  assert.ok(!body.messages[1].content.includes('startMs'));
  assert.ok(!body.messages[1].content.includes('0.123456'));
  assert.ok(!body.messages[1].content.includes('0.876543'));
  assert.equal(body.response_format.json_schema.strict, true);
  assert.ok(body.response_format.json_schema.schema.properties.matches);
});
test('a same-item rewrite cannot reuse an earlier mapped prefix as independent semantic support', async () => {
  const h = harness(async () => answer(match(1, 0, 0)));
  let clock = 0; h.f.now = () => clock; h.f.cooldownMs = 3000;
  h.h.textCandidates = speech => speech.text === '後續新句子'
    ? [{index: 2, confidence: 1, evidence: 6, matchedCharacters: 6}] : [];
  await h.f.observe(h.stream, observation({text: '第一個改寫句子', endMs: 1000, isFinal: false,
    words: [{word: '第一個改寫句子', start: 0, end: 1}]}), h.h);
  clock = 1000;
  await h.f.observe(h.stream, observation({text: '第一個改寫句子接著', endMs: 2000, isFinal: false,
    words: [{word: '第一個改寫句子', start: 0, end: 1}, {word: '接著', start: 1, end: 2}]}), h.h);
  assert.ok(h.records.some(r => r.status === 'pending'));
  clock = 1500;
  await h.f.observe(h.stream, observation({text: '完全替換的舊內容後續新句子', endMs: 3000,
    words: [{word: '完全替換的舊內容', start: 0, end: 1}, {word: '後續新句子', start: 2, end: 3}]}), h.h);
  assert.equal(h.accepted.length, 0);
  assert.ok(h.records.some(r => r.reason === 'no_independent_audio'));
});

test('moving timestamps of the same words cannot turn an old prefix into a new semantic observation', async () => {
  let result = answer(match(1, 0, 0));
  const h = harness(async () => result); let clock = 0;
  h.f.now = () => clock;
  h.h.textCandidates = () => [];
  await h.f.observe(h.stream, observation({text: '第一個改寫句子', endMs: 1000, isFinal: false,
    words: [{word: '第一個改寫句子', start: 0, end: 1}]}), h.h);
  clock = 1000;
  await h.f.observe(h.stream, observation({text: '第一個改寫句子接著', endMs: 2000, isFinal: false,
    words: [{word: '第一個改寫句子', start: 0, end: 1}, {word: '接著', start: 1, end: 2}]}), h.h);
  result = answer(match(2, 0, 0)); clock = 2000;
  await h.f.observe(h.stream, observation({text: '第一個改寫句子接著新內容', endMs: 4000,
    words: [{word: '第一個改寫句子', start: 1, end: 2}, {word: '接著新內容', start: 2, end: 4}]}), h.h);
  assert.equal(h.accepted.length, 0);
  assert.equal(h.records.filter(r => r.reason === 'independent_semantic').length, 0);
});
