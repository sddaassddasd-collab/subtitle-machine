const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setTimeout: delay} = require('node:timers/promises');
const createFixture = require('./helpers/audio-server-fixture');

test('mixed recognition saves per program and follows the selected script column through a language switch', async t => {
  const previousKey = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_API_KEY = 'local-fixture-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = previousKey;
  });
  const script = ['今晚我們一起走進劇場', 'Merci beaucoup tout le monde', 'Now please take your seats'];
  const f = createFixture({
    texts: script.map(() => '這是另一欄的字幕'),
    allowCueChanges: true,
    fakeDeepgram: true,
  });
  t.after(() => f.dispose());
  f.allowSettings();
  f.history.start = async () => {};
  f.event('transcription:stop', {});
  f.session.languages.push({id: 'spoken', name: '混合演出原文', code: 'lang-2'});
  f.session.lines.forEach((line, index) => { line.translations.spoken = script[index]; });

  const configure = (enabled, languages) => f.event('transcription:set-mixed-recognition', {enabled, languages});
  assert.deepEqual(f.storage().mixedRecognition, {enabled: false, languages: []});
  assert.equal(configure(true, ['zh', 'zh', 'invalid']).ok, false);
  assert.ok(f.control().recognitionLanguageHints.includes('zh-HK'));
  const languages = ['zh', 'fr', 'en'];
  assert.equal(configure(true, [...languages, 'invalid', 'fr']).ok, true);
  assert.deepEqual(f.storage().mixedRecognition, {enabled: true, languages});
  assert.deepEqual(f.control().session.mixedRecognition, {enabled: true, languages});
  assert.equal(f.event('transcription:set-script-language', {language: 'zh-TW', languageId: 'spoken'}).ok, true);

  const capture = {provider: 'deepgram', language: 'zh-TW', autoFollow: true};
  assert.match(f.event('transcription:start', {...capture, provider: 'openai'}).reason, /Deepgram/);
  const start = (overrides = {}) => {
    f.event('transcription:start', {...capture, ...overrides});
    const stream = f.currentStream();
    stream.socket.readyState = 1;
    stream.socket.emit('open');
    return stream;
  };
  const query = stream => new URL(stream.socket.url).searchParams;
  const stream = start();
  assert.equal(query(stream).get('model'), 'nova-3');
  assert.equal(query(stream).get('language'), 'multi');
  assert.deepEqual(query(stream).getAll('language_hint'), languages);
  assert.equal(configure(false, languages).ok, false);
  assert.equal(stream.language, 'zh-TW');
  assert.equal(f.control().session.followingScript.languageId, 'spoken');

  const emitResult = (transcript, words, start) => {
    stream.socket.emit('message', JSON.stringify({
      type: 'Results', start, duration: 1, is_final: true,
      channel: {alternatives: [{transcript, words, confidence: 0.99}]},
    }));
  };
  emitResult('今晚我们一起走进剧场', [{word: '今晚我们一起走进剧场', start: 0, end: 1, language: 'zh'}], 0);
  assert.equal(f.state().preparedIndex, 1);
  const frenchWords = script[1].split(' ').map((word, index) => ({
    word, start: 1 + index / 5, end: 1 + (index + 1) / 5, language: 'fr',
  }));
  emitResult(script[1], frenchWords, 1);
  assert.equal(f.session.currentIndex, 1);

  stream.socket.emit('close', 1006);
  assert.equal(configure(false, languages).ok, false);
  await delay(550);
  const reconnected = f.currentStream();
  assert.notEqual(reconnected, stream);
  assert.deepEqual(query(reconnected).getAll('language_hint'), languages);
  reconnected.socket.readyState = 1;
  reconnected.socket.emit('open');
  f.event('transcription:stop', {});

  const discussion = start({language: 'fr', autoFollow: false});
  assert.equal(discussion.discussion, true);
  assert.equal(query(discussion).get('language'), 'fr');
  assert.deepEqual(query(discussion).getAll('language_hint'), []);
  f.event('transcription:stop', {});

  assert.equal(configure(false, languages).ok, true);
  assert.deepEqual(f.storage().mixedRecognition, {enabled: false, languages});
  const singleLanguage = start();
  assert.equal(query(singleLanguage).get('language'), 'zh-TW');
  assert.deepEqual(query(singleLanguage).getAll('language_hint'), []);
});
