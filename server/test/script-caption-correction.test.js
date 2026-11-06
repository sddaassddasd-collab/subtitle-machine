const {test} = require('node:test');
const assert = require('node:assert/strict');
const {applyCaptionEdits, correctScriptCaption} = require('../src/script-caption-correction');

test('script vocabulary can repair a near-homophone while retaining improvisation and particles', () => {
  const raw = '其實跟核心的問題應該是這樣吧';
  assert.equal(applyCaptionEdits(raw, [{from: '跟核心', to: '更核心'}], [{text: '更核心的問題應該是'}]),
    '其實更核心的問題應該是這樣吧');
});
test('script rewriting, unsupported words, negation, people, numbers, deletions and ambiguous replacements are rejected', () => {
  for (const [raw, from, to, script] of [
    ['我沒有答應你呢', '沒有', '已經', '我已經答應你'],
    ['我不去', '不', '', '我去'],
    ['我欠你', '我欠你', '你欠我', '你欠我'],
    ['三個人', '三', '四', '四個人'],
    ['大家很快樂呢', '大家很快樂呢', '今天非常悲傷', '今天非常悲傷'],
    ['他留在原地', '原地', '園地', '附近沒有該詞'],
    ['跟核心跟核心', '跟核心', '更核心', '更核心'],
  ]) assert.equal(applyCaptionEdits(raw, [{from, to}], [{text: script}]), raw);
});
test('structured editing requests are bounded and preserve input on invalid or incomplete model output', async () => {
  const calls = [], client = {responses: {create: async (...args) => {
    calls.push(args); return {status: 'completed', output_text: JSON.stringify({edits: [{from: '跟核心', to: '更核心'}]})};
  }}};
  const script = [{text: '更核心的問題應該是'}];
  assert.equal(await correctScriptCaption(client, '其實跟核心的問題應該是', script, 'gpt-4o-mini'), '其實更核心的問題應該是');
  assert.equal(calls[0][0].text.format.type, 'json_schema');
  assert.equal(calls[0][1].maxRetries, 0);
  assert.ok(calls[0][1].timeout <= 2500);
  client.responses.create = async () => ({status: 'incomplete', output_text: '{'});
  assert.equal(await correctScriptCaption(client, '原本的即興內容', script, 'gpt-4o-mini'), '原本的即興內容');
});
