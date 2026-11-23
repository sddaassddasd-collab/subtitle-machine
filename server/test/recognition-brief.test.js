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
  const f = fixture({fakeDeepgram: true, lineCount: 3});
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
    assert.deepEqual(stream.recognitionBrief, {summary: brief.summary, terms: brief.terms});
  }

  let prompt;
  const client = {responses: {create: async request => {
    prompt = request.input.at(-1).content;
    return {output_text: '陳巧蓉'};
  }}};
  await f.correctTranscriptionLine({client, text: '陳巧容', language: 'zh-TW',
    recognitionBrief: f.currentStream().recognitionBrief});
  assert.match(prompt, /陳巧蓉是編劇/);
  assert.match(prompt, /匠木浮城/);
  assert.ok(!prompt.includes(brief.source));
});
