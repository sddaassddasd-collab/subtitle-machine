const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTracker, prepareScript, normalizeText, align, followTranscript, followAudio } = require('../src/auto-follow');

function show(texts, index = 0) {
  const lines = texts.map(text => typeof text === 'string' ? { text } : text);
  const tracker = createTracker();
  let current = index;
  const transcript = (text, options = {}) => {
    const result = followTranscript(tracker, lines, current, {
      streamId: 's1', itemId: 'a', startMs: 0, endMs: 1000, text,
      isFinal: false, ...options,
    });
    if (Number.isInteger(result.index)) current = result.index;
    return result;
  };
  const audio = (level, start, count = 1) => {
    let result;
    for (let i = 0; i < count; i += 1) {
      result = followAudio(tracker, lines, current, { level, durationMs: 20, endMs: start + (i + 1) * 20 });
      if (Number.isInteger(result.index)) current = result.index;
    }
    return result;
  };
  return { tracker, lines, transcript, audio, index: () => current };
}

test('normalization supports Chinese scripts and removes directions/punctuation', () => {
  assert.equal(normalizeText('（小聲）「这里，是剧场！」'), normalizeText('這裡是劇場'));
});

test('word order matters', () => {
  const result = align('你愛我', [{ text: '我愛你' }], 0, 0);
  assert.ok(result.every(candidate => candidate.confidence < 0.78));
});

test('a one-character current cue is verifiable', () => {
  const s = show(['好', '我們現在出發']);
  assert.equal(s.transcript('好', { isFinal: true }).status, 'verified');
  assert.equal(s.tracker.progress, 1);
});

test('mid-line pauses and repeated loud sounds do not advance', () => {
  const s = show(['我今天真的不想再談這件事情', '請你先坐下']);
  s.transcript('我今天真的');
  s.audio(0.001, 1000, 10);
  s.audio(0.08, 1200, 5);
  s.audio(0.001, 1600, 10);
  s.audio(0.08, 1800, 5);
  assert.equal(s.index(), 0);
});

test('noise without a confirmed line ending never advances', () => {
  const s = show(['第一段開場白', '下一段']);
  s.audio(0.001, 0, 10);
  s.audio(0.3, 200, 5);
  assert.equal(s.index(), 0);
});

test('confirmed ending and sustained noise wait for a distinctive opening', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你', '我們走吧']);
  s.transcript('我一直以為你不會再回來', { isFinal: true });
  assert.equal(s.tracker.armedIndex, 1);
  s.audio(0.001, 1000, 10);
  s.audio(0.08, 1200, 1);
  assert.equal(s.index(), 0);
  s.audio(0.08, 1220, 2);
  assert.equal(s.index(), 0);
  s.transcript('可是', { itemId: 'b', startMs: 1200, endMs: 1350 });
  assert.equal(s.index(), 1);
  assert.ok(s.tracker.progress > 0 && s.tracker.progress < 1);
  s.audio(0.001, 1400, 10);
  s.audio(0.08, 1600, 5);
  assert.equal(s.index(), 1);
});

test('continuous speech crosses multiple cues in a single ASR item', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你', '我們走吧']);
  s.transcript('我一直以為你不會再回來');
  s.transcript('我一直以為你不會再回來可是我答應', { endMs: 1800 });
  assert.equal(s.index(), 1);
  s.transcript('我一直以為你不會再回來可是我答應過你我們走吧', { endMs: 2500, isFinal: true });
  assert.equal(s.index(), 2);
});

test('a line split over final fragments retains its position and ending', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript('我一直以為', { isFinal: true });
  s.transcript('你不會再回來', { itemId: 'b', startMs: 1000, endMs: 2000, isFinal: true });
  assert.equal(s.index(), 0);
  assert.equal(s.tracker.progress, 1);
  assert.equal(s.tracker.armedIndex, 1);
});

test('previous final cannot undo an opening-confirmed transition', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript('我一直以為你不會再回來');
  s.audio(0.001, 1000, 10);
  s.audio(0.08, 1200, 2);
  s.transcript('可是', { itemId: 'b', startMs: 1200, endMs: 1400 });
  assert.equal(s.index(), 1);
  s.transcript('我一直以為你不會再回來', { endMs: 1300, isFinal: true });
  assert.equal(s.index(), 1);
});

test('out of order final cannot override a newer item', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript('我一直以為你不會再回來');
  s.transcript('可是我答應過你', { itemId: 'b', startMs: 1000, endMs: 1800 });
  assert.equal(s.index(), 1);
  assert.equal(s.transcript('我一直以為你不會再回來', { isFinal: true }).ignored, true);
  assert.equal(s.index(), 1);
});

test('prefix final does not advance into a direction; complete final also waits for a cue', () => {
  const s = show(['歡迎大家來到我們的劇場演出', { type: 'direction', text: '燈光漸暗' }, '正式開始表演']);
  s.transcript('歡迎大家', { isFinal: true });
  assert.equal(s.index(), 0);
  assert.equal(s.tracker.armedIndex, null);
  s.transcript('來到我們的劇場演出', { itemId: 'b', startMs: 1000, endMs: 2000, isFinal: true });
  s.audio(0.001, 2000, 10);
  s.audio(0.08, 2200, 3);
  assert.equal(s.index(), 0);
  assert.equal(s.tracker.armedIndex, null);
});

test('music disables onset prediction', () => {
  const s = show([{ text: '我一直以為你不會再回來', music: true }, '可是我答應過你']);
  s.transcript('我一直以為你不會再回來', { isFinal: true });
  s.audio(0.001, 1000, 10); s.audio(0.08, 1200, 3);
  assert.equal(s.index(), 0);
});

test('a large jump reacquires beyond the old 18-line window', () => {
  const lines = Array.from({ length: 30 }, () => '這是完全不相干的內容');
  lines[25] = '現在我們終於抵達目的地';
  const s = show(lines);
  const result = s.transcript(lines[25], { isFinal: true });
  assert.equal(result.status, 'corrected');
  assert.equal(s.index(), 25);
});

test('distant interim match requires growing evidence, not duplicate messages', () => {
  const lines = Array.from({ length: 30 }, () => '這是完全不相干的內容');
  lines[25] = '現在我們終於抵達目的地';
  const s = show(lines);
  s.transcript('現在我們終於抵達');
  assert.equal(s.index(), 0);
  s.transcript('現在我們終於抵達', { endMs: 1500 });
  assert.equal(s.index(), 0);
  s.transcript(lines[25], { endMs: 2000 });
  assert.equal(s.index(), 25);
});

test('genuine backward jump from newer audio is allowed', () => {
  const lines = Array.from({ length: 30 }, () => '其他完全不同的話語');
  lines[2] = '請你記得我們曾經許下的約定';
  const s = show(lines, 25);
  s.transcript(lines[2], { itemId: 'new', startMs: 4000, endMs: 6000, isFinal: true });
  assert.equal(s.index(), 2);
});

test('repeated remote lines stay uncertain instead of guessing', () => {
  const s = show(['第一段開場白', '請你記得我們曾經許下的約定', '其他內容', '請你記得我們曾經許下的約定']);
  const result = s.transcript('請你記得我們曾經許下的約定', { isFinal: true });
  assert.equal(result.status, 'searching');
  assert.equal(s.index(), 0);
});

test('same item final cannot rewind a multi-cue interim', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript('我一直以為你不會再回來可是我答應過你');
  assert.equal(s.index(), 1);
  s.transcript('我一直以為你不會再回來', { isFinal: true, endMs: 1100 });
  assert.equal(s.index(), 1);
});

test('manual anchor rejects audio from before the correction', () => {
  const tracker = createTracker({ ignoreBeforeMs: 3000 });
  const result = followTranscript(tracker, [{ text: '開場白' }, { text: '正確位置' }], 1,
    { streamId: 's', itemId: 'old', startMs: 2000, endMs: 4000, text: '開場白', isFinal: true });
  assert.equal(result.ignored, true);
});

test('stream reconnect accepts a reset audio clock', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript('我一直以為你不會再回來', { startMs: 10000, endMs: 11000, isFinal: true });
  const result = s.transcript('可是我答應過你', { streamId: 's2', itemId: 'new', endMs: 500, isFinal: true });
  assert.equal(result.index, 1);
});

test('small omissions preserve ordered location', () => {
  const s = show(['我一直以為你真的不會再回來', '可是我答應過你']);
  const result = s.transcript('我一直以為你不會再回來');
  assert.equal(result.index, 0);
  assert.ok(result.candidate.confidence > 0.8);
});

test('final covering less audio than interim can still finalize the current position', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript('我一直以為你不會再回來', { endMs: 2000 });
  const result = s.transcript('我一直以為你不會再回來', { endMs: 1800, isFinal: true });
  assert.equal(result.status, 'verified');
  assert.equal(s.tracker.items.get('a').final, true);
});

test('provider ordering resolves equal timestamp items', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript('可是我答應過你', { itemId: 'b', order: 2 });
  assert.equal(s.index(), 1);
  assert.equal(s.transcript('我一直以為你不會再回來', { order: 1, isFinal: true }).ignored, true);
});

test('editing a prepared line invalidates onset prediction', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript('我一直以為你不會再回來', { isFinal: true });
  s.lines[1].text = '修改後的不同台詞';
  s.audio(0.001, 1000, 10); s.audio(0.08, 1200, 3);
  assert.equal(s.index(), 0);
});

test('late finals enrich history without moving the displayed cue', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript('我一直以為你不會再回來');
  s.transcript('可是我答應過你', { itemId: 'b', startMs: 1000, endMs: 1800 });
  s.transcript('我一直以為你不會再回來', { isFinal: true });
  assert.equal(s.index(), 1);
  assert.equal(s.tracker.items.get('a').final, true);
});

test('script analysis is reused across server clones and rebuilt after edits', () => {
  const lines = [{ text: '（小聲）我一直以為你不會再回來', role: '甲' },
    { text: '燈光轉暗', type: 'direction' }, { text: '可是我答應過你' }];
  const prepared = prepareScript(lines);
  assert.equal(prepared.entries[0].next, 2);
  assert.equal(prepared.entries[0].tail, '再回來');
  assert.equal(prepared.entries[1].text, '');
  assert.equal(prepareScript(lines.map(line => ({ ...line })), prepared), prepared);
  lines[2].text = '修改之後的台詞';
  const edited = prepareScript(lines, prepared);
  assert.notEqual(edited, prepared);
  assert.equal(edited.entries[2].opening, normalizeText(lines[2].text));
  lines[0].music = true;
  assert.notEqual(prepareScript(lines, edited), edited);
});

test('near-ending progress prepares the opening before the final words', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript('我一直以為你不會');
  assert.equal(s.tracker.preparedIndex, 1);
  assert.equal(s.tracker.armedIndex, null);
  assert.equal(s.tracker.openingHint, '可是我答應過你');
  s.audio(0.001, 1000, 10);
  s.audio(0.09, 1200, 3);
  assert.equal(s.index(), 0);
  const result = s.transcript('可是', { itemId: 'b', startMs: 1200, endMs: 1450 });
  assert.equal(result.candidate.openingConfirmed, true);
  assert.equal(s.index(), 1);
});

test('near-ending preparation alone does not authorize a two-character transition', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript('我一直以為你不會');
  s.transcript('可是', { itemId: 'b', startMs: 1200, endMs: 1400 });
  assert.equal(s.index(), 0);
});

test('one-character interim retains preparation until the opening becomes usable', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript(s.lines[0].text, { isFinal: true });
  s.transcript('可', { itemId: 'b', startMs: 1000, endMs: 1100 });
  assert.equal(s.index(), 0);
  assert.equal(s.tracker.preparedIndex, 1);
  const result = s.transcript('可是', { itemId: 'b', startMs: 1000, endMs: 1200 });
  assert.equal(result.candidate.openingConfirmed, true);
  assert.equal(s.index(), 1);
});

test('uninterrupted same-item speech confirms an opening without waiting for a pause', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  const first = s.lines[0].text;
  s.transcript(first);
  s.transcript(first + '可', { endMs: 1100 });
  assert.equal(s.index(), 0);
  const result = s.transcript(first + '可是', { endMs: 1200 });
  assert.equal(result.candidate.openingConfirmed, true);
  assert.equal(s.index(), 1);
});

test('shared openings retain multiple candidates until distinctive words arrive', () => {
  const s = show(['所有的人都已經離開了', '你怎麼會在這裡', '你怎麼會知道這件事']);
  s.transcript(s.lines[0].text, { isFinal: true });
  const ambiguous = s.transcript('你怎麼會', { itemId: 'b', startMs: 1000, endMs: 1500 });
  assert.equal(ambiguous.status, 'searching');
  assert.equal(s.index(), 0);
  assert.ok(s.tracker.candidates.some(candidate => candidate.index === 1));
  assert.ok(s.tracker.candidates.some(candidate => candidate.index === 2));
  s.transcript('你怎麼會在', { itemId: 'b', startMs: 1000, endMs: 1650 });
  assert.equal(s.index(), 1);
});

test('startup does not assume the selected occurrence of a repeated remote line is correct', () => {
  const lines = Array.from({ length: 40 }, () => '其他內容完全不相關');
  lines[0] = lines[32] = '請你記得我們曾經許下的約定';
  const s = show(lines);
  assert.equal(s.transcript(lines[0], { isFinal: true }).status, 'searching');
  assert.equal(s.tracker.located, false);
  assert.ok(s.tracker.candidates.some(candidate => candidate.index === 32));
});

test('unexpected speech cancels preparation and a unique skipped cue reacquires', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你',
    '天上的星星全部消失不見', '請大家立刻離開這個危險的地方']);
  s.transcript(s.lines[0].text, { isFinal: true });
  s.transcript('沒有寫在劇本裡的臨時發言', { itemId: 'b', startMs: 1200, endMs: 1800 });
  assert.equal(s.tracker.preparedIndex, null);
  assert.equal(s.index(), 0);
  s.transcript('請大家立刻離開', { itemId: 'c', startMs: 2000, endMs: 2600 });
  assert.equal(s.index(), 0);
  const result = s.transcript('請大家立刻離開這個危險', { itemId: 'c', startMs: 2000, endMs: 2900 });
  assert.equal(result.status, 'corrected');
  assert.equal(s.index(), 3);
});

test('short openings cannot use an expired preparation', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript(s.lines[0].text, { isFinal: true });
  s.transcript('可是', { itemId: 'b', startMs: 15000, endMs: 15500 });
  assert.equal(s.index(), 0);
});

test('editing subtitles invalidates preparation before interpreting the next transcript', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript(s.lines[0].text, { isFinal: true });
  const script = s.tracker.script;
  s.lines[1].text = '完全不同的下一句話';
  s.transcript('可是', { itemId: 'b', startMs: 1000, endMs: 1200 });
  assert.equal(s.index(), 0);
  assert.equal(s.tracker.preparedIndex, null);
  assert.notEqual(s.tracker.script, script);
});

test('audio packets never read or rebuild script contents, even after a confirmed ending', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript(s.lines[0].text, { isFinal: true });
  Object.defineProperty(s.lines[0], 'text', { get() { throw new Error('audio read script'); } });
  assert.doesNotThrow(() => { s.audio(0.001, 1000, 10); s.audio(0.1, 1200, 10); });
  assert.equal(s.index(), 0);
});

test('a distant exact line can beat a highly similar local line after tracking starts', () => {
  const lines = Array.from({ length: 35 }, () => '其他台詞完全不相關');
  lines[0] = '大家今天終於重新聚在一起了';
  lines[1] = '請你記得我們曾經一起許下的美麗約定';
  lines[30] = '請你記得我們曾經一起許下的永遠約定';
  const s = show(lines);
  s.transcript(lines[0], { isFinal: true });
  s.transcript(lines[30], { itemId: 'b', startMs: 2000, endMs: 3500, isFinal: true });
  assert.equal(s.index(), 30);
});

test('changing the next cue to music disables early opening confirmation', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript(s.lines[0].text, { isFinal: true });
  s.lines[1].music = true;
  s.transcript('可是', { itemId: 'b', startMs: 1200, endMs: 1400 });
  assert.equal(s.index(), 0);
  assert.equal(s.tracker.preparedIndex, null);
});
