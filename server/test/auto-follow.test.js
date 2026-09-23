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

test('confirmed ending advances at onset before recognition and only predicts once', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你', '我們走吧']);
  s.transcript('我一直以為你不會再回來', { isFinal: true });
  assert.equal(s.tracker.armedIndex, 1);
  s.audio(0.001, 1000, 10);
  s.audio(0.08, 1200, 1);
  assert.equal(s.index(), 0);
  s.audio(0.08, 1220, 2);
  assert.equal(s.index(), 1);
  assert.equal(s.tracker.prediction.index, 1);
  s.audio(0.001, 1400, 10);
  s.audio(0.08, 1600, 5);
  assert.equal(s.index(), 1);
  s.transcript('可是', { itemId: 'b', startMs: 1200, endMs: 1350 });
  assert.equal(s.index(), 1);
  assert.equal(s.tracker.prediction, null);
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

test('verified sequence can use a shared opening without waiting for unique words', () => {
  const s = show(['所有的人都已經離開了', '你怎麼會在這裡', '你怎麼會知道這件事']);
  s.transcript(s.lines[0].text, { isFinal: true });
  const result = s.transcript('你怎麼會', { itemId: 'b', startMs: 1000, endMs: 1500 });
  assert.equal(result.status, 'advanced');
  assert.equal(s.index(), 1);
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

test('onset checks only the two relevant records without rebuilding a large script', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你', ...Array(1000).fill('其他無關內容')]);
  s.transcript(s.lines[0].text, { isFinal: true });
  const cached = s.tracker.script;
  let reads = 0;
  const firstText = s.lines[0].text, secondText = s.lines[1].text;
  Object.defineProperty(s.lines[0], 'text', { get() { reads++; return firstText; } });
  Object.defineProperty(s.lines[1], 'text', { get() { reads++; return secondText; } });
  for (const line of s.lines.slice(2)) {
    Object.defineProperty(line, 'text', { get() { throw new Error('audio scanned unrelated script'); } });
  }
  assert.doesNotThrow(() => { s.audio(0.001, 1000, 10); s.audio(0.1, 1200, 10); });
  assert.equal(reads, 2);
  assert.equal(s.tracker.script, cached);
  assert.equal(s.index(), 1);
});

test('startup still waits when an opening has multiple possible locations', () => {
  const s = show(['所有的人都已經離開了', '你怎麼會在這裡', '你怎麼會知道這件事']);
  assert.equal(s.transcript('你怎麼會').status, 'searching');
  assert.equal(s.index(), 0);
  assert.ok(s.tracker.candidates.length > 1);
});

test('delaying ASR by two seconds does not delay the armed onset decision', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript(s.lines[0].text, { isFinal: true });
  s.audio(0.001, 1000, 10);
  const decision = s.audio(0.08, 1200, 2);
  assert.equal(decision.index, 1);
  assert.equal(decision.onsetMs, 1200);
  assert.equal(s.tracker.prediction.decidedAudioMs, 1240);
  s.audio(0.08, 1240, 98);
  assert.equal(s.index(), 1);
  s.transcript(s.lines[1].text, { itemId: 'b', startMs: 1200, endMs: 3100, isFinal: true });
  assert.equal(s.index(), 1);
  assert.equal(s.tracker.prediction, null);
});

test('late previous final cannot undo a prediction or enable another prediction', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你', '我們現在一起回家']);
  s.transcript(s.lines[0].text);
  s.audio(0.001, 1000, 10); s.audio(0.08, 1200, 2);
  assert.equal(s.transcript(s.lines[0].text, { endMs: 1400, isFinal: true }).ignored, true);
  assert.equal(s.tracker.items.get('a').final, true);
  s.audio(0.001, 1400, 10); s.audio(0.08, 1600, 2);
  assert.equal(s.index(), 1);
  assert.equal(s.tracker.armedIndex, null);
});

test('newer speech can correct a prediction back to an actually repeated line', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript(s.lines[0].text, { isFinal: true });
  s.audio(0.001, 1000, 10); s.audio(0.08, 1200, 2);
  const result = s.transcript(s.lines[0].text, { itemId: 'repeat', startMs: 1200, endMs: 2300, isFinal: true });
  assert.equal(result.status, 'corrected');
  assert.equal(s.index(), 0);
  assert.equal(s.tracker.prediction, null);
});

test('a partial verification cannot arm another onset until its ending is heard', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你', '我們現在一起回家']);
  s.transcript(s.lines[0].text, { isFinal: true });
  s.audio(0.001, 1000, 10); s.audio(0.08, 1200, 2);
  s.transcript('可是', { itemId: 'b', startMs: 1200, endMs: 1450 });
  s.audio(0.001, 1450, 10); s.audio(0.08, 1650, 2);
  assert.equal(s.index(), 1);
  s.transcript(s.lines[1].text, { itemId: 'b', startMs: 1200, endMs: 2200, isFinal: true });
  s.audio(0.001, 2200, 10); s.audio(0.08, 2400, 2);
  assert.equal(s.index(), 2);
});

test('weak interim revision does not discard a recently verified ending', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript(s.lines[0].text, { isFinal: true });
  s.transcript('科', { itemId: 'b', startMs: 1100, endMs: 1150 });
  assert.equal(s.tracker.armedIndex, 1);
  s.audio(0.001, 1000, 10); s.audio(0.08, 1200, 2);
  assert.equal(s.index(), 1);
});

test('expired and pre-ending onsets never predict', () => {
  const s = show(['我一直以為你不會再回來', '可是我答應過你']);
  s.transcript(s.lines[0].text, { isFinal: true });
  s.audio(0.001, 100, 10); s.audio(0.08, 300, 2);
  assert.equal(s.index(), 0);
  s.audio(0.001, 15000, 10); s.audio(0.08, 15200, 2);
  assert.equal(s.index(), 0);
});

test('a long repeated cue can verify a known prediction without global uniqueness', () => {
  const repeated = '請你記得我們曾經一起許下永不分離的約定';
  const s = show(['所有的人都已經離開這個地方了', repeated, '今晚的星空非常美麗', repeated]);
  s.transcript(s.lines[0].text, { isFinal: true });
  s.audio(0.001, 1000, 10); s.audio(0.08, 1200, 2);
  assert.equal(s.index(), 1);
  const result = s.transcript(repeated, { itemId: 'b', startMs: 1200, endMs: 3000, isFinal: true });
  assert.equal(result.status, 'verified');
  assert.equal(s.tracker.prediction, null);
  assert.equal(s.tracker.armedIndex, 2);
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

function noisySequence() {
  const s = show(['大家今天終於重新聚在一起了', '可是我答應過你永遠不會離開',
    '請你先坐下來喝杯茶', '他想請你先一起討論事情']);
  s.transcript(s.lines[0].text);
  s.audio(0.001, 1000, 10); s.audio(0.08, 1200, 2);
  assert.equal(s.index(), 1);
  const weak = s.transcript('科是他打應過你', { itemId: 'b', startMs: 1200, endMs: 1800 });
  assert.equal(weak.status, 'searching');
  assert.ok(weak.candidate.confidence < 0.78);
  assert.equal(s.tracker.armedIndex, null);
  return s;
}

test('a low-score predicted cue does not block the next distinctive opening', () => {
  const s = noisySequence();
  s.audio(0.001, 1800, 10); s.audio(0.08, 2000, 2);
  assert.equal(s.index(), 1, 'low confidence cannot authorize another audio-only advance');
  const result = s.transcript('請你先', { itemId: 'c', startMs: 2000, endMs: 2250 });
  assert.equal(result.candidate.openingConfirmed, true);
  assert.equal(s.index(), 2, 'the next opening does not wait for the previous ending or final');
  assert.equal(s.tracker.prediction, null);
  assert.equal(s.tracker.armedIndex, null);
});

test('the next opening can grow after a noisy prefix in the same ASR item', () => {
  const s = noisySequence();
  s.transcript('科是他打應過你請', { itemId: 'b', startMs: 1200, endMs: 1900 });
  assert.equal(s.index(), 1);
  s.transcript('科是他打應過你請你', { itemId: 'b', startMs: 1200, endMs: 2000 });
  assert.equal(s.index(), 1);
  const result = s.transcript('科是他打應過你請你先', { itemId: 'b', startMs: 1200, endMs: 2100 });
  assert.equal(result.candidate.openingConfirmed, true);
  assert.equal(s.index(), 2);
});

test('pending full-script correction cannot veto a sequence opening', () => {
  const s = noisySequence();
  s.lines.push(...Array(30).fill({ text: '其他完全不同的台詞' }));
  s.lines[30] = { text: '今天外面忽然下起一場大雨' };
  // Establish the position again after editing, then give the correction lane
  // one plausible distant interim before returning to the actual next opening.
  s.transcript(s.lines[1].text, { itemId: 'verified', startMs: 2000, endMs: 3000, isFinal: true });
  s.transcript('今天外面忽然下起', { itemId: 'remote', startMs: 3100, endMs: 3800 });
  assert.equal(s.tracker.correction.status, 'pending');
  assert.equal(s.index(), 1);
  s.transcript('請你先', { itemId: 'next', startMs: 3900, endMs: 4200 });
  assert.equal(s.index(), 2);
});

test('full-script correction continues while sequence matching succeeds', () => {
  const s = show(['大家今天終於重新聚在一起了', '請你先坐下來喝杯茶',
    ...Array(30).fill('其他完全不相關的內容')]);
  s.lines[30].text = '請你先坐下來喝杯茶再告訴我真相';
  s.transcript(s.lines[0].text, { isFinal: true });
  s.transcript('請你先坐下來', { itemId: 'b', startMs: 1200, endMs: 2000 });
  assert.equal(s.index(), 1);
  assert.equal(s.tracker.correction.lastScanMs, 2000);
  assert.ok(s.tracker.correction.candidates.some(candidate => candidate.index === 30));
  s.transcript(s.lines[30].text, { itemId: 'b', startMs: 1200, endMs: 3000, isFinal: true });
  assert.equal(s.index(), 30);
  assert.equal(s.tracker.sequence.index, 30);
});

test('low-score updates do not keep an expired sequence alive', () => {
  const s = noisySequence();
  s.transcript('完全無關的臨時發言', { itemId: 'noise', startMs: 9000, endMs: 10000 });
  s.transcript('請你先', { itemId: 'late', startMs: 12000, endMs: 12500 });
  assert.equal(s.index(), 1);
  assert.equal(s.tracker.sequence, null);
});

test('an unverified boundary cannot use an opening shared by nearby cues', () => {
  const s = show(['所有的人都已經離開了', '你怎麼會在這裡', '你怎麼會知道這件事']);
  s.transcript('所有的人');
  s.transcript('你怎麼會', { itemId: 'b', startMs: 1200, endMs: 1500 });
  assert.equal(s.index(), 0);
});

test('sequence recovery does not treat a phrase inside the current cue as the next opening', () => {
  const s = show(['她說請你先不要離開這裡', '請你先坐下來喝杯茶']);
  s.transcript('她說請你');
  const result = s.transcript('請你先', { itemId: 'b', startMs: 1200, endMs: 1500 });
  assert.equal(result.status, 'searching');
  assert.equal(s.index(), 0);
});

test('editing or reconnecting clears a retained sequence before a short opening', () => {
  for (const reset of ['edit', 'reconnect']) {
    const s = noisySequence();
    if (reset === 'edit') s.lines[1].role = 'new role';
    s.transcript('請你先', { itemId: 'c', startMs: 2000, endMs: 2300,
      ...(reset === 'reconnect' ? { streamId: 's2' } : {}) });
    assert.equal(s.index(), 1);
    assert.equal(s.tracker.sequence, null);
  }
});

test('late previous results cannot reverse sequence recovery after a weak cue', () => {
  const s = noisySequence();
  s.transcript('請你先', { itemId: 'c', startMs: 2000, endMs: 2300 });
  const late = s.transcript(s.lines[1].text, { itemId: 'b', startMs: 1200, endMs: 1800, isFinal: true });
  assert.equal(late.ignored, true);
  assert.equal(s.index(), 2);
});

const recoveryLines = ['你怎麼現在才來這裡', '路上出了點事情', '到底發生什麼事情', '我的車子壞了', '我們明天搭火車回家'];

test('recent verified position catches up three cues from a complete interim', () => {
  const s = show(recoveryLines);
  s.transcript(recoveryLines[0], { isFinal: true });
  const result = s.transcript(recoveryLines[3], { itemId: 'b', startMs: 1100, endMs: 2400 });
  assert.equal(result.index, 3);
  assert.match(result.message, /追上附近字幕/);
});

test('catch-up does not authorize reverse jumps from a single interim', () => {
  const s = show(recoveryLines, 3);
  s.transcript(recoveryLines[3], { isFinal: true });
  s.transcript(recoveryLines[0], { itemId: 'b', startMs: 1100, endMs: 2400 });
  assert.equal(s.index(), 3);
});

test('a short noisy suffix cannot trigger catch-up', () => {
  const s = show(recoveryLines);
  s.transcript(recoveryLines[0], { isFinal: true });
  s.transcript('完全聽不清楚的雜訊車子壞了', { itemId: 'b', startMs: 1100, endMs: 2400 });
  assert.equal(s.index(), 0);
});

test('noisy prefix does not prevent nearby recovery using clear recent speech', () => {
  const s = show(recoveryLines);
  s.transcript(recoveryLines[0], { isFinal: true });
  s.transcript('亂碼噪聲完全聽不清楚我的車子壞了', { itemId: 'b', startMs: 1100, endMs: 2400 });
  assert.equal(s.index(), 3);
});

test('startup and expired positions still require confirmation for nearby jumps', () => {
  for (const expired of [false, true]) {
    const s = show(recoveryLines);
    if (expired) s.transcript(recoveryLines[0], { isFinal: true });
    s.transcript(recoveryLines[3], { itemId: 'b', startMs: 12000, endMs: 13000 });
    assert.equal(s.index(), 0);
  }
});

test('shared recent suffix cannot choose between repeated cues', () => {
  const s = show([...recoveryLines, recoveryLines[3]]);
  s.transcript(recoveryLines[0], { isFinal: true });
  s.transcript('亂碼噪聲完全聽不清楚我的車子壞了', { itemId: 'b', startMs: 1100, endMs: 2400, isFinal: true });
  assert.equal(s.index(), 0);
});

test('remote suffix recovery needs new matching evidence, not a revised noisy prefix', () => {
  const lines = [...recoveryLines, ...Array(25).fill('完全無關的其他內容'), '請大家立刻離開這個危險的地方'];
  const s = show(lines);
  s.transcript(lines[0], { isFinal: true });
  s.transcript('噪聲亂碼無法理解請大家立刻離開', { itemId: 'b', startMs: 1100, endMs: 2400 });
  assert.equal(s.index(), 0);
  s.transcript('更多噪聲亂碼無法理解請大家立刻離開', { itemId: 'b', startMs: 1100, endMs: 2900 });
  assert.equal(s.index(), 0);
  s.transcript('更多噪聲亂碼無法理解請大家立刻離開這個危險的地方', { itemId: 'b', startMs: 1100, endMs: 3500 });
  assert.equal(s.index(), lines.length - 1);
});
