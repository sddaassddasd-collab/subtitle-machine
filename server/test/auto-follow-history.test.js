const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-follow-history-'));
process.env.DATABASE_URL = process.env.SUBTITLE_HISTORY_TEST_DATABASE_URL || '';
process.env.SUBTITLE_MACHINE_DATA_DIR = directory;
const store = require('../src/persistence');
const {AutoFollowHistory} = require('../src/auto-follow-history');
const {historyReport, historyCsv} = require('../src/auto-follow-history-report');
after(() => fs.rmSync(directory, {recursive: true, force: true}));
const session = id => ({id, title: '排練測試', currentIndex: 0, selectedCellId: 'act-1', transcriptionLanguage: 'zh-TW',
  cells: [{id: 'act-1', name: '第一幕'}], languages: [{id: 'primary', name: '中文', code: 'zh-TW'}],
  lines: ['第一句台詞', '第二句台詞', '第三句台詞', '第四句台詞', '第五句台詞'].map((text, i) => ({id: `cue-${i}`, text, type: 'dialogue'}))});
function fixture(id, options = {}) {
  let clock = 1760000000000;
  const errors = [];
  return {session: session(id), errors, advance: (ms = 100) => { clock += ms; },
    history: new AutoFollowHistory({store, now: () => clock, flushMs: 60000, onError: (...args) => errors.push(args), ...options})};
}

test('independent trigger and confirmation sources survive repeat performances without an open UI', async () => {
  const {session: s, history: h} = fixture('sources');
  const id = await h.start(s);
  h.confirm(s.id, 0, 'transcript', {text: '第一句台詞', completed: true});
  h.enter(s, 1, {source: 'onset', decisionId: 'decision-1', streamId: 'stream-a', audioMs: 1200}); s.currentIndex = 1;
  h.confirm(s.id, 1, 'audio', {referenceSeconds: 31.36, completed: false});
  h.confirm(s.id, 1, 'audio', {referenceSeconds: 31.5, completed: false}); // noisy repetitive updates are coalesced
  h.confirm(s.id, 1, 'audio', {referenceSeconds: 33.52, completed: true});
  h.queue(s.id, entry => h.append(entry, 'display_ack', {decisionId: 'decision-1', role: 'viewer', ms: 80}));
  h.enter(s, 0, {source: 'manual'}); s.currentIndex = 0;
  h.enter(s, 1, {source: 'transcript'}); s.currentIndex = 1;
  h.confirm(s.id, 1, 'transcript', {text: '第二句台詞', completed: true});
  const report = historyReport(await h.read(s.id, id)), row = report.rows[1];
  assert.equal(row.visits.length, 2);
  assert.equal(row.visits[0].source, 'onset');
  assert.deepEqual(row.visits[0].confirmations.map(item => item.source), ['audio', 'audio']);
  assert.equal(row.visits[0].confirmations.at(-1).completed, true);
  assert.equal(row.visits[0].displayAcks[0].ms, 80);
  assert.equal(row.visits[1].source, 'transcript');
  assert.equal(report.rows[0].visits[0].source, 'initial');
  assert.equal(report.rows[0].autoEntryCount, 0);
  assert.equal(row.autoEntryCount, 2);
  assert.deepEqual(report.events.filter(item => item.type === 'cue_enter').map(item => item.fromIndex), [undefined, 0, 1, 0]);
  await h.end(s.id);
});

test('manual skips, automatic skips, unperformed cues and repeated visits remain distinguishable', async () => {
  const {session: s, history: h} = fixture('skips');
  const id = await h.start(s);
  h.enter(s, 2, {source: 'manual'}); s.currentIndex = 2;
  h.enter(s, 4, {source: 'audio'}); s.currentIndex = 4;
  let report = historyReport(await h.read(s.id, id));
  assert.equal(report.rows[1].status, 'skipped_manual');
  assert.equal(report.rows[3].status, 'skipped_auto');
  assert.equal(report.rows[4].status, 'pending');
  h.enter(s, 1, {source: 'manual'}); s.currentIndex = 1;
  h.confirm(s.id, 1, 'transcript', {completed: true});
  report = historyReport(await h.read(s.id, id));
  assert.equal(report.rows[1].status, 'confirmed');
  assert.equal(report.rows[1].skips.length, 1); // later recovery never erases the earlier skip
  await h.end(s.id);
  const next = await h.start({...s, currentIndex: 3}, {fresh: true});
  report = historyReport(await h.read(s.id, next));
  assert.equal(report.rows[0].status, 'unentered');
  assert.equal(report.rows[3].visits[0].source, 'initial');
  await h.end(s.id);
});

test('durable recovery retains the run and visits, marks an interruption and preserves script versions', async () => {
  const {session: s, history: first} = fixture('restart');
  const id = await first.start(s);
  first.enter(s, 1, {source: 'audio'}); s.currentIndex = 1;
  await first.flush(s.id);
  const second = fixture('unused').history;
  assert.equal(await second.restore(s), id); // startup recovery works before opening details or restarting ASR
  second.confirm(s.id, 1, 'transcript', {completed: true});
  second.confirm(s.id, 1, 'audio', {completed: true});
  s.lines[1].text = '修改後的第二句'; second.sync(s);
  second.confirm(s.id, 1, 'audio', {completed: true});
  s.selectedCellId = 'act-2'; s.currentIndex = 0; second.sync(s);
  await second.flush(s.id);
  const report = historyReport(await second.read(s.id, id));
  assert.equal(report.hasGaps, true);
  assert.equal(report.events.filter(item => item.type === 'interruption').length, 1);
  assert.equal(report.contexts.length, 3);
  assert.equal(report.rows[1].text, '第二句台詞');
  assert.equal(report.rows[6].text, '修改後的第二句');
  assert.equal(report.rows[1].visits.length, 1);
  assert.equal(report.rows[1].visits[0].confirmations[0].source, 'transcript');
  assert.equal(report.rows[6].visits[0].confirmations[0].source, 'audio');
  assert.equal(new Set(report.events.map(item => item.sequence)).size, report.events.length);
  assert.ok((await store.listOpenFollowSessionIds()).includes(s.id));
  assert.equal(report.events.at(-1).sequence + 1, report.run.nextSequence);
  // A separate Node process reads the committed file, not an in-process cache.
  const child = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(require.resolve('../src/persistence'))}).getFollowRun('restart',${JSON.stringify(id)}).then(x=>process.stdout.write(String(x.events.length),()=>process.exit(0)))`], {encoding: 'utf8'});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(Number(child.stdout), report.events.length);
  await second.end(s.id);
});

test('new runs retain previous runs; finishing is explicit and stale end/delete requests are rejected', async () => {
  const {session: s, history: h} = fixture('runs');
  const first = await h.start(s);
  h.transport(s.id, 'paused', {reason: 'client requested stop'});
  assert.equal(await h.start(s), first); // stop/restart collection resumes this rehearsal
  const next = await h.start(s, {fresh: true});
  assert.notEqual(first, next);
  await assert.rejects(h.end(s.id, 'user_finished', first), {status: 409});
  await assert.rejects(h.remove(s.id, next), {status: 409});
  assert.equal((await h.read(s.id, first)).run.endReason, 'new_run');
  await h.end(s.id, 'user_finished', next);
  h.enter(s, 1, {source: 'audio'});
  assert.equal((await h.read(s.id, next)).events.filter(event => event.type === 'cue_enter').length, 1);
  await h.remove(s.id, first);
  assert.equal(await h.read(s.id, first), null);
  assert.equal((await h.list(s.id, 20, 0)).length, 1);
  assert.equal(h.status(s.id).error, '');
});

test('stream restarts have distinct audio clocks; diagnostics are bounded and initial connecting is not a gap', async () => {
  const {session: s, history: h, advance} = fixture('clocks');
  const id = await h.start(s);
  h.transport(s.id, 'connecting', {streamId: 'a'});
  h.transport(s.id, 'ready', {streamId: 'a'});
  h.audio(s.id, 'a', 100);
  for (let i = 0; i < 500; i++) h.diagnostic(s.id, 'audio', 'searching', {message: '相似台詞'});
  let report = historyReport(await h.read(s.id, id));
  assert.equal(report.events.filter(item => item.type === 'diagnostic').length, 1);
  assert.equal(report.hasGaps, false);
  advance(10000);
  h.transport(s.id, 'paused', {streamId: 'a', audioMs: 100});
  h.transport(s.id, 'ready', {streamId: 'b', audioMs: 0});
  await h.flush(s.id);
  h.audio(s.id, 'b', 20);
  report = historyReport(await h.read(s.id, id));
  assert.equal(report.hasGaps, true);
  assert.deepEqual(report.events.filter(item => item.type === 'capture_audio').map(item => [item.streamId, item.audioMs]), [['a', 100], ['b', 20]]);
  await h.end(s.id);
});

test('database failure retains events for idempotent retry and bounded overflow is explicitly reported', async () => {
  let fail = true;
  const failing = {...store, saveFollowHistory: async (...args) => {
    if (fail) throw new Error('database unavailable');
    return store.saveFollowHistory(...args);
  }};
  const {session: s, history: h, advance} = fixture('failure', {store: failing, maxPending: 6});
  const id = await h.start(s);
  await assert.rejects(h.flush(s.id), /unavailable/);
  for (let i = 0; i < 20; i++) { advance(6000); h.diagnostic(s.id, 'text', 'searching'); }
  await h.entry(s.id).tail;
  assert.match(h.status(s.id).error, /過多/);
  fail = false; await h.flush(s.id); await h.flush(s.id);
  const report = historyReport(await h.read(s.id, id));
  assert.equal(report.events[0].type, 'run_start');
  assert.ok(report.events.some(item => item.type === 'logging_gap' && item.count > 0));
  assert.equal(report.hasGaps, true);
  assert.equal(new Set(report.events.map(item => item.sequence)).size, report.events.length);
  assert.equal(h.status(s.id).error, '');
  await h.end(s.id);
});

test('multi-cue text coverage never fabricates visits or erases skips and normal final stop is not a recording gap', async () => {
  const {session: s, history: h} = fixture('coverage');
  const id = await h.start(s);
  h.audio(s.id, 'a', 100);
  const spans = [0, 1, 2].map(index => ({index, completed: true, heard: s.lines[index].text, coverage: 1}));
  for (let i = 0; i < 100; i++) h.heard(s.id, spans, {itemId: 'batch-a', providerStreamId: 'a', audioMs: 2000});
  h.confirm(s.id, 0, 'transcript', {completed: true, matchedSpan: spans[0]});
  h.enter(s, 2, {source: 'transcript'}); s.currentIndex = 2;
  h.confirm(s.id, 2, 'transcript', {completed: true});
  h.transport(s.id, 'paused', {reason: 'client requested stop'});
  const report = historyReport(await h.read(s.id, id));
  assert.equal(report.events.filter(event => event.type === 'cue_heard').length, 3);
  assert.equal(report.rows[1].heard[0].heard, '第二句台詞');
  assert.equal(report.rows[1].visits.length, 0);
  assert.equal(report.rows[1].status, 'skipped_auto');
  assert.equal(report.rows[0].status, 'confirmed');
  assert.equal(report.hasGaps, false);
  assert.match(historyCsv(report), /是（不代表已顯示）/);
  await h.end(s.id);
});

test('JSON/CSV exports retain every visit, quoted multiline text, formula safety and ownership partitioning', async () => {
  const {session: s, history: h} = fixture('exports');
  s.title = '=HYPERLINK("bad")'; s.lines[1].text = '+公式,"台詞"\n第二行';
  const id = await h.start(s);
  h.enter(s, 1, {source: 'manual'}); s.currentIndex = 1;
  h.confirm(s.id, 1, 'transcript', {text: '=DANGEROUS()', completed: true});
  await h.end(s.id);
  const report = historyReport(await h.read(s.id, id)), csv = historyCsv(report);
  assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('\r\n'));
  assert.ok(csv.includes("'=")); assert.ok(csv.includes("'+公式,"));
  assert.ok(csv.includes('""台詞""\n第二行'));
  assert.equal(JSON.parse(JSON.stringify(report)).events.length, report.events.length);
  assert.equal(await store.getFollowRun('other-owner-session', id), null);
  assert.deepEqual(await store.listFollowRuns('other-owner-session'), []);
  await h.remove(s.id);
  assert.equal(await store.getFollowRun(s.id, id), null);
});

test('trigger timestamps remain exact while queued, with UTC/Taipei millisecond exports and legacy fallback', async () => {
  const {session: s, history: h, advance} = fixture('trigger-clock');
  const id = await h.start(s);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  h.queue(s.id, () => gate);
  advance(123);
  const triggeredAt = 1760000000123;
  h.enter(s, 1, {source: 'audio', decisionTiming: {decidedAt: triggeredAt, audioEndMs: 1200}});
  s.currentIndex = 1;
  advance(900);
  release();
  const report = historyReport(await h.read(s.id, id)), visit = report.rows[1].visits[0];
  assert.equal(visit.triggeredAt, triggeredAt); assert.equal(visit.elapsedMs, 123);
  const event = report.events.find(item => item.type === 'cue_enter' && item.index === 1);
  assert.equal(event.at, triggeredAt); assert.equal(event.recordedAt, triggeredAt + 900);
  const csv = historyCsv(report);
  assert.match(csv, /2025-10-09T08:53:20\.123Z/);
  assert.match(csv, /2025-10-09 16:53:20[.,]123/);
  assert.match(csv, /"0\.123"/);
  const old = historyReport({run: report.run, events: report.events.map(item => {
    if (item.type !== 'cue_enter') return item;
    const {triggeredAt: _trigger, elapsedMs: _elapsed, decisionTiming: _timing, ...legacy} = item;
    return legacy;
  })});
  assert.equal(old.rows[1].visits[0].timestampSource, 'legacy_event');
  await h.end(s.id);
});

test('all transcript revisions, ignored reasons, word timing and post-marker traces persist without an open panel', async () => {
  const {session: s, history: h, advance} = fixture('revisions');
  const id = await h.start(s);
  for (let i = 0; i < 3; i++) {
    advance(100);
    h.revision(s.id, i === 0 ? '第一句' : '第一句台詞', {itemId: 'same', streamId: 'provider', isFinal: i === 2,
      words: [{word: '第一句', start: 1, end: 1.4, confidence: 0.91}]},
    {reason: i === 1 ? 'duplicate_interim' : 'text_matched', ignored: i === 1, before: {currentIndex: 0}, after: {currentIndex: 0}});
  }
  await h.mark(s, id, {note: '這裡漏格'});
  await assert.rejects(h.mark(s, 'old-run'), {status: 409});
  let report = historyReport(await h.read(s.id, id));
  assert.equal(report.diagnostics.transcriptRevisions, 3);
  assert.deepEqual(report.events.filter(event => event.type === 'transcript_revision').map(event => event.isFinal), [false, false, true]);
  assert.equal(report.events.find(event => event.type === 'transcript_revision').words[0].startMs, 1000);
  advance(1000);
  h.observe(s.id, 'audio', 'below_threshold', {confidence: 0.7, candidateIndex: 0, acoustic: {supportCount: 0}});
  report = historyReport(await h.read(s.id, id));
  assert.ok(report.events.some(event => event.type === 'decision_trace' && event.samples.some(sample => sample.confidence === 0.7)));
  assert.equal(report.events.find(event => event.type === 'problem_mark').note, '這裡漏格');
  assert.ok(report.contexts[0].environment.server.commit);
  assert.equal(report.contexts[0].environment.settings.acoustic.minimumConfidence, 0.8);
  const ids = report.events.filter(event => event.type === 'decision_trace').flatMap(event => event.samples.map(sample => sample.sampleId));
  assert.equal(ids.length, new Set(ids).size);
  await h.end(s.id);
});

test('packet diagnostics aggregate instead of queuing each packet and flush the trailing partial interval', async () => {
  const {session: s, history: h, advance} = fixture('packet-summary');
  const id = await h.start(s);
  for (let i = 1; i <= 1000; i++) {
    advance(20);
    h.capture(s.id, 'capture', {sequence: i, level: 0.001, stale: i % 100 === 0,
      quality: {samples: 480, peak: 0.1, clippedSamples: 0}});
  }
  const report = historyReport(await h.read(s.id, id));
  const summaries = report.events.filter(event => event.type === 'capture_summary');
  assert.ok(summaries.length <= 5);
  assert.equal(summaries.reduce((sum, event) => sum + event.packets, 0), 1000);
  assert.equal(summaries.reduce((sum, event) => sum + event.stalePackets, 0), 10);
  assert.ok(!JSON.stringify(report).includes('pcm'));
  await h.end(s.id);
});

test('long revisions cannot grow pending memory beyond the byte budget and dropped diagnostics leave a gap record', async () => {
  const {session: s, history: h} = fixture('byte-budget', {maxPendingBytes: 8000});
  const id = await h.start(s);
  h.revision(s.id, '字'.repeat(4000), {words: Array(256).fill({word: '很長的辨識詞'.repeat(20), start: 0, end: 1})},
    {reason: 'low_text_score'});
  const report = historyReport(await h.read(s.id, id));
  assert.ok(h.entry(s.id).pendingBytes <= 8000);
  assert.ok(report.events.some(event => event.type === 'logging_gap' && event.count > 0));
  await h.end(s.id);
});

test('panel reads omit historical word arrays and trace payloads while preserving totals and every visit', async () => {
  const {session: s, history: h, advance} = fixture('summary-read');
  const id = await h.start(s);
  for (let i = 0; i < 120; i++) {
    advance(100);
    h.revision(s.id, `第一句${i}`, {itemId: String(i), words: [{word: '第一句', start: 0, end: 1}]}, {reason: 'text_matched'});
  }
  const full = historyReport(await h.read(s.id, id));
  const preview = historyReport(await h.read(s.id, id, {summary: true}));
  assert.equal(preview.diagnostics.transcriptRevisions, 120);
  assert.equal(preview.rows[0].entryCount, full.rows[0].entryCount);
  assert.ok(preview.events.filter(event => event.type === 'transcript_revision').length <= 80);
  assert.ok(preview.events.filter(event => event.type === 'transcript_revision').every(event => !event.words && !event.before));
  assert.ok(preview.events.filter(event => event.type === 'decision_trace').every(event => event.samples.length === 0));
  assert.equal(full.events.filter(event => event.type === 'transcript_revision').length, 120);
  await h.end(s.id);
});

test('SQLite to an empty PostgreSQL migrates run cursors and every event with the session',
  {skip: !process.env.SUBTITLE_HISTORY_TEST_DATABASE_URL}, async () => {
    const s = session('history-migration');
    const script = `
      const store=require(${JSON.stringify(require.resolve('../src/persistence'))});
      const {AutoFollowHistory}=require(${JSON.stringify(require.resolve('../src/auto-follow-history'))});
      (async()=>{
        const session=${JSON.stringify(s)};
        await store.saveStore({users:[],authSessions:[],sessions:[session]});
        const history=new AutoFollowHistory({flushMs:60000});
        const id=await history.start(session);
        history.confirm(session.id,0,'transcript',{completed:true});
        await history.flush(session.id);
        process.stdout.write(id);
      })().catch(error=>{console.error(error);process.exit(1)});
    `;
    const child = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', env: {...process.env, DATABASE_URL: ''}});
    assert.equal(child.status, 0, child.stderr);
    const loaded = await store.loadStore();
    assert.ok(loaded.sessions.some(session => session.id === s.id));
    const migrated = await store.getFollowRun(s.id, child.stdout);
    assert.equal(migrated.events.length, 4);
    assert.equal(migrated.events[3].source, 'transcript');
    const recovered = fixture('unused').history;
    assert.equal(await recovered.start(s), child.stdout);
    assert.ok((await recovered.read(s.id, child.stdout)).events.some(event => event.type === 'interruption'));
    await recovered.end(s.id);
  });
