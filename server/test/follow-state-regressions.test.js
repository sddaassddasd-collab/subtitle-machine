const {test} = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/audio-server-fixture');
const {normalizePerformanceSettings, PerformanceFollower} = require('../src/performance-follow');
const {CaptionPresentation} = require('../src/caption-presentation');
const {suffixSpeech} = require('../src/word-evidence');
const {createTracker, followTranscript} = require('../src/auto-follow');
const distantLines = Array.from({length: 130}, (_, i) => `遠處另一幕完全不相干的場景與對話內容編號${i}`);
const flush = async () => {for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))};

function setup(t, texts) {
  const f = fixture({texts, allowCueChanges: true}); t.after(() => f.dispose());
  f.allowSettings(); f.session.performanceFollowing = normalizePerformanceSettings({automaticLive: true});
  f.session.captionMode = 'script'; f.stream.liveTranslationStreamId = 's';
  let now = Date.now(); const base = now;
  t.mock.method(Date, 'now', () => now);
  const events = [];
  f.history.event = (id, type, data) => events.push({type, ...data});
  const say = (text, itemId, startMs, endMs, wallMs = endMs, options = {}) => {
    now = base + wallMs; f.stream.autoFollowAudioMs = endMs;
    f.transcript(text, {text, itemId, streamId: 's', startMs, endMs, receivedAt: now, isFinal: true, ...options});
  };
  const tick = (audioMs, wallMs) => {now = base + wallMs; f.stream.autoFollowAudioMs = audioMs; f.tick(audioMs, now)};
  return {...f, events, say, tick};
}

test('the reported multi-cue suffix stays verified in the fallback arbiter with its own word clocks', t => {
  const f = setup(t, ['每當我試著寫新的音樂', '旋律聽起來都好奇怪', '讓人心裡悶悶的']);
  f.say('每當我試著寫新的音樂', 'anchor', 0, 1000);
  const parts = ['每當', '我', '試著', '想要', '寫', '新的', '歌', '旋', '律', '聽起來', '都', '好', '奇怪'];
  const words = parts.map((word, i) => ({word, startMs: 1100 + i * 300, endMs: 1400 + i * 300}));
  f.say(parts.join(''), 'combined', 1100, 5000, 5000, {words});
  assert.equal(f.session.currentIndex, 1);
  assert.equal(f.follower().lastReliable.index, 1);
  assert.equal(f.follower().lastReliable.startMs, words[7].startMs);
  assert.equal(f.follower().lastReliable.endMs, 5000);
  assert.equal(f.follower().mismatch, null);
  assert.equal(f.follower().fallbackDecision.reason, 'script_matched');
  assert.equal(f.session.automaticLive, undefined);
});

test('recorded ASR revisions keep the current ending before the prepared two-character cue, without jumping ahead', () => {
  const recorded = require('./fixtures/cue-tail.json'), tracker = createTracker(), decisions = [];
  let index = recorded.initialIndex;
  for (const event of recorded.events) {
    const result = followTranscript(tracker, recorded.lines, index, {...event, streamId: 'recorded'});
    if (Number.isInteger(result.index)) index = result.index;
    if (['感到快樂', '另外', '另外快樂'].includes(event.text)) decisions.push({text: event.text, index: index + 1});
  }
  assert.deepEqual(decisions, [{text: '感到快樂', index: 15}, {text: '另外', index: 16}, {text: '另外快樂', index: 17}]);
});

test('a matched suffix starting inside a provider word uses that whole word without estimating an inner timestamp', () => {
  const event = {itemId: 'combined', text: '前面的台詞聽起來都好奇怪', startMs: 1000, endMs: 5000,
    words: [{word: '前面的台詞', startMs: 1000, endMs: 3000}, {word: '聽起來', startMs: 3000, endMs: 4000},
      {word: '都好奇怪', startMs: 4000, endMs: 5000}]};
  const speech = suffixSpeech(event, '起來都好奇怪');
  assert.equal(speech.text, '聽起來都好奇怪'); assert.equal(speech.startMs, 3000);
  assert.equal(suffixSpeech({...event, words: []}, '起來都好奇怪'), null);
});

test('a fresh opening clears the old mismatch and still permits same-cue semantic verification', async t => {
  const f = setup(t, ['旋律聽起來都好奇怪', '讓人心裡悶悶的', '我以為自己休息一下就好']);
  let resolve;
  f.enableSemantic(() => new Promise(done => {resolve = done}));
  f.say('旋律聽起來', 'anchor', 0, 1000);
  f.say('今天還有別的事情需要考慮', 'unmatched', 1100, 3000);
  // The first request is irrelevant to the prepared opening; finish it before
  // testing a fresh request close to the mismatch deadline.
  resolve({choices: [{message: {content: '{"matches":[],"ambiguous":true}'}}]}); await flush();
  f.say('讓人的心裡頭是悶悶的', 'opening', 5500, 7000, 7200,
    {words: [{word: '讓人的心裡頭是悶悶的', startMs: 5500, endMs: 7000}]});
  assert.equal(f.session.currentIndex, 1);
  f.tick(7400, 7600);
  assert.equal(f.follower().fallbackDecision.reason, 'needs_distinct_speech');
  assert.equal(f.follower().mismatch.items.size, 1);
  assert.notEqual(f.session.automaticLive, true);
  resolve({choices: [{message: {content: JSON.stringify({ambiguous: false,
    matches: [{index: 1, matchConfidence: 1, firstWordId: 0, lastWordId: 0}]})}}]}); await flush();
  assert.equal(f.state().preparedIndex, 2);
  assert.equal(f.follower().mismatch, null);
  assert.ok(f.events.some(e => e.reason === 'current_opening_text_semantic'));
  assert.ok(f.events.some(e => e.type === 'opening_review' && e.status === 'confirmed'));
});

test('repeated semantic requests cannot renew the grace window for the same unmatched speech', () => {
  const p = new PerformanceFollower();
  p.bind(normalizePerformanceSettings({automaticLive: true}), 'scene', [{text: '已經確認的台詞'}]);
  p.originIndex = 0;
  const event = (itemId, startMs, endMs, text) => ({itemId, startMs, endMs, text, audioMs: endMs, isFinal: true});
  p.observe(event('a', 0, 3000, '現在演員開始即興發揮'), null, 3000);
  p.semanticRequested('first', 7900);
  assert.equal(p.observe(event('b', 4000, 8000, '接著說了完全不同的話'), null, 8000), null);
  assert.equal(p.fallbackDecision.reason, 'semantic_grace');
  p.semanticRequested('second', 10000);
  assert.equal(p.tick(10000, 10401).source, 'live');
});

test('script-mode capture recovery preserves position and allows fallback before a new literal anchor exists', t => {
  const f = setup(t, ['究竟他為什麼不快樂', '下一句完全不同的台詞']);
  f.say('究竟他為什麼不快樂', 'old', 530000, 534000, 534000);
  f.follower().rates = [4]; f.follower().usedGroups.add('consumed');
  f.restartTracking();
  assert.equal(f.follower().originIndex, 0);
  assert.equal(f.follower().lastReliable, null);
  assert.equal(f.follower().lastConfirmedEnd, -1);
  assert.deepEqual(f.follower().rates, [4]);
  assert.ok(f.follower().usedGroups.has('consumed'));
  assert.equal(f.follower().buffer.length, 0);
  f.say('這一段已經偏離原來劇本', 'new-a', 0, 2000, 540000);
  f.say('大家繼續談論其他的事情', 'new-b', 2500, 6000, 545000);
  assert.equal(f.session.automaticLive, true);
  assert.equal(f.session.currentIndex, 0);
  assert.notEqual(f.follower().fallbackDecision.reason, 'no_script_anchor');
});

test('the reported capture restart reacquires an isolated distinctive nearby suffix on the new word clock', t => {
  const f = setup(t, ['他就會被關進隔離所裡進行快樂教育', '直到他重新感到快樂',
    '這就是快樂王國一直保持快樂的秘密', '有一天', ...distantLines]);
  const revisions = []; f.history.revision = (_id, text, _options, data) => revisions.push({text, ...data});
  f.say('他就會被關進隔離所裡進行快樂教育', 'old', 70000, 72000);
  f.restartTracking(); f.restartTracking();
  f.say('一直保持', 'new', 0, 880, 74000, {isFinal: false,
    words: [{word: '一直保持', startMs: 0, endMs: 880}]});
  assert.equal(f.session.currentIndex, 0);
  f.say('一直保持快樂的秘密', 'new', 0, 1920, 75000,
    {words: [{word: '一直保持快樂的秘密', startMs: 0, endMs: 1920}]});
  assert.equal(f.session.currentIndex, 2);
  assert.equal(revisions.at(-1).reason, 'capture_reacquired');
  assert.equal(f.follower().lastReliable.endMs, 1920);
  assert.equal(f.state().preparedIndex, 3);
});

test('the capture shortcut requires fresh word clocks and distinctive speech without music barriers; ordinary relocation keeps its own rules', t => {
  for (const [text, endMs, words, boundary] of [
    ['一直保持快樂的秘密', 1920, false, null], ['快樂', 1920, true, null],
    ['一直保持快樂的秘密', 9000, true, null], ['一直保持快樂的秘密', 1920, true, {music: true}],
  ]) {
    const f = setup(t, ['他就會被關進隔離所裡進行快樂教育', {text: '直到他重新感到快樂', ...boundary},
      '這就是快樂王國一直保持快樂的秘密', ...distantLines]);
    const revisions = []; f.history.revision = (_id, _text, _options, data) => revisions.push(data);
    f.say('他就會被關進隔離所裡進行快樂教育', 'old', 70000, 72000); f.restartTracking();
    f.say(text, 'new', 0, endMs, 80000, {words: words ? [{word: text, startMs: 0, endMs}] : undefined});
    assert.notEqual(revisions.at(-1).reason, 'capture_reacquired', text);
    if (text === '快樂') assert.equal(f.session.currentIndex, 0);
  }
});

test('a normally verified three-character cue clears the previous mismatch instead of switching to live captions immediately afterwards', t => {
  const f = setup(t, ['想必你是準備要寫一首讓大家快樂的歌吧', '歌手說', '喔對我會準備寫一首歌']);
  f.say('想必你是準備要寫一首讓大家快樂的歌吧', 'anchor', 0, 1000);
  f.say('完全不同的內容需要重新理解', 'x', 1100, 3000, 3000);
  f.say('而且還有其他的話要說', 'y', 3100, 6000, 6000);
  f.say('歌手說', 'cue', 6100, 6800, 6800,
    {words: [{word: '歌手說', startMs: 6100, endMs: 6800}]});
  f.tick(7300, 7600);
  assert.equal(f.session.currentIndex, 1); assert.notEqual(f.session.automaticLive, true);
  assert.equal(f.follower().mismatch, null); assert.equal(f.follower().lastReliable.index, 1);
});

test('capture recovery holds visible wording without reusing old ASR IDs or time fences', () => {
  const old = new CaptionPresentation(), entries = [{id: 'deepgram-0', text: '觀眾目前讀到的改詞', startMs: 530000, endMs: 534000}];
  old.publish(entries); old.reacquired(182, entries, 531000, 533000, 'scene');
  const next = new CaptionPresentation(); next.reconnect(old, 182, 'scene');
  assert.equal(next.holding(182, 'scene'), true);
  assert.equal(next.held.entry.text, entries[0].text);
  assert.equal(next.held.entry.endMs, null);
  assert.notEqual(next.held.entry.id, entries[0].id);
  assert.equal(next.revise({itemId: 'deepgram-0', text: '新串流同編號的文字', startMs: 0, endMs: 1000}), false);
  next.advance(183, 'scene'); assert.equal(next.held, null);
});

test('the real server retains a pending caption handoff and operator lock across tracking recovery', t => {
  const f = setup(t, ['國王最喜歡的就是歌手', '另一句台詞']);
  f.say('國王最喜歡的就是歌手', 'anchor', 0, 1000);
  f.say('今天突然想先跟大家聊一件事情', 'x', 1100, 3000, 3000);
  f.say('外面下著雨不曉得大家帶了傘沒有', 'y', 4000, 8000, 8000);
  f.viewer();
  f.say('國王最喜歡的就是歌手', 'return', 8500, 10500, 11000, {isFinal: false});
  f.viewer();
  f.say('國王最喜歡的就是歌手', 'return', 8500, 10500, 13000);
  assert.equal(f.state().performance.pendingReturnIndex, 0);
  f.follower().lock = 'script'; f.restartTracking();
  f.restartTracking(); // Both the start handler and provider initialization reset the clock.
  assert.equal(f.follower().lock, 'script');
  assert.equal(f.state().performance.pendingReturnIndex, 0);
  assert.equal(f.viewer().text, '國王最喜歡的就是歌手');
});

test('capture recovery never carries an operator lock or consumed overlap state to another cell with identical text', t => {
  const f = setup(t, ['國王最喜歡的就是歌手', '另一句台詞']);
  f.say('國王最喜歡的就是歌手', 'anchor', 0, 1000);
  f.follower().lock = 'script'; f.follower().usedGroups.add('old-cell'); f.follower().rates = [4];
  f.session.selectedCellId = f.session.cells[1].id;
  f.restartTracking();
  assert.equal(f.follower().lock, 'auto'); assert.equal(f.follower().usedGroups.size, 0);
  assert.deepEqual(f.follower().rates, []);
});

test('a stable short paraphrase can verify the prepared next cue, without semantic completion or invented clocks', async t => {
  const f = setup(t, ['你們的論點', '既是對的', '又是錯的', '我們還要繼續討論']);
  let calls = 0;
  f.enableSemantic(async () => {calls++; return {choices: [{message: {content: JSON.stringify({ambiguous: false,
    matches: [{index: 1, matchConfidence: .95, firstWordId: 0, lastWordId: 0}]})}}]}});
  f.say('你們的論', 'anchor', 0, 1000);
  f.say('其實對的', 'paraphrase', 1500, 2500, 2500,
    {words: [{word: '其實對的', startMs: 1500, endMs: 2500}]}); await flush();
  assert.equal(calls, 1);
  assert.equal(f.session.currentIndex, 1);
  assert.equal(f.state().lastDecision.supportSource, 'joint_text_semantic');
  assert.equal(f.state().lastDecision.transcriptAudioEndMs, 2500);
  assert.equal(f.state().armedIndex, null);
  assert.equal(f.state().progress, 0);
  assert.ok(f.events.some(e => e.reason === 'prepared_short_text_semantic'));
  f.say('也是錯的', 'next', 2600, 3500);
  assert.equal(f.session.currentIndex, 2);
});

test('short semantic assistance cannot use negation changes, generic fragments, missing clocks or unprepared distant positions', async t => {
  for (const [text, words, index] of [
    ['其實不對的', true, 1], ['對的', true, 1], ['其實對的', false, 1], ['其實對的', true, 2],
  ]) {
    const f = setup(t, ['你們的論點', '既是對的', '又是錯的']);
    f.enableSemantic(async () => ({choices: [{message: {content: JSON.stringify({ambiguous: false,
      matches: [{index, matchConfidence: .99, firstWordId: words ? 0 : null, lastWordId: words ? 0 : null}]})}}]}));
    f.say('你們的論', 'anchor', 0, 1000);
    f.say(text, 'negative', 1500, 2500, 2500, {words: words ? [{word: text, startMs: 1500, endMs: 2500}] : undefined});
    await flush();
    assert.equal(f.session.currentIndex, 0, text);
    assert.ok(!f.events.some(e => e.reason === 'prepared_short_text_semantic'));
  }
});

test('the new recording with equal-length ASR insertions/deletions keeps cue 15 then displays 16', () => {
  const recorded = require('./fixtures/cue-tail-revised.json'), tracker = createTracker();
  let index = recorded.initialIndex, protectedEnding = false, nextOpening = false;
  for (const event of recorded.events) {
    const result = followTranscript(tracker, recorded.lines, index, {...event, streamId: 'revised'});
    if (Number.isInteger(result.index)) index = result.index;
    if (event.text === '悲傷的人都能夠感到快樂') {assert.equal(index, 14); protectedEnding = true;}
    if (event.text === '另外') {assert.equal(index, 15); nextOpening = true;}
  }
  assert.equal(protectedEnding, true); assert.equal(nextOpening, true);
});

test('fresh short openings cannot inherit an almost-expired fallback timer or become confirmed evidence', () => {
  const p = new PerformanceFollower();
  p.bind(normalizePerformanceSettings({automaticLive: true}), 'scene', [{text: '前一格'}, {text: '我們該怎麼做呢'}]);
  p.originIndex = 0;
  const e = (itemId, startMs, endMs, text) => ({itemId, startMs, endMs, audioMs: endMs, text, isFinal: true});
  p.observe(e('old-a', 0, 2000, '先前完全無法對齊的話'), null, 1000);
  p.observe(e('old-b', 2000, 4000, '接著持續說出不同內容'), null, 5400);
  p.opening(1, 4100, 5479);
  p.observe(e('opening', 4100, 4500, '我們'), null, 5479);
  assert.equal(p.maybeLive(4560, 5607), null, 'the old 4.5-second mismatch cannot switch a fresh cue in 128ms');
  assert.equal(p.lastReliable, null); assert.equal(p.lastConfirmedEnd, -1);
  assert.equal(p.mismatch.items.size, 1);
});

for (const rehearsal of require('./fixtures/phrase-rehearsal.json')) {
  test(`locked script recovers recorded ${rehearsal.name} paraphrase through the server`, t => {
    const f = setup(t, rehearsal.lines.map(l => l.text));
    assert.equal(f.event('performance:action', {action: 'lock-script'}).ok, true);
    for (const e of rehearsal.events)
      f.say(e.text, e.itemId, e.audioStartMs, e.audioEndMs, e.audioEndMs, {words: e.words, isFinal: e.isFinal});
    const index = rehearsal.name === 'merchant' ? 3 : 2;
    assert.equal(f.session.currentIndex, index);
    assert.notEqual(f.session.automaticLive, true);
    assert.equal(f.follower().lastReliable.index, index);
    assert.equal(f.tracker().preparedIndex, null);
    assert.equal(f.state().lastDecision.source, 'correction');
    assert.equal(f.viewer().text, rehearsal.lines[index].text);
  });
}
