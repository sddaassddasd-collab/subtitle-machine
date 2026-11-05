const {test} = require('node:test');
const assert = require('node:assert/strict');
const {scriptKeyterms, refreshKeyterms, acknowledgeKeyterms} = require('../src/script-keyterms');

test('nearby vocabulary is bounded, deduplicated and excludes music/directions', () => {
  const lines = [{role: '國王', text: '隔離所需要快樂教育'}, {role: '國王', text: '快樂教育必須繼續'},
    {text: '不應送出的舞台指示', type: 'direction'}, {text: '不應送出的音樂歌詞', music: true}];
  const terms = scriptKeyterms(lines, 0, '隔離所、快樂教育');
  assert.ok(terms.includes('隔離所'));
  assert.ok(terms.includes('國王'));
  assert.equal(terms.length, new Set(terms).size);
  assert.ok(Buffer.byteLength(terms.join('')) <= 400);
  assert.ok(!terms.some(t => t.includes('舞台') || t.includes('歌詞')));
});

test('dynamic vocabulary updates never queue more than one request or block audio', () => {
  const sent = [], events = [];
  const stream = {ready: true, socket: {send: x => sent.push(JSON.parse(x))},
    scriptKeyterms: {terms: [], pending: null, checkedAt: 0}};
  const emit = (status, data) => events.push({status, ...data});
  refreshKeyterms(stream, [{text: '隔離所'}], 0, emit, 1000);
  assert.equal(sent.length, 1);
  refreshKeyterms(stream, [{text: '國王大人'}], 0, emit, 2000);
  assert.equal(sent.length, 1);
  assert.equal(acknowledgeKeyterms(stream, {type: 'Results'}, emit), false);
  acknowledgeKeyterms(stream, {type: 'ConfigureSuccess'}, emit);
  refreshKeyterms(stream, [{text: '國王大人'}], 0, emit, 3000);
  assert.equal(sent.length, 2);
  acknowledgeKeyterms(stream, {type: 'ConfigureFailure', code: 'UNSUPPORTED'}, emit);
  refreshKeyterms(stream, [{text: '隔離所'}], 0, emit, 4000);
  assert.equal(sent.length, 2);
  assert.equal(events.at(-1).status, 'failed');
});

test('missing configure acknowledgements disable optional updates without throwing', () => {
  const stream = {ready: true, socket: {send() {}}, scriptKeyterms: {terms: [], pending: null, checkedAt: 0}};
  const events = [];
  refreshKeyterms(stream, [{text: '隔離所'}], 0, status => events.push(status), 1000);
  refreshKeyterms(stream, [{text: '國王大人'}], 0, status => events.push(status), 7000);
  assert.equal(stream.scriptKeyterms.disabled, true);
  assert.deepEqual(events, ['requested', 'timeout']);
});

test('manual programme phrases retain whole words and are prioritized over generic script terms', () => {
  const {normalizeVocabulary} = require('../src/script-keyterms');
  assert.deepEqual(normalizeVocabulary('完整術語\n完整術語，另一個詞組'), ['完整術語', '另一個詞組']);
  const terms = scriptKeyterms([{role: '角色', text: '我們都是他的朋友現在可以開始'}], 0, '', ['完整術語']);
  assert.equal(terms[0], '完整術語');
  assert.ok(!terms.includes('都是') && !terms.includes('他的') && !terms.includes('現在'));
  const other = scriptKeyterms([{role: '另一角色', text: '完全不同的故事'}], 0);
  assert.ok(!other.includes('完整術語'));
});
