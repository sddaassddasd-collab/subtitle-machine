const {test} = require('node:test');
const assert = require('node:assert/strict');
const {SemanticTranscript, freshSpeech} = require('../src/semantic-transcript');
const {SemanticFollower} = require('../src/semantic-follow');
const {prepareScript, localSupportCandidates} = require('../src/auto-follow');
const {SEMANTIC_SETTINGS: S} = require('../src/follow-settings');

const event = (itemId, text, startMs = 0, endMs = 1000, extra = {}) =>
  ({itemId, text, startMs, endMs, isFinal: true, ...extra});
const proposal = e => ({...e, context: 'script', currentIndex: 0,
  candidates: [0, 1, 2, 3, 4].map(index => ({index, text: `第${index}句台詞`}))});
function harness(request = async () => ({index: 1, confidence: .95})) {
  let clock = 0, candidates = [];
  const accepted = [], records = [], stream = {};
  const follower = new SemanticFollower({request, now: () => clock, cooldownMs: 3000});
  const handlers = {isCurrent: () => true, record: (status, data) => records.push({status, ...data}),
    textCandidates: () => candidates, accept: (c, speech) => accepted.push({index: c.index, speech})};
  return {follower, stream, handlers, accepted, records, observe: e => follower.observe(stream, proposal(e), handlers),
    clock: value => {clock = value}, candidates: value => {candidates = value}};
}
const match = (index, confidence = .95, extra = {}) =>
  ({index, confidence, evidence: 6, matchedCharacters: 5, offset: 6, length: 10, ...extra});

test('shortened final preserves the withdrawn key phrase as an alternative with its original audio fence', () => {
  const memory = new SemanticTranscript();
  memory.remember(event('a', '要使用我的搔癢', 0, 2000, {isFinal: false}), 0);
  const final = memory.remember(event('a', '要使用我的', 0, 1500), 1000);
  const input = memory.input(final);
  assert.equal(input.heard, '要使用我的');
  assert.equal(input.alternatives[0].text, '要使用我的搔癢');
  assert.equal(input.alternatives[0].isFinal, false);
  assert.equal(input.evidenceEndMs, 2000);
  assert.equal(memory.requestReason(final), null, 'earlier useful text can qualify a short final');
  assert.equal(freshSpeech(event('b', '這段音訊仍然重疊', 1600, 1900, {words: []}), input.evidenceEndMs), null);
});
test('hypothesis and word retention stay bounded during long growing items', () => {
  const m = new SemanticTranscript(); let latest;
  for (let i = 0; i < 100; i++) latest = m.remember(event('a', '不同的修訂文字'.repeat(100) + i, 0, i + 1000,
    {isFinal: false, words: Array.from({length: 400}, (_, j) => ({word: '字', start: j / 1000, end: (j + 1) / 1000}))}), i * 1000);
  const input = m.input(latest);
  assert.ok(input.heard.length <= S.heardCharacters);
  assert.ok(input.alternatives.length <= S.alternatives);
  assert.ok(input.latest.words.length <= S.maximumWords);
  assert.ok(m.items.get('a').revisions.length <= S.revisionsPerItem);
});
test('stable interim can request early; duplicate, shortened final and cooldown cannot flood requests', async () => {
  let calls = 0;
  const h = harness(async () => {calls++; return {index: null, confidence: 0}});
  await h.observe(event('a', '演員用完全不同方式說', 0, 1000, {isFinal: false}));
  assert.equal(calls, 0);
  h.clock(1000);
  await h.observe(event('a', '演員用完全不同方式說明', 0, 2000, {isFinal: false}));
  assert.equal(calls, 1);
  h.clock(1100);
  await h.observe(event('a', '演員用完全不同方式說明一切原因', 0, 3000, {isFinal: false}));
  assert.equal(calls, 1);
  h.clock(5000);
  await h.observe(event('a', '演員用完全不同方式', 0, 1500));
  assert.equal(calls, 1, 'deleted text is not novel speech');
  assert.ok(h.records.some(r => r.reason === 'cooldown'));
});
test('one semantic proposal plus clear independent text recovers without a second API call', async () => {
  const h = harness();
  await h.observe(event('a', '改詞後完全不同的說法'));
  assert.equal(h.accepted.length, 0);
  h.candidates([match(2), match(3, .5)]);
  h.clock(1000);
  await h.observe(event('b', '後續新的可靠台詞', 1000, 2000));
  assert.deepEqual(h.accepted.map(c => c.index), [2]);
  assert.equal(h.records.filter(r => r.status === 'requested').length, 1);
  assert.equal(h.accepted[0].speech.text, '後續新的可靠台詞');
  assert.ok(h.records.some(r => r.status === 'supported' && r.reason === 'independent_text'));
});
test('new words in the same proposed cue can corroborate it; a repeated hypothesis cannot', async () => {
  const h = harness();
  await h.observe(event('a', '改詞後完全不同的說法', 0, 1000, {isFinal: false}));
  h.clock(1000);
  await h.observe(event('a', '改詞後完全不同的說法繼續', 0, 2000, {isFinal: false}));
  h.candidates([match(1)]);
  h.clock(1500);
  await h.observe(event('a', '改詞後完全不同的說法繼續增加內容', 0, 3000, {isFinal: false}));
  assert.equal(h.accepted.length, 0, 'un-timed growth cannot count twice');
  await h.observe(event('b', '另一段確實說到同一格', 3000, 4000));
  assert.deepEqual(h.accepted.map(c => c.index), [1]);
});
test('same-item support uses only timestamped new suffix words, excluding older script-like words', async () => {
  const h = harness();
  await h.observe(event('a', '這句改寫內容暫時無法辨認', 0, 1000, {isFinal: false}));
  h.clock(1000);
  await h.observe(event('a', '這句改寫內容暫時無法辨認接著', 0, 2000, {isFinal: false}));
  const inputs = [];
  h.handlers.textCandidates = speech => {inputs.push(speech.text); return [match(2)]};
  await h.observe(event('a', '這句改寫內容暫時無法辨認接著國王最喜歡歌手', 0, 3500, {words: [
    {word: '接著', start: 1, end: 2}, {word: '國王', start: 2, end: 2.5},
    {word: '最喜歡', start: 2.5, end: 3}, {word: '歌手', start: 3, end: 3.5},
  ]}));
  assert.deepEqual(inputs, ['國王最喜歡歌手']);
  assert.deepEqual(h.accepted.map(c => c.index), [2]);
  assert.equal(h.accepted[0].speech.startMs, 2000);
});
test('overlapping audio without usable words, close competing cues, and expired proposals do not recover', async () => {
  for (const kind of ['overlap', 'ambiguous', 'expired', 'too_short', 'contradictory']) {
    const h = harness(); await h.observe(event('a', '這句內容完全換了一種說法'));
    h.candidates(kind === 'ambiguous' ? [match(2), match(3, .92)] :
      kind === 'too_short' ? [match(2, .99, {evidence: 3, matchedCharacters: 3})] :
        kind === 'contradictory' ? [match(0)] : [match(2)]);
    h.clock(kind === 'expired' ? 16000 : 1000);
    await h.observe(event('b', '這句後續辨識文字', kind === 'overlap' ? 500 : 1000, 2000));
    assert.equal(h.accepted.length, 0, kind);
    if (kind === 'expired') assert.ok(h.records.some(r => r.reason === 'support_expired'));
    if (kind === 'contradictory') assert.ok(h.records.some(r => r.reason === 'contradictory_text'));
  }
});
test('two ordered weaker text cues can support semantics, but revisions and ambiguous alternatives cannot', async () => {
  const h = harness(); await h.observe(event('a', '演員改詞後的第一句話'));
  h.candidates([match(2, .74)]);
  await h.observe(event('b', '差一些字但順序符合', 1000, 2000, {isFinal: false}));
  assert.equal(h.accepted.length, 0);
  h.candidates([match(3, .73)]);
  await h.observe(event('b', '差一些字但順序符合並延長', 1000, 3000, {isFinal: false}));
  assert.equal(h.accepted.length, 0, 'same audio cannot complete a weak path');
  await h.observe(event('c', '再下一句也有部分差異', 3000, 4000));
  assert.deepEqual(h.accepted.map(c => c.index), [3]);
  assert.ok(h.records.some(r => r.reason === 'ordered_weak_text'));
});
test('text arriving while inference is busy supports the pending result without waiting for another utterance', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => {finish = resolve}));
  const running = h.observe(event('a', '改寫到字面對不起來的台詞'));
  h.candidates([match(2)]); h.clock(1000);
  await h.observe(event('b', '已經收到的後續可靠內容', 1000, 2000));
  assert.equal(h.accepted.length, 0);
  finish({index: 1, confidence: .95}); await running;
  assert.deepEqual(h.accepted.map(c => c.index), [2]);
  assert.equal(h.accepted[0].speech.itemId, 'b');
});
test('rejections include confidence, request duration and a concrete reason; uncertain answers retain unexpired proposal', async () => {
  const answers = [{index: 1, confidence: .95}, {index: null, confidence: .3}, {index: 2, confidence: .5}];
  const h = harness(async () => answers.shift());
  await h.observe(event('a', '第一個換詞的辨識內容'));
  h.clock(3000); await h.observe(event('b', '新的辨識內容暫時無法定位', 1000, 2000));
  h.clock(6000); await h.observe(event('c', '新的辨識內容依然無法定位', 2000, 3000));
  const uncertain = h.records.filter(r => r.status === 'uncertain');
  assert.deepEqual(uncertain.map(r => r.reason), ['no_candidate', 'low_confidence']);
  assert.deepEqual(uncertain.map(r => r.confidence), [.3, .5]);
  assert.ok(uncertain.every(r => r.requestMs >= 0 && r.inputId && r.pendingIndex === 1));
  h.follower.reset(h.stream, 'operator_reposition');
  assert.ok(h.records.some(r => r.status === 'reset' && r.reason === 'operator_reposition' && r.pendingAgeMs === 6000));
});
test('phonetic support retains literal anchors and musical boundaries', () => {
  const script = prepareScript([{text: '目前的位置'}, {text: '可是他答應過你'}, {text: '音樂開始', music: true}, {text: '國王最喜歡歌手'}]);
  const candidates = localSupportCandidates(script, 0, '科是他打應過你');
  assert.ok(candidates.some(c => c.index === 1 && c.phonetic && c.matchedCharacters >= 4));
  assert.ok(!localSupportCandidates(script, 0, '國王最喜歡歌手').some(c => c.index === 3));
});

test('manual/context resets retain the stream cooldown and item request budget', async () => {
  let calls = 0;
  const h = harness(async () => {calls++; return {index: null, confidence: 0}});
  await h.observe(event('a', '完全換一種說法的內容'));
  h.follower.reset(h.stream, 'position_reset'); h.clock(1000);
  await h.observe(event('b', '重定位後仍需要協助的內容', 1000, 2000));
  assert.equal(calls, 1, 'reset cannot bypass cooldown');
  h.follower.reset(h.stream); h.clock(3000);
  await h.observe(event('a', '同一段修訂內容依然換了說法'));
  assert.equal(calls, 2);
  h.follower.reset(h.stream); h.clock(6000);
  await h.observe(event('a', '同一段修訂內容還有其他說法'));
  assert.equal(calls, 2, 'reset cannot bypass two-request cap for an item');
});
test('the exact compact API input and candidates are logged and linked to transcript revision IDs', async () => {
  let sent;
  const h = harness(async observation => {sent = observation.input; return {index: null, confidence: 0}});
  await h.observe(event('a', '需要語意協助的改詞內容', 0, 1000, {revisionId: 'raw-revision-id',
    words: [{word: '內容', start: .8, end: 1}]}));
  const requested = h.records.find(r => r.status === 'requested');
  assert.deepEqual(requested.input, sent);
  assert.equal(sent.latest.inputId, 'raw-revision-id');
  assert.deepEqual(sent.latest.words, [{id: 0, text: '內容'}]);
  assert.ok(!JSON.stringify(sent).includes('confidence'));
  assert.ok(!JSON.stringify(sent).includes('startMs'));
  assert.deepEqual(requested.candidates.map(c => c.index), [0, 1, 2, 3, 4]);
});

test('a clear same-audio literal revision cancels a conflicting proposal without counting as positive support', async () => {
  const h = harness();
  await h.observe(event('a', '辨識還在不斷修訂的內容', 0, 1000, {isFinal: false}));
  h.clock(1000);
  await h.observe(event('a', '辨識還在不斷修訂的內容稍長', 0, 2000, {isFinal: false}));
  h.candidates([match(3)]);
  await h.observe(event('a', '最後變成另一格清楚的台詞', 0, 1800));
  assert.equal(h.accepted.length, 0);
  assert.ok(h.records.some(r => r.status === 'reset' && r.reason === 'revised_text_contradiction'));
});
