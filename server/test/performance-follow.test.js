const {test} = require('node:test');
const assert = require('node:assert/strict');
const {PerformanceFollower, normalizePerformanceSettings, resolveGroups} = require('../src/performance-follow');
const texts = ['現在開始我們的演出', '這一段多人一起說話', '大家都有不同的意見', '最後終於安靜下來了', '這就是本段出口台詞', '接著我們繼續說下去'];
function fixture({group = false, automaticLive = true} = {}) {
  const p = new PerformanceFollower(), lines = texts.map((text, i) => ({id: `l${i}`, text}));
  const settings = normalizePerformanceSettings({automaticLive, overlapGroups: group ? [
    {id: 'g', cellId: 'c', startLineId: 'l1', endLineId: 'l3', minimumSeconds: 1.8, maximumSeconds: 15}] : []});
  p.bind(settings, 'c', lines); return {p, lines, settings};
}
const event = (id, startMs, endMs, text = '這是即興發言完全不在劇本之內') =>
  ({itemId: id, startMs, endMs, audioMs: endMs, text, isFinal: true});
const match = (index, extra = {}) => ({index, confidence: 1, evidence: 9, margin: .5, ...extra});
const establish = p => p.observe(event('anchor', 0, 1000, texts[0]), match(0), 1000);
function enterLive(p) {
  establish(p);
  p.observe(event('x', 1100, 3000), null, 3000);
  return p.observe(event('y', 4000, 8000), null, 8000);
}

test('sustained distinct unmatched speech enters live; revisions and silence do not', () => {
  const {p} = fixture(); establish(p);
  for (let i = 0; i < 20; i++) assert.equal(p.observe(event('x', 1100, 3000), null, 3000 + i * 1000), null);
  assert.equal(p.source, 'script');
  const action = p.observe(event('y', 4000, 25000), null, 25000);
  assert.equal(action.source, 'live'); assert.equal(p.buffer.length, 1, 'no old transcript backlog');
});
test('fallback is opt-in and requires a previously reliable script position', () => {
  for (const automaticLive of [false, true]) {
    const {p} = fixture({automaticLive});
    if (!automaticLive) establish(p);
    p.observe(event('a', 1000, 3000), null, 3000);
    assert.equal(p.observe(event('b', 4000, 9000), null, 9000), null);
    assert.equal(p.source, 'script');
  }
});
test('low confidence, stale audio, invalid timing and overlapping ASR hypotheses are not improvisation evidence', () => {
  for (const invalid of [e => ({...e, confidence: .2}), e => ({...e, audioMs: e.endMs + 9000}),
    e => ({...e, endMs: NaN}), e => ({...e, endMs: e.audioMs + 1000})]) {
    const {p} = fixture(); establish(p);
    p.observe(invalid(event('a', 1100, 3000)), null, 3000);
    assert.equal(p.observe(invalid(event('b', 4000, 9000)), null, 9000), null);
  }
  const {p} = fixture(); establish(p);
  p.observe(event('a', 1100, 7000), null, 7000);
  assert.equal(p.observe(event('b', 4000, 13000), null, 13000), null);
});
test('a short paraphrase candidate gets grace time, without displaying that candidate', () => {
  const {p} = fixture(); establish(p);
  p.observe(event('a', 1100, 3000), null, 3000); p.semanticAt = 7900;
  assert.equal(p.observe(event('b', 4000, 8000), null, 8000), null);
  assert.equal(p.source, 'script');
  p.observe(event('c', 8100, 12000, texts[1]), match(1), 12000);
  assert.equal(p.source, 'script'); assert.equal(p.mismatch, null);
});
test('reacquisition returns to freshly recognized cue, never the saved cue, and clears live buffer', () => {
  const {p} = fixture(); assert.equal(enterLive(p).source, 'live');
  assert.equal(p.observe({...event('return', 8500, 10000, texts[3]), isFinal: false}, match(3), 10000), null);
  const action = p.observe(event('return', 8500, 10000, texts[3]), match(3), 12500);
  assert.equal(action.source, 'script'); assert.equal(action.index, 3);
  assert.equal(p.lastReliable.index, 3); assert.equal(p.buffer.length, 0);
});
test('weak or generic single match, repeated ASR revision, music and directions cannot return', () => {
  const {p, lines} = fixture(); enterLive(p);
  for (let i = 0; i < 5; i++) assert.equal(p.observe(event('a', 8500, 10000), match(1, {confidence: .82, evidence: 4}), 13000 + i * 1000), null);
  assert.equal(p.source, 'live');
  lines[2].music = true;
  assert.equal(p.observe(event('b', 11000, 12000), match(3), 20000), null);
  assert.equal(p.source, 'live');
});
test('two time-disjoint local matches can return without waiting for two full sentences', () => {
  const {p} = fixture(); enterLive(p);
  assert.equal(p.observe(event('a', 8500, 10000), match(2, {confidence: .83, evidence: 4}), 13000), null);
  assert.equal(p.observe(event('b', 11000, 12000), match(3, {confidence: .83, evidence: 4}), 14000).index, 3);
});
test('live and script locks override source automation; manual live can still reacquire after unlock', () => {
  const {p} = fixture(); p.command('lock-live', 0, 0, 0);
  assert.equal(p.observe(event('a', 1000, 2000), match(3), 6000), null);
  p.command('auto', 0, 2000, 6000);
  assert.equal(p.observe(event('b', 2100, 3000), match(3), 7000).index, 3);
  p.command('lock-script', 3, 3000, 7000);
  p.observe(event('x', 3100, 7000), null, 8000);
  assert.equal(p.observe(event('y', 7100, 15000), null, 17000), null);
});
test('only actual fresh suffix words survive a script-to-live boundary', () => {
  const {p} = fixture(); establish(p);
  const e = event('mixed', 0, 3000, texts[0] + '即興內容');
  e.words = [{word: texts[0], start: 0, end: 1}, {word: '即興內容', start: 1.1, end: 3}];
  p.observe(e, null, 3000);
  assert.equal(p.buffer[0].text, '即興內容');
  p.observe({...e, words: undefined}, null, 3100);
  assert.equal(p.buffer.length, 0, 'no fabricated split when provider word times are absent');
});
test('overlap starts only at a configured recognized entry and respects reading time and its last cue', () => {
  const {p} = fixture({group: true});
  assert.equal(p.observe(event('entry', 0, 1000), match(1), 1000).type, 'overlap_start');
  assert.equal(p.tick(1500, 1500), null);
  const next = p.group.nextAudioMs;
  p.lastPacketAt = next - 100; p.lastPacketAudioMs = next - 100;
  assert.equal(p.tick(next, next).index, 2);
  assert.equal(p.tick(next, next), null, 'never catch up by flashing multiple cues');
  p.lastPacketAt = p.group.nextAudioMs - 100; p.lastPacketAudioMs = p.group.nextAudioMs - 100;
  assert.equal(p.tick(p.group.nextAudioMs, p.group.nextAudioMs).index, 3);
  p.lastPacketAt = p.group.nextAudioMs - 100; p.lastPacketAudioMs = p.group.nextAudioMs - 100;
  assert.equal(p.tick(p.group.nextAudioMs, p.group.nextAudioMs), null);
  assert.equal(p.group.index, 3);
});
test('overlap pause, speed adjustment, capture gaps and hard time limit cancel predictable progression', () => {
  const {p} = fixture({group: true});
  p.command('start-overlap', 1, 0, 0);
  p.command('pause', 1, 0, 0); assert.equal(p.tick(5000, 5000), null);
  p.command('resume', 1, 5000, 5000); const old = p.group.nextAudioMs;
  p.command('faster', 1, 5000, 5000); assert.ok(p.group.nextAudioMs < old);
  p.lastPacketAt = 5000;
  assert.equal(p.tick(5100, 7000).reason, 'capture_gap'); assert.equal(p.group, null);
  p.command('start-overlap', 1, 0, 0);
  assert.equal(p.tick(16000, 16000).reason, 'overlap_limit');
  assert.equal(p.group, null);
});
test('exit speech ends overlap; revisions of the entry cannot restart consumed group', () => {
  const {p} = fixture({group: true});
  p.observe(event('entry', 0, 1000), match(1), 1000);
  assert.equal(p.observe(event('exit', 10000, 11000), match(4), 11000).reason, 'overlap_exit_recognized');
  assert.equal(p.observe(event('late-entry', 12000, 13000), match(1), 13000), null);
  assert.equal(p.group, null);
});
test('invalidated, overlapping, cross-scene and boundary-containing overlap ranges are inert', () => {
  const {settings, lines} = fixture({group: true});
  assert.equal(resolveGroups(settings, 'other', lines).length, 0);
  assert.equal(resolveGroups(settings, 'c', lines.filter(l => l.id !== 'l1'))[0].valid, false);
  assert.equal(resolveGroups(settings, 'c', lines.map((l, i) => i === 2 ? {...l, type: 'direction'} : l))[0].valid, false);
  const duplicated = normalizePerformanceSettings({...settings, overlapGroups: [...settings.overlapGroups, {...settings.overlapGroups[0], id: 'other'}]});
  assert.ok(resolveGroups(duplicated, 'c', lines).every(g => !g.valid));
});

test('audio ticks allow already established mismatch evidence to mature, but silence alone is never evidence', () => {
  const {p} = fixture(); establish(p);
  assert.equal(p.tick(5000, 5000), null);
  p.observe(event('x', 5100, 7000), null, 7000);
  p.observe(event('y', 7100, 10000), null, 10000);
  assert.equal(p.source, 'script');
  assert.equal(p.tick(12000, 12000).source, 'live');
  const {p: stale} = fixture(); establish(stale);
  stale.observe(event('x', 1100, 3000), null, 3000);
  stale.observe(event('y', 3100, 6000), null, 6000);
  assert.equal(stale.tick(16000, 16000), null);
});

test('silence inside overlap pauses estimates and a recognized line or operator can resume', () => {
  const {p} = fixture({group: true}); p.command('start-overlap', 1, 0, 0);
  let action;
  for (let ms = 20; ms <= 2000; ms += 20) action = p.tick(ms, ms, .0001) || action;
  assert.equal(action.reason, 'overlap_quiet'); assert.equal(p.group.paused, true);
  assert.equal(p.group.index, 1);
  p.observe(event('clear', 2100, 3000), match(2), 3000);
  assert.equal(p.group.paused, false); assert.equal(p.group.index, 2);
});

test('audio packet bursts cannot shorten the audience reading interval', () => {
  const {p} = fixture({group: true}); p.command('start-overlap', 1, 0, 0);
  for (let ms = 20; ms <= 10000; ms += 20) p.tick(ms, 100, .05);
  assert.equal(p.group.index, 1, 'audio time alone never flashes several cues');
});

test('distinctive final script evidence returns immediately; the hold prevents the next automatic fallback', () => {
  const {p} = fixture(); enterLive(p);
  const action = p.observe(event('return', 8100, 9000, texts[3]), match(3), 9000);
  assert.equal(action.source, 'script'); assert.equal(action.index, 3);
  p.observe(event('x', 9100, 11000), null, 11000);
  assert.equal(p.observe(event('y', 11100, 12000), null, 12000), null);
});

test('short distinctive interim speech can settle without waiting for an ASR final', () => {
  const {p} = fixture(); enterLive(p);
  const e = {...event('short', 8500, 10000, '你們的論點'), isFinal: false};
  const m = match(3, {evidence: 5, offset: 5, length: 5});
  assert.equal(p.observe(e, m, 10000), null);
  assert.equal(p.observe(e, m, 10500), null);
  assert.equal(p.observe(e, m, 11000).index, 3);
});

test('a strong completed sentence keeps its preserved opening stability instead of being replaced by that opening', () => {
  const {p} = fixture(); enterLive(p);
  const e = {...event('strong', 8500, 10000, '但我的內心'), isFinal: false,
    words: [{word: '但我的內心', start: 8.5, end: 10}]};
  p.observe(e, match(3, {evidence: 5, matchedCharacters: 5, offset: 5, length: 11, speech: e}), 10000);
  const grown = {...e, text: '但我的內心是相當快樂的', endMs: 11000, audioMs: 11000,
    words: [...e.words, {word: '是相當快樂的', start: 10, end: 11}]};
  const action = p.observe(grown, match(3, {evidence: 11, matchedCharacters: 11, offset: 11, length: 11, speech: grown}), 11000);
  assert.equal(action.index, 3); assert.equal(action.speech.text, grown.text);
  assert.equal(action.audioEndMs, 11000);
});

test('a later interim and its final cannot overwrite a separate preceding cue witness', () => {
  const {p} = fixture(); enterLive(p);
  const weak = i => match(i, {confidence: .82, evidence: 5});
  p.observe(event('first', 8500, 10000), weak(1), 10000);
  p.observe({...event('second', 11000, 12000), isFinal: false}, weak(3), 12000);
  const action = p.observe(event('second', 11000, 13000), weak(3), 13000);
  assert.equal(action.index, 3);
  assert.equal(action.returnEvidence.supportingIndex, 1);
});

test('locked-live tracking advances its confirmed background cursor without moving foreground position', () => {
  const {p, lines} = fixture(); enterLive(p);
  p.command('lock-live', 0, 8000, 8000);
  lines[2].type = 'direction';
  p.observe(event('forward', 9000, 10000, texts[3]), match(3), 10000);
  assert.equal(p.source, 'live'); assert.equal(p.lastReliable.index, 0);
  assert.equal(p.searchWindow(10000).origin, 3);
  assert.equal(p.publicState().backgroundConfirmedIndex, 3);
});

test('live search expands after a missed passage but remains bounded and cannot cross music', () => {
  const {p} = fixture();
  p.bind(p.settings, 'c', Array.from({length: 200}, (_, i) => ({id: `wide-${i}`, text: `字幕格${i}`})));
  enterLive(p);
  assert.equal(p.searchWindow(8000).to, 18);
  assert.equal(p.searchWindow(16000).to, 36);
  assert.equal(p.searchWindow(999999).to, 72);
  p.lines[25].music = true;
  assert.equal(p.searchWindow(999999).to, 24);
});

test('withdrawn interims and an unfinished opening do not qualify as continuously stable return evidence', () => {
  const {p} = fixture(); enterLive(p);
  const e = {...event('revised', 8500, 10000, '你們的論點'), isFinal: false};
  const m = match(3, {evidence: 5, offset: 5, length: 5});
  p.observe(e, m, 10000);
  p.observe({...e, text: '你們登論點'}, null, 10500);
  assert.equal(p.observe(e, m, 11000), null);
  assert.equal(p.observe(e, {...m, length: 20}, 12000), null);
  assert.equal(p.source, 'live');
});

test('a stable complete word range survives ASR growth into a later paraphrased cue', () => {
  const {p} = fixture(); enterLive(p);
  const first = {...event('growing', 8500, 10000, '你們的論點'), isFinal: false,
    words: [{word: '你們的論點', start: 8.5, end: 10}]};
  p.observe(first, match(3, {evidence: 5, offset: 5, length: 5, speech: first}), 10000);
  const next = {...first, text: '你們的論點哎其實對的', endMs: 11500, audioMs: 11500,
    words: [{word: '你們的論點', start: 8.5, end: 10.4}, {word: '哎其實對的', start: 10.4, end: 11.5}]};
  const action = p.observe(next, match(4, {confidence: .7, evidence: 5, matchedCharacters: 3}), 11500);
  assert.equal(action.index, 3); assert.equal(action.returnEvidence.retainedPhrase, true);
  assert.equal(action.audioEndMs, 10400);
});

test('a withdrawn word range cannot remain stable merely because the ASR item ID stayed the same', () => {
  const {p} = fixture(); enterLive(p);
  const first = {...event('growing', 8500, 10000, '你們的論點'), isFinal: false,
    words: [{word: '你們的論點', start: 8.5, end: 10}]};
  p.observe(first, match(3, {evidence: 5, offset: 5, length: 5, speech: first}), 10000);
  assert.equal(p.observe({...first, text: '另外一段話哎其實對的', endMs: 11500, audioMs: 11500,
    words: [{word: '另外一段話', start: 8.5, end: 10}, {word: '哎其實對的', start: 10.1, end: 11.5}]}, null, 11500), null);
  assert.equal(p.source, 'live');
});

test('three distinct ordered weaker phrases can reacquire while repeated hypotheses cannot build a path', () => {
  const {p} = fixture(); enterLive(p);
  const weak = i => match(i, {confidence: .74, evidence: 5, matchedCharacters: 4, margin: .2});
  p.observe(event('a', 8500, 10000), weak(1), 10000);
  p.observe(event('a', 8500, 10500), weak(2), 10500);
  assert.equal(p.source, 'live');
  p.observe(event('b', 11000, 12000), weak(2), 12000);
  const action = p.observe(event('c', 13000, 14000), weak(3), 14000);
  assert.equal(action.index, 3); assert.equal(action.returnEvidence.pathSteps, 3);
});

test('successive small timestamp shifts cannot make old words count as a newly stable phrase', () => {
  const {p} = fixture(); enterLive(p);
  const e = {...event('drifting', 8500, 10000, '你們的論點'), isFinal: false,
    words: [{word: '你們的論點', start: 8.5, end: 10}]};
  const m = match(3, {evidence: 5, offset: 5, length: 5});
  assert.equal(p.observe(e, m, 10000), null);
  assert.equal(p.observe({...e, endMs: 10600, audioMs: 10600,
    words: [{word: '你們的論點', start: 9.1, end: 10.6}]}, m, 10600), null);
  assert.equal(p.observe({...e, endMs: 11200, audioMs: 11200,
    words: [{word: '你們的論點', start: 9.7, end: 11.2}]}, m, 11200), null);
  assert.equal(p.source, 'live');
});

test('an independently supported path returns on a preserved prefix while the current sentence keeps growing', () => {
  const {p} = fixture(); enterLive(p);
  const weak = i => match(i, {confidence: .74, evidence: 5, matchedCharacters: 4, margin: .2});
  p.observe(event('a', 8500, 10000), weak(1), 10000);
  p.observe(event('b', 11000, 12000), weak(2), 12000);
  const first = {...event('c', 13000, 14000, '因為你們'), isFinal: false,
    words: [{word: '因為你們', start: 13, end: 14}]};
  const m = match(3, {confidence: .8, evidence: 4, matchedCharacters: 4, offset: 4, length: 18, speech: first});
  assert.equal(p.observe(first, m, 14000), null);
  const grown = {...first, text: '因為你們根本就沒有根據', endMs: 15000, audioMs: 15000,
    words: [...first.words, {word: '根本就沒有根據', start: 14.1, end: 15}]};
  const action = p.observe(grown, {...m, confidence: .73, evidence: 11, offset: 9, speech: grown}, 15000);
  assert.equal(action.index, 3);
  assert.equal(action.returnEvidence.pathSteps, 3);
  assert.equal(action.returnEvidence.stablePrefix, true);
  assert.equal(action.speech.text, '因為你們');
  assert.equal(action.audioEndMs, 14000);
});

test('stable prefixes alone cannot return, and rewriting the prefix withdraws its stability', () => {
  for (const supported of [false, true]) {
    const {p} = fixture(); enterLive(p);
    if (supported) {
      const weak = i => match(i, {confidence: .74, evidence: 5, matchedCharacters: 4, margin: .2});
      p.observe(event('a', 8500, 10000), weak(1), 10000);
      p.observe(event('b', 11000, 12000), weak(2), 12000);
    }
    const e = {...event('c', 13000, 14000, '因為你們'), isFinal: false,
      words: [{word: '因為你們', start: 13, end: 14}]};
    const m = match(3, {confidence: .8, evidence: 4, matchedCharacters: 4, offset: 4, length: 18, speech: e});
    p.observe(e, m, 14000);
    const text = supported ? '另外一段根本就沒有根據' : '因為你們根本就沒有根據';
    const revision = {...e, text, endMs: 15000, audioMs: 15000,
      words: [{word: text.slice(0, 4), start: 13, end: 14}, {word: text.slice(4), start: 14.1, end: 15}]};
    assert.equal(p.observe(revision, {...m, speech: revision}, 15000), null);
    assert.equal(p.source, 'live');
  }
});
