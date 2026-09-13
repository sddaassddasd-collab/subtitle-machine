const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTracker, normalizeText, align, followTranscript, followAudio } = require('../src/auto-follow');

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

test('confirmed ending arms next cue, sustained onset predicts once', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你', '我們走吧']);
  s.transcript('我一直以為你不會再回來', { isFinal: true });
  assert.equal(s.tracker.armedIndex, 1);
  s.audio(0.001, 1000, 10);
  s.audio(0.08, 1200, 1);
  assert.equal(s.index(), 0);
  s.audio(0.08, 1220, 2);
  assert.equal(s.index(), 1);
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

test('previous final cannot undo an onset prediction', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript('我一直以為你不會再回來');
  s.audio(0.001, 1000, 10);
  s.audio(0.08, 1200, 2);
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
