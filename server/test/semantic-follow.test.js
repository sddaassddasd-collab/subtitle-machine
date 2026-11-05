const {test} = require('node:test');
const assert = require('node:assert/strict');
const {SemanticFollower, requestSemanticCandidate} = require('../src/semantic-follow');
const {createTracker, applySemanticLocation} = require('../src/auto-follow');
const observation = (itemId, index = 0) => ({currentIndex: 0, context: 'same-script', text: '演員換了一種說法',
  candidates: [{index: 1, text: '台詞一'}, {index: 2, text: '台詞二'}], itemId,
  startMs: index * 2000, endMs: index * 2000 + 1000, isFinal: true});
test('semantic recovery requires two distinct ordered utterances, not a single confident answer', async () => {
  let target = 1, clock = 0;
  const f = new SemanticFollower({request: async () => ({index: target, confidence: .95}), now: () => clock, cooldownMs: 0});
  const stream = {}, accepted = [], statuses = [];
  const handlers = {isCurrent: () => true, accept: c => accepted.push(c.index), record: s => statuses.push(s)};
  await f.observe(stream, observation('a'), handlers);
  assert.deepEqual(accepted, []);
  target = 2; clock = 100;
  await f.observe(stream, observation('a', 1), handlers);
  assert.deepEqual(accepted, [], 'same item cannot count twice');
  target = 1; await f.observe(stream, observation('b', 2), handlers);
  target = 2; await f.observe(stream, observation('c', 3), handlers);
  assert.deepEqual(accepted, [2]);
});
test('stale responses, invented indices, ambiguous answers and errors never advance', async () => {
  for (const result of [{index: 999, confidence: 1}, {index: null, confidence: 0}, {index: 1, confidence: 2}]) {
    const f = new SemanticFollower({request: async () => result, cooldownMs: 0});
    await f.observe({}, observation('a'), {isCurrent: () => true, accept: () => assert.fail(), record() {}});
  }
  const f = new SemanticFollower({request: async () => ({index: 1, confidence: .99})});
  await f.observe({}, observation('a'), {isCurrent: () => false, accept: () => assert.fail(), record() {}});
});
test('semantic placement never invents words or arms an onset', () => {
  const t = createTracker(), lines = [{text: '原本的台詞'}, {text: '另一句劇本台詞'}];
  assert.equal(applySemanticLocation(t, lines, 1, {itemId: 'a', text: '實際辨識到的改詞', endMs: 2000}), true);
  assert.equal(t.progress, 0);
  assert.equal(t.armedIndex, null);
  assert.equal(t.sequence.observed.text, '實際辨識到的改詞');
  assert.equal(t.items.size, 0);
});
test('structured semantic requests send only text and constrain returned data', async () => {
  let sent;
  const client = {chat: {completions: {create: async body => {
    sent = body; return {choices: [{message: {content: '{"index":null,"confidence":0}'}}]};
  }}}};
  assert.deepEqual(await requestSemanticCandidate(client, observation('a')), {index: null, confidence: 0});
  assert.equal(sent.response_format.json_schema.strict, true);
  assert.equal(sent.messages.length, 2);
  assert.equal(JSON.parse(sent.messages[1].content).heard, '演員換了一種說法');
});

test('hung semantic requests time out without delaying subsequent observations forever', async () => {
  const statuses = [];
  const f = new SemanticFollower({request: () => new Promise(() => {}), timeoutMs: 5});
  await f.observe({}, observation('a'), {isCurrent: () => true, accept: () => assert.fail(), record: s => statuses.push(s)});
  assert.deepEqual(statuses, ['requested', 'timeout']);
});
