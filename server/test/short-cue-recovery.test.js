const {test} = require('node:test');
const assert = require('node:assert/strict');
const {prepareScript} = require('../src/auto-follow');
const {observeShortCueSequence} = require('../src/short-cue-recovery');
const {normalizePerformanceSettings, PerformanceFollower} = require('../src/performance-follow');
const createFixture = require('./helpers/audio-server-fixture');

const texts = ['前一句劇本內容很長', ...Array(48).fill('喂'), '好啊', '走吧', '等等', '拿外套', '外面開始下雨了'];
const spoken = ['好', '走啦', '拿外桃'];
const target = texts.indexOf('拿外套');
const prepare = lines => prepareScript(lines.map(text => ({text})));
const event = (words = spoken) => ({
  itemId: 'a', streamId: 'provider', language: 'zh-TW', text: words.join(''),
  startMs: 1000, endMs: 1000 + words.length * 400, isFinal: true,
  words: words.map((word, index) => ({word, startMs: 1000 + index * 400, endMs: 1400 + index * 400})),
});

test('recovers beyond fifty cues using timed short phrases with omissions, changed particles and homophones', () => {
  const script = prepare(texts);
  const result = observeShortCueSequence({}, script, 0, event());
  assert.equal(result.candidate.index, target);
  assert.equal(result.candidate.pathSteps, 3);
  assert.equal(result.candidate.speech.startMs, 1800);
  assert.ok(result.candidate.confidence < 1);

  const state = {};
  const observed = spoken.map((text, index) => observeShortCueSequence(state, script, 0, {
    ...event(), itemId: String(index), text, startMs: 1000 + index * 400, endMs: 1400 + index * 400, words: [],
  }));
  assert.deepEqual(observed.slice(0, 2), [{}, {}]);
  assert.equal(observed[2].candidate.index, target);
});

test('follows a rolling run of fifty short cues even with missing characters', () => {
  const short = [...'春夏秋冬早晚東西南北'].flatMap(first => [...'風雨雲霧雪'].map(last => first + last));
  const script = prepare(['演出即將開始', '再說一次', ...short]);
  const state = {};
  let currentIndex = 1;
  short.forEach((text, index) => {
    const startMs = 1000 + index * 300;
    const {candidate} = observeShortCueSequence(state, script, currentIndex, {
      itemId: String(index), streamId: 'provider', language: 'zh-TW', startMs, endMs: startMs + 280,
      isFinal: true, text: index % 6 === 3 ? text[0] : text,
    });
    if (!candidate) return;
    assert.ok(candidate.index >= currentIndex && candidate.index <= index + 2);
    currentIndex = candidate.index;
  });
  assert.equal(currentIndex, short.length + 1);
});

test('revisions, duplicate sequences, old audio and music boundaries cannot authorize a jump', () => {
  const script = prepare(texts);
  const duplicate = prepare([...texts, ...texts.slice(49)]);
  assert.deepEqual(observeShortCueSequence({}, duplicate, 0, event()), {ambiguous: true});
  assert.deepEqual(observeShortCueSequence({}, script, 0, {...event(), audioMs: 6000}), {});
  assert.deepEqual(observeShortCueSequence({}, script, 0, event(), {minimumMs: 1700}), {});
  const barrier = prepareScript(texts.map((text, index) => ({text, music: index === 12})));
  assert.deepEqual(observeShortCueSequence({}, barrier, 0, event()), {});
  const state = {};
  const revised = {...event(['好']), isFinal: false};
  for (let i = 0; i < 4; i++) assert.deepEqual(observeShortCueSequence(state, script, 0, revised), {});
  assert.deepEqual(observeShortCueSequence(state, script, 0, event(['好', '走啦', '刪除它'])), {});
});

test('one ASR item with several ambiguous timed cues can use the existing live fallback', () => {
  const f = new PerformanceFollower();
  f.bind(normalizePerformanceSettings({automaticLive: true}), 'script', texts.map(text => ({text})));
  f.originIndex = 0;
  const input = {itemId: 'combined', startMs: 0, endMs: 1800, audioMs: 1800, text: '好啊走吧等一下拿外套', isFinal: false};
  assert.equal(f.observe(input, null, 0), null);
  assert.equal(f.observe({...input, endMs: 2000, audioMs: 2000}, null, 1000), null);
  const action = f.observe({...input, endMs: 6000, audioMs: 6000, ambiguousShortCues: true}, null, 5600);
  assert.equal(action.source, 'live');
});

for (const live of [false, true]) {
  test('automatic following displays the current cue using ordered short speech' + (live ? ' from live captions' : ''), t => {
    const f = createFixture({texts, allowCueChanges: true});
    t.after(() => f.dispose());
    f.allowSettings();
    if (live) {
      f.session.performanceFollowing = normalizePerformanceSettings({automaticLive: true});
      assert.equal(f.event('performance:action', {action: 'lock-live'}).ok, true);
      assert.equal(f.event('performance:action', {action: 'auto'}).ok, true);
    }
    f.stream.autoFollowAudioMs = 2200;
    const speech = event();
    f.transcript(speech.text, speech);
    assert.equal(f.session.currentIndex, target);
    assert.equal(f.viewer().text, texts[target]);
    assert.equal(f.session.automaticLive === true, false);
    assert.deepEqual(f.cueChanges, [target]);
  });
}
