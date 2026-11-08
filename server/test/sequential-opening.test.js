const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createTracker, followTranscript, followAudio, applySemanticLocation} = require('../src/auto-follow');

function show(texts, index = 0) {
  const lines = texts.map(text => typeof text === 'string' ? {text} : text), tracker = createTracker();
  let current = index;
  const say = (text, options = {}) => {
    const result = followTranscript(tracker, lines, current,
      {streamId: 's', itemId: 'a', text, startMs: 0, endMs: 1000, ...options});
    if (Number.isInteger(result.index)) current = result.index;
    return result;
  };
  return {tracker, lines, say, index: () => current};
}

test('the selected displayed cue is the starting occurrence even when another copy exists', () => {
  const s = show(['現在第一幕開始', '你準備好了嗎', '我們一起出發', '你準備好了嗎', '我們一起回家'], 3);
  assert.equal(s.say('你準備好了嗎').index, 3);
  assert.equal(s.tracker.preparedIndex, 4);
  const result = s.say('我', {itemId: 'next', startMs: 1100, endMs: 1200});
  assert.equal(result.index, 4); assert.equal(result.shortOpening.characters, 1);
});

test('normal partial acceptance prepares the next cue without a confirmed ending, uniqueness, pause or final', () => {
  const s = show(['先把這件事情說清楚', '你怎麼會在這裡', '你怎麼會知道這件事']);
  const verified = s.say('先把這件');
  assert.equal(verified.index, 0); assert.equal(verified.completed, false);
  assert.equal(s.tracker.preparedIndex, 1);
  const first = s.say('你怎', {itemId: 'b', startMs: 1100, endMs: 1250});
  assert.equal(first.index, 1); assert.equal(first.shortOpening.characters, 2);
  assert.equal(first.completed, false); assert.deepEqual(first.spans, []);
  assert.equal(s.tracker.preparedIndex, null, 'a short trigger does not prepare a chain of guesses');
  assert.equal(s.tracker.armedIndex, null);
  assert.equal(s.say('你', {itemId: 'c', startMs: 1300, endMs: 1400}).index, undefined);
  assert.equal(s.index(), 1);
});

test('a shared one-character opening triggers without scanning other candidates', () => {
  const s = show(['她說請你先不要離開這裡', '請你先坐下來喝杯茶', '請你先看著我']);
  s.say('她說請你');
  const result = s.say('請', {itemId: 'b', startMs: 1100, endMs: 1200});
  assert.equal(result.index, 1);
  assert.equal(result.shortOpening.text, '請');
});

test('an already received full repeat uses full matching, while a two-character shared opening still triggers immediately', () => {
  const s = show(['目前這句需要核對位置', '目前這句後面還有其他內容']); s.say(s.lines[0].text);
  assert.equal(s.say(s.lines[0].text, {itemId: 'repeat', startMs: 1100, endMs: 2000}).index, 0);
  const short = show(['好啊', '好啊我們就這麼決定']); short.say('好啊');
  assert.equal(short.say('好啊', {itemId: 'next', startMs: 1100, endMs: 1200}).shortOpening.index, 1);
});

test('current-cue verification is required before short openings can keep advancing', () => {
  const s = show(['目前這句需要核對位置', '你還記得我們的約定', '走向明天的道路']);
  assert.equal(s.say('你', {itemId: 'unlocated'}).index, undefined);
  s.say('目前這句需要核對位置', {itemId: 'a', startMs: 1000, endMs: 2000});
  s.say('你', {itemId: 'b', startMs: 2100, endMs: 2200});
  assert.equal(s.tracker.preparedIndex, null);
  assert.equal(s.say('走', {itemId: 'c', startMs: 2300, endMs: 2400}).index, undefined);
  s.say('你還記得我們的約定', {itemId: 'd', startMs: 2500, endMs: 3500});
  assert.equal(s.tracker.preparedIndex, 2);
  assert.equal(s.say('走', {itemId: 'e', startMs: 3600, endMs: 3700}).index, 2);
});

test('a selected direction waits for its following dialogue, never for the first line of the play', () => {
  const s = show(['這是上一場的台詞', {text: '（空白舞台）', type: 'direction'},
    {text: '（演員走上台）', type: 'direction'}, '你終於來了', '你要去哪裡'], 1);
  const result = s.say('你', {itemId: 'start', startMs: 60000, endMs: 60100});
  assert.equal(result.index, 3); assert.equal(result.shortOpening.fromIndex, 1);
});

test('a complete one-character cue can be verified after its short trigger without arming from a partial long cue', () => {
  const s = show(['目前這句已經核對好了', '好', '接著繼續說下去']); s.say('目前這句已經核對好了');
  assert.equal(s.say('好', {itemId: 'b', startMs: 1100, endMs: 1200}).index, 1);
  const checked = s.say('好', {itemId: 'b', startMs: 1100, endMs: 1200, isFinal: true});
  assert.equal(checked.index, 1); assert.equal(checked.shortOpening, undefined);
  assert.equal(s.tracker.preparedIndex, 2);
});

test('same-item growth can trigger from new words without reusing a revised old prefix', () => {
  const s = show(['先把這件事情說清楚', '你怎麼會在這裡']);
  s.say('先把這件');
  const result = s.say('先把這件你', {endMs: 1300,
    words: [{word: '先把這件', start: 0, end: 1}, {word: '你', start: 1.1, end: 1.3}]});
  assert.equal(result.index, 1); assert.equal(result.evidence.startMs, 1100);
  assert.equal(result.evidence.endMs, 1300); assert.equal(result.shortOpening.firstWordId, 1);
  const revised = show(['先把這件事情說清楚', '先看著我']); revised.say('先把這件');
  assert.equal(revised.say('先看著我', {endMs: 1000,
    words: [{word: '先看著我', start: 0, end: 1}]}).shortOpening, undefined);
});

test('same-item text-only growth uses its exact consumed prefix while overlapping new items require word clocks', () => {
  const s = show(['目前這句要慢慢說清楚', '可是我答應過你']);
  s.say('目前這句');
  assert.equal(s.say('目前這句可', {endMs: 1200}).shortOpening.text, '可');
  const overlap = show(['目前這句要慢慢說清楚', '可是我答應過你']); overlap.say('目前這句');
  assert.equal(overlap.say('可', {itemId: 'b', startMs: 900, endMs: 1200}).shortOpening, undefined);
});

test('a short expectation can be corrected back by later full matching words in the same ASR item', () => {
  const s = show(['先把這件事情慢慢說清楚', '事情終究會變得更好']);
  s.say('先把這件');
  assert.equal(s.say('先把這件事', {endMs: 1200}).index, 1);
  const final = s.say('先把這件事情慢慢說清楚', {endMs: 2500, isFinal: true});
  assert.equal(final.index, 0); assert.equal(s.tracker.prediction, null);
  assert.equal(s.tracker.preparedIndex, 1);
});

test('old finalization, manual audio fences, script edits and provider changes cannot reuse preparation', () => {
  const s = show(['目前這句要慢慢說清楚', '可是我答應過你']);
  s.say('目前這句');
  const trigger = s.say('可', {itemId: 'b', startMs: 1100, endMs: 1200});
  assert.equal(trigger.index, 1);
  assert.equal(s.say('可', {itemId: 'b', startMs: 1100, endMs: 1200, isFinal: true}).ignored, true);
  for (const change of ['script', 'provider']) {
    const f = show(['目前這句要慢慢說清楚', '可是我答應過你']); f.say('目前這句');
    if (change === 'script') f.lines[0].text = '改成完全不同的台詞';
    assert.equal(f.say('可', {itemId: 'b', startMs: 1100, endMs: 1200,
      ...(change === 'provider' ? {streamId: 'new'} : {})}).shortOpening, undefined);
  }
  const fenced = show(['目前這句要慢慢說清楚', '可是我答應過你']); fenced.say('目前這句');
  fenced.tracker.ignoreBeforeMs = 3000;
  assert.equal(fenced.say('可', {itemId: 'b', startMs: 1100, endMs: 1200}).ignored, true);
  const edited = show(['目前這句要慢慢說清楚', '可是我答應過你']); edited.say('目前這句');
  edited.lines[0].text = '改成完全不同的台詞';
  edited.say('過去的舊結果', {itemId: 'stale', startMs: -100, endMs: 900});
  assert.equal(edited.say('可', {itemId: 'new', startMs: 1100, endMs: 1200}).shortOpening, undefined);
  const direction = show([{type: 'direction', text: '（舞台指示）'}, '可是我答應過你']);
  assert.equal(direction.say('', {}).ignored, true);
});

test('a quiet pause does not disarm a confirmed position and sound alone cannot advance it', () => {
  const s = show(['目前這句要慢慢說清楚', '可是我答應過你']); s.say('目前這句要慢慢說清楚');
  for (let ms = 1020; ms <= 1200; ms += 20) followAudio(s.tracker, s.lines, 0, {level: 0, durationMs: 20, endMs: ms});
  assert.equal(followAudio(s.tracker, s.lines, 0, {level: .1, durationMs: 40, endMs: 1240}).index, undefined);
  assert.equal(s.say('可', {itemId: 'b', startMs: 60000, endMs: 60100}).index, 1);
});

test('semantic recovery prepares the next short opening while music remains an explicit boundary', () => {
  const s = show(['目前的位置完全不同', '這是改寫過的長句', '接著我們繼續說下去']); s.say('目前的位置');
  applySemanticLocation(s.tracker, s.lines, 1, {itemId: 'semantic', text: '用另一種說法說明', startMs: 1100, endMs: 2000});
  const result = followTranscript(s.tracker, s.lines, 1,
    {streamId: 's', itemId: 'next', text: '接', startMs: 2100, endMs: 2200});
  assert.equal(result.index, 2);
  const music = show(['目前的位置完全不同', {text: '音樂開始', music: true}, '接著我們繼續說下去']); music.say('目前的位置');
  assert.equal(music.tracker.preparedIndex, null);
  assert.equal(music.say('接', {itemId: 'b', startMs: 1100, endMs: 1200}).shortOpening, undefined);
  const stage = show([{text: '（舞台指示）', type: 'direction'},
    {text: '（配樂）', type: 'direction', music: true}, '接著我們繼續說下去']);
  assert.equal(stage.say('接').shortOpening, undefined);
});

test('completed cue advances on fresh speech that does not match the expected opening, then verifies afterwards', () => {
  const s = show(['目前這句已經說完了', '你還記得我們的約定', '接下來一起出發']);
  const complete = s.say(s.lines[0].text);
  assert.equal(complete.completed, true);
  const next = s.say('欸', {itemId: 'b', startMs: 1100, endMs: 1200});
  assert.equal(next.index, 1);
  assert.equal(next.shortOpening.text, '欸');
  assert.equal(next.completed, false);
  assert.equal(s.tracker.preparedIndex, null);
  assert.equal(s.say('隨便', {itemId: 'c', startMs: 1300, endMs: 1400}).index, undefined);
  assert.equal(s.say(s.lines[1].text, {itemId: 'd', startMs: 1500, endMs: 2500}).completed, true);
  assert.equal(s.say('嗯', {itemId: 'e', startMs: 2600, endMs: 2700}).index, 2);
});

test('a direction starts on any new spoken text; unfinished dialogue cannot advance on unrelated speech', () => {
  const s = show([{type: 'direction', text: '空白舞台'}, '從前從前有個國王']);
  assert.equal(s.say('嗯', {itemId: 'start', startMs: 100, endMs: 200}).index, 1);
  const partial = show(['先把這件事情說清楚', '你怎麼會在這裡']);
  partial.say('先把這件');
  assert.equal(partial.say('事情', {itemId: 'b', startMs: 1100, endMs: 1200}).shortOpening, undefined);
});

test('completed cue requires new source speech, not duplicate text or retimed old words', () => {
  const s = show(['目前這句已經說完了', '你還記得我們的約定']);
  s.say(s.lines[0].text);
  assert.equal(s.say(s.lines[0].text, {isFinal: true}).shortOpening, undefined);
  const stale = s.say('改寫之前文字', {itemId: 'b', startMs: 0, endMs: 1200,
    words: [{word: '改寫之前文字', start: 0, end: 1}]});
  assert.equal(stale.shortOpening, undefined);
});

test('completed same-item speech advances on extra words regardless of their content', () => {
  const s = show(['目前這句已經說完了', '接下來的劇本台詞']);
  s.say(s.lines[0].text);
  const result = s.say(s.lines[0].text + '欸等等', {endMs: 1300,
    words: [{word: s.lines[0].text, start: 0, end: 1}, {word: '欸等等', start: 1.1, end: 1.3}]});
  assert.equal(result.index, 1);
  assert.equal(result.shortOpening.text, '欸等');
  assert.equal(result.evidence.startMs, 1100);
});

test('an expectation triggered by unrelated speech can be corrected by a later verified location', () => {
  const s = show(['目前這句已經說完了', '這是預期的下一格內容', '演員實際跳到這句很清楚的台詞']);
  s.say(s.lines[0].text);
  assert.equal(s.say('嗯', {itemId: 'b', startMs: 1100, endMs: 1200}).index, 1);
  const correction = s.say(s.lines[2].text, {itemId: 'c', startMs: 1300, endMs: 2500, isFinal: true});
  assert.equal(correction.index, 2);
  assert.equal(correction.shortOpening, undefined);
  assert.equal(s.tracker.prediction, null);
});

test('a single timed batch can complete the current cue and trigger its unrelated next speech', () => {
  const s = show(['目前這句已經說完了', '接下來的劇本台詞']);
  const result = s.say(s.lines[0].text + '欸等等', {endMs: 1300,
    words: [{word: s.lines[0].text, start: 0, end: 1}, {word: '欸等等', start: 1.1, end: 1.3}]});
  assert.equal(result.index, 1);
  assert.equal(result.shortOpening.text, '欸等');
  assert.equal(result.evidence.startMs, 1100);
});
