const {test} = require('node:test');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {extractRecognitionBrief} = require('../src/recognition-brief');
const {correctScriptCaption} = require('../src/script-caption-correction');
const fixture = require('./helpers/audio-server-fixture');

test('extraction keeps complete names from the supplied program and drops invented terms', async () => {
  const source = '《匠木浮城》描繪梁思遠的造船家族。\n編劇｜陳巧蓉';
  const summary = '梁思遠來自造船家族。';
  const calls = [];
  const client = {responses: {create: async args => {
    calls.push(args);
    return {output_text: JSON.stringify({summary, terms: ['陳巧蓉', '梁思遠', '匠木浮城', '虛構船廠', '陳巧蓉']})};
  }}};
  const brief = await extractRecognitionBrief(client, source, 'gpt-6-luna');
  assert.deepEqual(brief, {summary, terms: ['陳巧蓉', '梁思遠', '匠木浮城']});
  assert.equal(JSON.parse(calls[0].input[1].content).programDescription, source);
  assert.equal(calls[0].store, false);
});

test('a confirmed spelling can repair a homophone without a nearby script cue', async () => {
  const raw = '現在請陳巧容編劇跟我們分享這段故事';
  const options = {summary: '陳巧蓉是編劇。', terms: ['陳巧蓉'], topic: '演後座談'};
  let request;
  const client = {responses: {create: async value => {
    request = value;
    return {output_text: JSON.stringify({edits: [{from: '陳巧容', to: '陳巧蓉'}]})};
  }}};
  assert.equal(await correctScriptCaption(client, raw, [], 'gpt-6-luna', options), '現在請陳巧蓉編劇跟我們分享這段故事');
  const input = JSON.parse(request.input[1].content);
  assert.equal(input.programBackground, options.summary);
  assert.deepEqual(input.approvedTerms, options.terms);
  assert.equal(await correctScriptCaption(client, raw, [{text: '請編劇上台'}], 'gpt-6-luna', {...options, terms: []}), raw);
});

test('saved program hints reach both capture modes and the ordinary correction prompt', async t => {
  const cues = ['你怎麼現在才來', '路上出了點事情', '我在修復傳統木船', '我們去荔枝碗船廠'];
  const f = fixture({fakeDeepgram: true, texts: cues});
  f.allowSettings();
  f.history.start = async () => {};
  f.server.listen(0, '127.0.0.1');
  await once(f.server, 'listening');
  t.after(() => {f.dispose(); f.server.close();});
  const {port} = f.server.address();
  const path = 'http://127.0.0.1:' + port + '/api/session/' + f.session.id + '/recognition-brief';
  const brief = {source: '節目介紹：陳巧蓉編劇。', summary: '陳巧蓉是編劇。', terms: ['陳巧蓉', '匠木浮城']};
  const denied = await fetch(path);
  assert.equal(denied.status, 401);
  const saved = await fetch(path, {
    method: 'PUT', headers: {cookie: f.cookie, 'content-type': 'application/json'}, body: JSON.stringify(brief),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), brief);
  const read = await fetch(path, {headers: {cookie: f.cookie}});
  assert.deepEqual(await read.json(), brief);
  assert.deepEqual(f.storage().recognitionBrief, brief);
  assert.equal(f.viewer().transcription.recognitionBrief, undefined);
  assert.equal(f.projector().transcription.recognitionBrief, undefined);

  const previousKey = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_API_KEY = 'fixture-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = previousKey;
  });
  for (const autoFollow of [true, false]) {
    f.event('transcription:start', {provider: 'deepgram', language: 'zh-TW', autoFollow});
    const stream = f.currentStream();
    stream.socket.readyState = 1;
    stream.socket.emit('open');
    const terms = new URL(stream.socket.url).searchParams.getAll('keyterm');
    assert.deepEqual(terms.slice(0, 2), brief.terms);
    assert.deepEqual(terms.filter(term => cues.includes(term)), autoFollow ? cues : []);
    assert.deepEqual(stream.recognitionBrief, {summary: brief.summary, terms: brief.terms});
  }

  let prompt;
  const client = {responses: {create: async request => {
    prompt = request.input.at(-1).content;
    return {output_text: JSON.stringify({edits: [{from: '陳巧容', to: '陳巧蓉'}]})};
  }}};
  const corrected = await f.correctTranscriptionLine({client, text: '現在請陳巧容上台', language: 'zh-TW',
    recognitionBrief: f.currentStream().recognitionBrief});
  assert.deepEqual(corrected, {text: '現在請陳巧蓉上台', reason: 'approved_homophone'});
  assert.match(prompt, /陳巧蓉是編劇/);
  assert.match(prompt, /匠木浮城/);
  assert.ok(!prompt.includes(brief.source));
});

test('ordinary final caption correction preserves the original when the model tries to rewrite it', async t => {
  const f = fixture({lineCount: 1});
  t.after(() => f.dispose());
  const text = '現在請陳巧蓉分享未來三個月的工作';
  const recognitionBrief = {terms: ['陳巧蓉', '陳巧容', '蔚來', '四個月', '黃致健']};
  const input = {text, recognitionBrief, language: 'zh-TW'};
  const cases = [
    ['今天由其他人宣布全新演出內容', 'invalid_response'],
    [JSON.stringify({edits: [{from: '陳巧蓉', to: '黃致健'}]}), 'source_already_approved'],
    [JSON.stringify({edits: [{from: '陳巧蓉', to: '陳巧容'}]}), 'source_already_approved'],
    [JSON.stringify({edits: [{from: '未來', to: '蔚來'}]}), 'protected_character'],
    [JSON.stringify({edits: [{from: '三個月', to: '四個月'}]}), 'protected_character'],
    [JSON.stringify({edits: [{from: '工作', to: '攻作'}]}), 'target_not_approved'],
  ];
  for (const [output_text, reason] of cases) {
    const client = {responses: {create: async () => ({output_text})}};
    assert.deepEqual(await f.correctTranscriptionLine({...input, client}), {text, reason});
  }
  const ambiguous = {responses: {create: async () => ({
    output_text: JSON.stringify({edits: [{from: '陳巧榕', to: '陳巧蓉'}]}),
  })}};
  const ambiguousText = text.replace('陳巧蓉', '陳巧榕');
  assert.deepEqual(await f.correctTranscriptionLine({...input, text: ambiguousText, client: ambiguous}),
    {text: ambiguousText, reason: 'ambiguous_approved_term'});
  const client = {responses: {create: async () => assert.fail('Unsupported languages must skip Mandarin correction')}};
  assert.deepEqual(await f.correctTranscriptionLine({...input, client, language: 'multi'}), {text, reason: 'skipped'});
});

test('Deepgram final captions reject rewrites and audit accepted edits without changing recognition preview', async t => {
  const outcomes = ['這是整句改寫後的文字', JSON.stringify({edits: [{from: '陳巧容', to: '陳巧蓉'}]})];
  const f = fixture({lineCount: 1, fakeDeepgram: true,
    fakeCorrection: async () => ({output_text: outcomes.shift()})});
  t.after(() => f.dispose());
  f.session.recognitionBrief = {terms: ['陳巧蓉']};
  const events = [];
  f.history.event = (_sessionId, type, data) => { if (type === 'caption_correction') events.push(data); };
  const stream = f.startProvider({}, 'fixture-only');
  const sendFinal = (start, transcript) => stream.socket.emit('message', JSON.stringify({
    type: 'Results', start, duration: 1, is_final: true, speech_final: true,
    channel: {alternatives: [{transcript, words: []}]},
  }));
  sendFinal(0, '我們今天一起看戲');
  await stream.correctionChain;
  assert.equal(stream.completedFragments[0].text, '我們今天一起看戲');

  sendFinal(2, '接下來請陳巧容上臺');
  await stream.correctionChain;
  assert.equal(stream.completedFragments[1].text, '接下來請陳巧蓉上臺');
  assert.equal(stream.completedFragments[1].rawTranscript, '接下來請陳巧容上臺');
  assert.equal(stream.recognitionPreview.text, '接下來請陳巧容上臺');
  assert.deepEqual(events.map(({status, reason, original, corrected}) => [status, reason, original, corrected]), [
    ['rejected', 'invalid_response', '我們今天一起看戲', '我們今天一起看戲'],
    ['applied', 'approved_homophone', '接下來請陳巧容上臺', '接下來請陳巧蓉上臺'],
  ]);
});
