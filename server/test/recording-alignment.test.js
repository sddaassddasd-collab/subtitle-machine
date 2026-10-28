const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const {alignSegments, hashText, wordTimeline} = require('../src/recording-alignment');
const {fitCalibration, toPlayback, toAnalysis, timingDiagnostics} = require('../src/recording-timing');
const {makeWindow, validateMatches, improveAlignment} = require('../src/recording-ai-alignment');
const lines = texts => texts.map((text, i) => ({id: `cue-${i}`, type: 'dialogue', text}));
const words = (text, start = 0, step = 0.2) => text.split('').map((word, i) => ({word,
  start: start + i * step, end: start + (i + 1) * step, confidence: 0.99}));

test('one or two character errors locate whole short and long cues using surrounding lines', () => {
  const script = lines(['今晚演出就要開始了', '你去哪裡', '別忘記帶上那件外套', '我們明天一起去看戲', '到了門口請記得等我']);
  const timeline = [...words(script[0].text, 1), ...words('你去那裡', 4), ...words(script[2].text, 6),
    ...words('我們明天一齊去看細', 10), ...words(script[4].text, 14)];
  const cuts = alignSegments(script, timeline, 20);
  assert.equal(cuts[1].status, 'review'); assert.equal(cuts[1].start, 4); assert.equal(cuts[1].end, 4.8);
  assert.equal(cuts[3].status, 'review'); assert.equal(cuts[3].start, 10); assert.equal(cuts[3].end, 11.8);
  assert.match(cuts[1].reviewReason, /差異/);
});

test('a distant exact repeat cannot displace a near fuzzy cue between distinctive neighbours', () => {
  const script = lines(['今晚演出就要開始了', '我們明天一起去看戲', '到了門口請記得等我']);
  const timeline = [...words(script[0].text, 1), ...words('我們明天一齊去看戲', 4), ...words(script[2].text, 7),
    ...words(script[1].text, 600)];
  const cuts = alignSegments(script, timeline, 620);
  assert.equal(cuts[1].start, 4); assert.equal(cuts[1].status, 'review');
  assert.equal(cuts[2].start, 7);
});

test('unresolved repeated takes remain reviewable and long silent spans are never treated as complete dialogue', () => {
  const script = lines(['我們明天一起去看戲']);
  const repeated = alignSegments(script, [...words(script[0].text, 10), ...words(script[0].text, 600)], 620);
  assert.equal(repeated[0].status, 'review'); assert.match(repeated[0].reviewReason, /重複/);
  const discontinuous = alignSegments(script, [...words('我們明天', 0), ...words('一起去看戲', 500)], 510);
  assert.equal(discontinuous[0].status, 'unmatched');
});

test('manual anchors stay byte-for-byte intact and local realignment leaves other cues untouched', () => {
  const script = lines(['第一句台詞先說完', '你去哪裡', '最後請記得等我']);
  const timeline = [...words(script[0].text, 1), ...words('你去那裡', 4), ...words(script[2].text, 6), ...words('你去哪裡', 100)];
  const locked = {lineId: script[0].id, textHash: hashText(script[0]), start: 0.9, end: 3, status: 'manual', confidence: 1};
  const untouched = {lineId: script[2].id, textHash: hashText(script[2]), start: 6, end: 8, status: 'auto', confidence: 1};
  const result = alignSegments(script, timeline, 120, null, {previousSegments: [locked, untouched], lineIds: [script[1].id]});
  assert.deepEqual(result[0], locked); assert.deepEqual(result[2], untouched); assert.equal(result[1].start, 4);
  const changedScript = structuredClone(script); changedScript[2].text = '字幕在範圍外被修改';
  const local = alignSegments(changedScript, timeline, 120, null, {previousSegments: [locked, untouched], lineIds: [script[1].id]});
  assert.deepEqual(local[2], untouched);
});

test('clock correction fixes constant offsets and three-hour linear drift without changing source ASR', () => {
  const source = [...words('開場', 10), ...words('結尾', 10800)];
  const original = structuredClone(source);
  const fixed = fitCalibration([{wordId: 0, time: 12}], source, 10810, 10820);
  assert.equal(toPlayback(600, fixed), 602);
  const corrected = fitCalibration([{wordId: 0, time: 10 * 1.001 + 2},
    {wordId: 2, time: 10800 * 1.001 + 2}], source, 10810, 10830);
  assert.equal(corrected.scale, 1.001); assert.equal(corrected.offset, 2);
  assert.equal(toPlayback(10800, corrected), 10812.8); assert.equal(toAnalysis(10812.8, corrected), 10800);
  const result = alignSegments(lines(['開場', '結尾']), source, 10830, null, {analysisDuration: 10810, timeCalibration: corrected});
  assert.equal(result[1].start, 10812.8); assert.deepEqual(source, original);
  const outside = alignSegments(lines(['結尾']), words('結尾', 9), 10, null, {analysisDuration: 10, timeCalibration: {scale: 1, offset: 2}});
  assert.equal(outside[0].status, 'unmatched'); assert.equal(outside[0].start, null);
  assert.throws(() => fitCalibration([{wordId: 0, time: 12}, {wordId: 2, time: 5}], source, 10810, 10820));
  assert.throws(() => fitCalibration([{wordId: 0, time: 12}, {wordId: 1, time: 30}, {wordId: 2, time: 10802}], source, 10810, 10820), /不一致/);
  assert.equal(timingDiagnostics({source: 'local', duration: 10810}, {words: source}, 10820).issues.length, 2);
});

test('each chunk uses its absolute sample start including overlap, without cumulative duration addition', async () => {
  const {chunkClock, absoluteWords} = await import(pathToFileURL(path.resolve(__dirname, '../../client/src/lib/recording-clock.js')).href);
  for (const start of [0, 300, 600, 3600, 10800]) {
    const clock = chunkClock(10867, start, Math.min(10867, start + 300));
    const localTime = start - clock.fromSample / 16000 + 0.25;
    const [word] = absoluteWords([{word: '台詞', start: localTime, end: localTime + 0.5}], clock, clock.sampleCount / 16000);
    assert.equal(word.start, start + 0.25); assert.equal(word.end, start + 0.75);
  }
  const clock = chunkClock(1000, 300, 600);
  assert.throws(() => absoluteWords([], clock, 300), /長度/);
  assert.throws(() => absoluteWords([{word: '錯誤', start: 305, end: 306}], clock), /超出片段/);
});

test('point timestamps preserve words and subsequent absolute times instead of aborting a whole batch', async () => {
  const {chunkClock, absoluteWords} = await import(pathToFileURL(path.resolve(__dirname, '../../client/src/lib/recording-clock.js')).href);
  const clock = chunkClock(3600, 300, 600);
  const source = [{word: '前', start: 2, end: 2.3, confidence: .99},
    {word: '中', start: 2.3, end: 2.3, confidence: .99},
    {word: '後', start: 3, end: 3.4, confidence: .99}];
  const original = structuredClone(source);
  const result = absoluteWords(source, clock, 304, {chunkIndex: 1, chunkCount: 12});
  assert.deepEqual(result.map(word => word.word), ['前', '中', '後']);
  assert.equal(result[1].start, 300.3); assert.equal(result[1].end, 300.3);
  assert.equal(result[1].timingUncertain, true);
  assert.equal(result[2].start, 301); assert.equal(result[2].end, 301.4);
  assert.equal(result[2].timingUncertain, undefined);
  assert.deepEqual(source, original);
  const [tail] = absoluteWords([{word: '尾', start: 303.98, end: 304.02}], clock, 304);
  assert.equal(tail.end, 602); assert.equal(tail.timingUncertain, true);
  const [point] = absoluteWords([{word: '尾', start: 304.02, end: 304.02}], clock, 304);
  assert.equal(point.start, 602); assert.equal(point.end, 602); assert.equal(point.timingUncertain, true);
});

test('genuinely invalid ASR times stop with the batch, word and exact time values', async () => {
  const {chunkClock, absoluteWords} = await import(pathToFileURL(path.resolve(__dirname, '../../client/src/lib/recording-clock.js')).href);
  const clock = chunkClock(3600, 300, 600), context = {chunkIndex: 1, chunkCount: 12};
  const check = (word, reason) => assert.throws(() => absoluteWords([word], clock, 304, context), error => {
    assert.equal(error.code, 'RECORDING_WORD_TIMING');
    assert.match(error.message, /第 2／12 段，第 1 個詞/);
    assert.match(error.message, reason);
    assert.match(error.message, /片段長度 304 秒，對應原音 298 秒～602 秒/);
    return true;
  });
  check({word: '錯', start: 303, end: 305}, /終點 305 秒.*超出片段/);
  check({word: '錯', start: 2, end: 1}, /終點早於起點/);
  check({word: '錯', start: -1, end: 1}, /起點早於片段開頭/);
  check({word: '錯', start: null, end: 1}, /缺少有效文字或時間/);
  check(null, /缺少有效文字或時間/);
  assert.throws(() => absoluteWords([], clock, 300, context), /第 2／12 段.*回報長度 300 秒/);
});

test('missing word durations remain visible and require review, never authorize automatic following', () => {
  const script = lines(['今晚演出準備開始', '明天早上大家集合']);
  const source = [...words(script[0].text, 1), ...words(script[1].text, 5)];
  source[2].end = source[2].start;
  const timeline = wordTimeline(source, 10);
  assert.equal(timeline.words.length, source.length);
  assert.equal(timeline.words[2].timingUncertain, true);
  const result = alignSegments(script, source, 10);
  assert.equal(result[0].status, 'review'); assert.match(result[0].reviewReason, /缺少可靠的時間範圍/);
  assert.equal(result[1].start, 5); assert.equal(result[1].status, 'auto');
  const diagnostic = timingDiagnostics({source: 'local', duration: 10}, {words: source, clockVersion: 1}, 10);
  assert.equal(diagnostic.invalidWords, 0); assert.equal(diagnostic.uncertainWords, 1);
  assert.match(diagnostic.issues[0], /1 個辨識詞缺少可靠的時間範圍/);
  const onlyPoint = [{word: script[0].text, start: 1, end: 1, confidence: .99}];
  assert.equal(wordTimeline(onlyPoint, 10).words.length, 1);
  assert.equal(alignSegments(script.slice(0, 1), onlyPoint, 10)[0].status, 'unmatched');
});

function aiCase() {
  const script = lines(['你去哪裡']);
  const source = words('你去那裡', 600);
  const segments = alignSegments(script, source, 610);
  const timeline = wordTimeline(source, 610);
  const window = makeWindow(script, segments, timeline, [0]);
  const match = {lineId: script[0].id, status: 'matched', startWordId: 0, endWordId: 3, startChar: null, endChar: null, reason: '前後文支持同一句，包含一個同音錯字'};
  return {script, source, segments, timeline, window, match};
}
test('AI uses supplied word IDs and original times, while fuzzy decisions still require listening', () => {
  const f = aiCase();
  const [result] = validateMatches({matches: [f.match]}, f.window, f.script, f.segments, f.timeline, 610);
  assert.equal(result.start, 600); assert.equal(result.end, 600.8); assert.equal(result.source, 'openai');
  assert.equal(result.status, 'review'); assert.equal(result.wordStart, 0);
  assert.throws(() => validateMatches({matches: [{...f.match, endWordId: 999}]}, f.window, f.script, f.segments, f.timeline, 610), /未提供/);
  assert.throws(() => validateMatches({matches: [{...f.match, lineId: 'invented-cue'}]}, f.window, f.script, f.segments, f.timeline, 610), /字幕格/);
  assert.throws(() => validateMatches({matches: [{...f.match, startChar: -1}]}, f.window, f.script, f.segments, f.timeline, 610), /範圍/);
  const [uncertain] = validateMatches({matches: [{...f.match, status: 'uncertain', startWordId: null, endWordId: null}]}, f.window, f.script, f.segments, f.timeline, 610);
  assert.equal(uncertain.status, 'review');
});

test('validated AI batches are cached, send no audio/key in prompt, and provider failures do not leak credentials', async () => {
  const f = aiCase(); let calls = 0, saved;
  const run = extra => improveAlignment({lines: f.script, words: f.source, segments: f.segments, duration: 610,
    apiKey: 'private-test-placeholder', ...extra});
  const request = async (url, options) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body); assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
    assert.ok(!body.input.includes('private-test-placeholder')); assert.ok(!body.input.includes('audio'));
    return {ok: true, json: async () => ({status: 'completed', output_text: JSON.stringify({matches: [f.match]})})};
  };
  const result = await run({request, onCache: value => {saved = value;}});
  assert.equal(result.segments[0].start, 600); assert.equal(calls, 1);
  await run({request, cache: saved}); assert.equal(calls, 1);
  const failed = await run({request: async () => ({ok: false, status: 401, json: async () => ({error: 'private-test-placeholder'})})});
  assert.ok(!JSON.stringify(failed).includes('private-test-placeholder')); assert.equal(failed.segments[0].start, f.segments[0].start);
});

test('AI cannot cross confirmed cues, reuse word spans or use unrelated speech', () => {
  const script = lines(['開場台詞請注意聽', '你去哪裡', '最後請記得等我']);
  const source = [...words(script[0].text, 0), ...words('你去那裡', 5), ...words(script[2].text, 10), ...words('你去哪裡', 300)];
  const segments = alignSegments(script, source, 320);
  const timeline = wordTimeline(source, 320), window = makeWindow(script, segments, timeline, [1]);
  const f = aiCase(), far = source.length - 4;
  assert.throws(() => validateMatches({matches: [{...f.match, lineId: script[1].id, startWordId: far, endWordId: far + 3}]}, window, script, segments, timeline, 320));
  const unrelated = {matches: [{...f.match, lineId: script[1].id, startWordId: 0, endWordId: 1}]};
  assert.throws(() => validateMatches(unrelated, window, script, segments, timeline, 320));
});
