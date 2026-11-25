const {test} = require('node:test');
const assert = require('node:assert/strict');
const createFixture = require('./helpers/audio-server-fixture');
const {discussionContext} = require('../src/discussion-context');
const {discussionKeyterms} = require('../src/script-keyterms');

test('explicit discussion capture sends localized theatre keyterms, while automatic live fallback uses script context', t => {
  const previous = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_API_KEY = 'local-fixture-key';
  t.after(() => {if (previous === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = previous;});
  const f = createFixture({fakeDeepgram: true, lineCount: 3});
  t.after(() => f.dispose());
  f.allowSettings();
  f.history.start = async () => {};
  const start = (autoFollow, captureGeneration) => {
    f.event('transcription:start', {provider: 'deepgram', language: 'zh-TW', autoFollow,
      transcriptionContext: '《鳥》 陳導演',
      clientInfo: {captureOwnerId: 'operator', captureGeneration, captureId: 'capture-' + captureGeneration}});
    const stream = f.currentStream();
    stream.socket.readyState = 1;
    stream.socket.emit('open');
    return stream;
  };
  const discussion = start(false, 1);
  assert.equal(discussion.discussion, true);
  assert.match(discussion.transcriptionContext, /演後座談/);
  assert.match(discussion.transcriptionContext, /陳導演$/);
  assert.equal(f.control().transcription.transcriptionContext, '《鳥》 陳導演');
  const initialTerms = new URL(discussion.socket.url).searchParams.getAll('keyterm');
  assert.ok(initialTerms.includes('舞台監督'));
  assert.ok(initialTerms.includes('陳導演'));

  f.event('transcription:set-context', {transcriptionContext: '吳編劇'});
  assert.match(discussion.transcriptionContext, /演前座談.*吳編劇/s);
  assert.equal(f.control().transcription.transcriptionContext, '吳編劇');

  const performance = start(true, 2);
  f.session.automaticLive = true;
  assert.equal(performance.discussion, false);
  assert.equal(performance.transcriptionContext, '《鳥》 陳導演');
  assert.ok(!new URL(performance.socket.url).searchParams.getAll('keyterm').includes('演後座談'));
  assert.ok(discussionKeyterms('en', 'Director_Name').includes('stage manager'));
  assert.ok(discussionKeyterms('ja', '').includes('カーテンコール'));
});

test('OpenAI prompt, correction and translation receive theatre context and the full supplementary hint', async t => {
  const f = createFixture({lineCount: 1});
  t.after(() => f.dispose());
  const userContext = '台'.repeat(597) + '陳導演';
  const context = discussionContext(userContext, true);
  const update = f.realtimeTranscriptionUpdate({model: 'gpt-4o-transcribe', language: 'zh-TW', transcriptionContext: context});
  assert.match(update.session.audio.input.transcription.prompt, /演後座談/);
  assert.match(update.session.audio.input.transcription.prompt, /陳導演$/);

  const prompts = [];
  const client = {responses: {create: async request => {
    prompts.push(request.input.at(-1).content);
    return {output_text: JSON.stringify({edits: []})};
  }}};
  await f.correctTranscriptionLine({client, text: '謝幕', language: 'zh-TW', transcriptionContext: context,
    recognitionBrief: {terms: ['謝幕']}});
  await f.translateLiveTranscriptionLine({client, text: '謝幕', sourceLanguage: 'zh-TW', targetLanguage: 'en', transcriptionContext: context});
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.match(prompt, /舞台監督/);
    assert.match(prompt, /陳導演/);
  }
});
