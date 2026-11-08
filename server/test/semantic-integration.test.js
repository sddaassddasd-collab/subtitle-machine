const {test} = require('node:test');
const assert = require('node:assert/strict');
const createFixture = require('./helpers/audio-server-fixture');
const flush = () => new Promise(resolve => setImmediate(resolve));
test('semantic verification of a short-opening paraphrase confirms the same cue and prepares the next opening', async t => {
  const f = createFixture({allowCueChanges: true, texts: ['旋律聽起來都好奇怪', '讓人心裡悶悶的。', '我以為自己休息一下就好']});
  t.after(() => f.dispose());
  const records = [], confirmations = [];
  f.history.event = (_id, type, data) => records.push({type, ...data});
  f.history.confirm = (...args) => confirmations.push(args);
  f.enableSemantic(async () => ({choices: [{message: {content: JSON.stringify({ambiguous: false,
    matches: [{index: 1, matchConfidence: .9, firstWordId: 0, lastWordId: 0}]})}}]}));
  f.stream.autoFollowAudioMs = 1000;
  f.transcript('旋律聽起來都好奇怪', {streamId: 's', itemId: 'a', startMs: 0, endMs: 1000, isFinal: true});
  f.stream.autoFollowAudioMs = 8000;
  f.transcript('讓人的心裡頭是悶悶的', {streamId: 's', itemId: 'b', startMs: 6500, endMs: 8000,
    isFinal: true, words: [{word: '讓人的心裡頭是悶悶的', start: 6.5, end: 8}]});
  await flush();
  assert.equal(f.session.currentIndex, 1);
  assert.equal(f.state().preparedIndex, 2);
  assert.ok(records.some(e => e.reason === 'current_opening_text_semantic'));
  assert.ok(records.some(e => e.type === 'opening_review' && e.status === 'confirmed'));
  assert.ok(confirmations.some(args => args[1] === 1 && args[2] === 'semantic' && args[3].completed === false));
  f.stream.autoFollowAudioMs = 8500;
  f.transcript('我以', {streamId: 's', itemId: 'c', startMs: 8200, endMs: 8500});
  assert.equal(f.session.currentIndex, 2);
});
test('the real server recovers a nearby long paraphrase using stable literal-semantic corroboration without arming an onset', async t => {
  const f = createFixture({allowCueChanges: true, texts: ['你又來了這樣根本沒有用', '你的方法才沒有用', '兩位先冷靜', '我說過', '你們又沒找到問題核心了']});
  t.after(() => f.dispose());
  const events = [], confirmations = [];
  f.history.event = (sessionId, type, data) => events.push({type, ...data});
  f.history.confirm = (...args) => confirmations.push(args);
  f.enableSemantic(async () => ({choices: [{message: {content: JSON.stringify({ambiguous: false,
    matches: [{index: 4, matchConfidence: .9, firstWordId: 0, lastWordId: 0}]})}}]}));
  f.stream.autoFollowAudioMs = 1000;
  f.transcript('你又來了這樣根本沒有用', {streamId: 's', itemId: 'anchor', startMs: 0, endMs: 1000, isFinal: true});
  f.stream.autoFollowAudioMs = 4000;
  f.transcript('你們又沒有找到問題的核心了', {streamId: 's', itemId: 'paraphrase', startMs: 2000, endMs: 4000,
    isFinal: true, words: [{word: '你們又沒有找到問題的核心', start: 2, end: 3.7}, {word: '了', start: 3.7, end: 4}]});
  await flush();
  assert.equal(f.session.currentIndex, 4);
  assert.equal(f.state().lastDecision.supportSource, 'joint_text_semantic');
  assert.equal(f.state().lastDecision.independentAudio, false);
  assert.equal(f.state().lastDecision.transcriptAudioEndMs, 3700);
  assert.equal(f.state().armedIndex, null);
  assert.equal(f.state().progress, 0);
  assert.ok(confirmations.some(args => args[1] === 4 && args[3].completed === false));
  assert.ok(events.some(e => e.reason === 'stable_long_text_semantic'));
});
test('server semantic fallback changes location only after two independent proposals and records no completion', async t => {
  const f = createFixture({allowCueChanges: true, texts: ['現在原本停留的地方', '專家提出一種新的治療方法', '另一位專家反對這個說法']});
  t.after(() => f.dispose());
  let index = 1;
  f.enableSemantic(async () => ({choices: [{message: {content: JSON.stringify({index, confidence: .95})}}]}));
  f.stream.autoFollowAudioMs = 1000;
  f.transcript('第一段完全換句話說', {streamId: 's', itemId: 'a', startMs: 0, endMs: 1000, isFinal: true});
  await flush();
  assert.equal(f.session.currentIndex, 0);
  index = 2; f.stream.autoFollowAudioMs = 3000;
  f.transcript('第二段說法也完全不一樣', {streamId: 's', itemId: 'b', startMs: 2000, endMs: 3000, isFinal: true});
  await flush();
  assert.equal(f.session.currentIndex, 2);
  assert.equal(f.state().lastDecision.source, 'semantic');
  assert.equal(f.state().armedIndex, null);
});
test('manual relocation while semantic inference is running discards the stale result', async t => {
  const f = createFixture({allowCueChanges: true, texts: ['目前的台詞內容', '下一句的內容', '最後一句的內容']});
  t.after(() => f.dispose());
  let resolve;
  f.enableSemantic(() => new Promise(done => {resolve = done}));
  f.stream.autoFollowAudioMs = 1000;
  f.transcript('完全不同的說法需要協助定位', {streamId: 's', itemId: 'a', startMs: 0, endMs: 1000, isFinal: true});
  f.session.currentIndex = 1; f.resetPosition();
  resolve({choices: [{message: {content: '{"index":2,"confidence":1}'}}]});
  await flush();
  assert.equal(f.session.currentIndex, 1);
  assert.equal(f.state().lastDecision, null);
});

test('a semantic proposal is supported by new short literal speech without a second model request or completion', async t => {
  const f = createFixture({allowCueChanges: true, texts: ['目前停在完全不同的地方', '專家改口提出另一套療法', '國王最喜歡的就是歌手', '天色已經漸漸變暗']});
  t.after(() => f.dispose());
  let calls = 0;
  const confirmations = [], events = [];
  f.history.confirm = (...args) => confirmations.push(args);
  f.history.event = (sessionId, type, data) => events.push({type, ...data});
  f.enableSemantic(async () => {calls++; return {choices: [{message: {content: '{"index":1,"confidence":0.95}'}}]}});
  f.stream.autoFollowAudioMs = 1000;
  f.transcript('現在使用完全改寫的說法', {streamId: 's', itemId: 'a', startMs: 0, endMs: 1000, isFinal: true});
  await flush();
  assert.equal(f.session.currentIndex, 0);
  f.stream.autoFollowAudioMs = 2000;
  f.transcript('國王最喜歡', {streamId: 's', itemId: 'b', startMs: 1000, endMs: 2000, isFinal: true});
  await flush();
  assert.equal(f.session.currentIndex, 2);
  assert.equal(calls, 1);
  assert.equal(f.state().lastDecision.source, 'semantic');
  assert.equal(f.state().lastDecision.supportSource, 'text');
  assert.equal(f.state().armedIndex, null);
  assert.equal(confirmations.length, 0);
  assert.ok(events.some(e => e.status === 'supported' && e.reason === 'independent_text'));
});
test('the real server sends superseded interim words separately when the final loses a useful key phrase', async t => {
  const f = createFixture({allowCueChanges: true, texts: ['目前停在完全不同的地方', '我決定要替病人進行搔癢治療', '另一個毫無關聯的句子']});
  t.after(() => f.dispose());
  let input;
  f.enableSemantic(async body => {
    input = JSON.parse(body.messages[1].content);
    return {choices: [{message: {content: '{"index":null,"confidence":0}'}}]};
  });
  f.stream.autoFollowAudioMs = 2000;
  f.transcript('我真的呢要使用我的搔癢', {streamId: 's', itemId: 'a', startMs: 0, endMs: 2000});
  f.transcript('我真的呢要使用我的', {streamId: 's', itemId: 'a', startMs: 0, endMs: 1500, isFinal: true});
  await flush();
  assert.equal(input.heard, '我真的呢要使用我的');
  assert.equal(input.alternatives[0].text, '我真的呢要使用我的搔癢');
  assert.equal(input.evidenceEndMs, undefined, 'audio clocks stay in local diagnostics');
  assert.equal(f.session.currentIndex, 0);
});
test('newer successful literal positioning invalidates outstanding semantic inference immediately', async t => {
  const f = createFixture({allowCueChanges: true, texts: ['目前的台詞內容完全不同', '劇本裡最後一句清楚的台詞', '另一句很遠的錯誤位置']});
  t.after(() => f.dispose());
  let resolve, signal;
  const events = [];
  f.history.event = (sessionId, type, data) => events.push({type, ...data});
  f.enableSemantic((body, options) => {signal = options.signal; return new Promise(done => {resolve = done})});
  f.stream.autoFollowAudioMs = 1000;
  f.transcript('無法用原有文字定位的改詞', {streamId: 's', itemId: 'a', startMs: 0, endMs: 1000, isFinal: true});
  f.stream.autoFollowAudioMs = 2000;
  f.transcript('劇本裡最後一句清楚的台詞', {streamId: 's', itemId: 'b', startMs: 1000, endMs: 2000, isFinal: true});
  assert.equal(f.session.currentIndex, 1);
  assert.equal(signal.aborted, true);
  resolve({choices: [{message: {content: '{"index":2,"confidence":1}'}}]}); await flush();
  assert.equal(f.session.currentIndex, 1);
  assert.ok(events.some(e => e.status === 'stale' && ['text_resolved', 'position_or_script_changed'].includes(e.reason)));
});
test('semantic candidates cannot skip across music and stage direction boundaries', async t => {
  for (const boundary of [{text: '配樂開始', music: true}, {text: '演員退場', type: 'direction'}]) {
    const f = createFixture({allowCueChanges: true, texts: ['目前的台詞內容完全不同', '邊界前還有一句話', boundary, '邊界後的另一段台詞']});
    t.after(() => f.dispose());
    let candidates;
    f.enableSemantic(async body => {
      candidates = JSON.parse(body.messages[1].content).candidates;
      return {choices: [{message: {content: '{"index":3,"confidence":1}'}}]};
    });
    f.stream.autoFollowAudioMs = 1000;
    f.transcript('完全改寫到無法直接定位的內容', {streamId: 's', itemId: 'a', startMs: 0, endMs: 1000, isFinal: true});
    await flush();
    assert.deepEqual(candidates.map(c => c.index), [0, 1]);
    assert.equal(f.session.currentIndex, 0);
  }
});

test('the server maps the final cue inside one ASR item and exports disjoint supporting word ranges without completion', async t => {
  const f = createFixture({allowCueChanges: true, texts: ['目前的台詞完全不一樣', '你們的論點', '既是對的', '又是錯的']});
  t.after(() => f.dispose());
  const events = [], confirmations = [];
  f.history.event = (sessionId, type, data) => events.push({type, ...data});
  f.history.confirm = (...args) => confirmations.push(args);
  f.enableSemantic(async () => ({choices: [{message: {content: JSON.stringify({ambiguous: false, matches: [
    {index: 1, matchConfidence: .95, firstWordId: 0, lastWordId: 2},
    {index: 2, matchConfidence: .85, firstWordId: 3, lastWordId: 6},
  ]})}}]}));
  const words = ['你們的', '論', '點', '哎', '其實', '對', '的'].map((word, i) => ({word, start: i, end: i + 1}));
  f.stream.autoFollowAudioMs = 7000;
  f.transcript(words.map(w => w.word).join(''), {streamId: 's', itemId: 'a', startMs: 0, endMs: 7000, words, isFinal: true});
  await flush();
  assert.equal(f.session.currentIndex, 2);
  assert.equal(f.state().lastDecision.source, 'semantic');
  assert.equal(f.state().lastDecision.firstWordId, 3);
  assert.equal(f.state().lastDecision.supportingLastWordId, 2);
  assert.equal(f.state().armedIndex, null);
  assert.equal(confirmations.length, 0);
  assert.ok(events.some(e => e.reason === 'word_span_text' && e.matchConfidence === .85));
});

test('server offers the distant literal relocation to semantic recovery instead of excluding it at 18 cues', async t => {
  const texts = ['國王緊急召開了國是會議', ...Array.from({length: 20}, (_, i) => `其他場景台詞編號${i}`),
    '如果你看過我的論文就知道'];
  const f = createFixture({allowCueChanges: true, texts});
  t.after(() => f.dispose());
  const requests = [];
  f.enableSemantic(async request => {
    requests.push(JSON.parse(request.messages.at(-1).content));
    return {choices: [{message: {content: JSON.stringify({matches: [], ambiguous: true})}}]};
  });
  f.stream.autoFollowAudioMs = 1000;
  f.transcript(texts[0], {streamId: 's', itemId: 'anchor', startMs: 0, endMs: 1000, isFinal: true});
  f.stream.autoFollowAudioMs = 5000;
  f.transcript('如果你有看過我的論文', {streamId: 's', itemId: 'recovery', startMs: 2000, endMs: 5000,
    isFinal: false, words: [{word: '如果你有看過我的論文', start: 2, end: 5}]});
  await new Promise(resolve => setTimeout(resolve, 650));
  f.transcript('如果你有看過我的論文的話', {streamId: 's', itemId: 'recovery', startMs: 2000, endMs: 5200,
    isFinal: false, words: [{word: '如果你有看過我的論文', start: 2, end: 5}, {word: '的話', start: 5, end: 5.2}]});
  await flush();
  assert.ok(requests.some(request => request.candidates.some(candidate => candidate.index === 21)));
  assert.equal(f.session.currentIndex, 0, 'a search hint alone must not commit a jump');
});
