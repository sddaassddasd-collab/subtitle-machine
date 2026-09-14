const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const { resolveProjectorLanguages } = require('../src/projector-languages');

const languages = [
  { id: 'primary', name: '中文', isPrimary: true },
  { id: 'en', name: '英文' },
  { id: 'ja', name: '日文' },
];

// Exercise real persistence representations, history, payloads and authenticated
// socket handlers without loading application data, opening ports or calling ASR.
const filename = require.resolve('../src/server');
const source = fs.readFileSync(filename, 'utf8');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
assert.match(source, /startServer\(\);\s*$/);
loaded._compile(source.replace(/startServer\(\);\s*$/, `
  module.exports = function(languages) {
    const user = { id: 'language-test-owner', role: USER_ROLES.OPERATOR };
    users.set(user.id, user);
    const token = 'language-test-cookie';
    authSessions.set(hashToken(token), {
      tokenHash: hashToken(token), userId: user.id, expiresAt: Date.now() + 60000,
    });
    const session = createSessionRecord(user.id);
    session.languages = structuredClone(languages);
    ensureSessionStructure(session);
    sessions.set(session.id, session);
    const writes = [], broadcasts = [];
    persistSession = s => writes.push(serializeSessionForStorage(s));
    broadcastControlState = id => broadcasts.push(getControlPayload(sessions.get(id)));
    broadcastProjectorState = id => broadcasts.push(getProjectorPayload(sessions.get(id)));
    broadcastViewerState = broadcastProjectorState;
    const handlersFor = cookie => {
      const handlers = new Map();
      io.listeners('connection')[0]({ id: 'language-socket', data: {},
        handshake: { headers: { cookie } }, on: (name, handler) => handlers.set(name, handler), emit() {} });
      return handlers;
    };
    const handlers = handlersFor(AUTH_COOKIE_NAME + '=' + token);
    const unauthorized = handlersFor('');
    return {
      session, writes, broadcasts,
      call(name, payload, authenticated = true) {
        let reply;
        (authenticated ? handlers : unauthorized).get(name)({sessionId: session.id, ...payload}, value => { reply = value; });
        return reply;
      },
      normalize: s => ensureSessionStructure(s || session),
      projector: () => getProjectorPayload(session),
      control: () => getControlPayload(session),
      snapshot: () => captureSessionSnapshot(session),
      restore: snapshot => restoreSessionSnapshot(session, snapshot),
      store: () => serializeSessionForStorage(session),
      importBackup: () => createImportedSessionFromBackup(buildSessionBackupPayload(session), user),
    };
  };
`), filename);
const fixture = () => loaded.exports(languages);

test('old bilingual/all settings migrate once and preserve the previous primary + selected pair', () => {
  for (const mode of ['bilingual', 'all']) {
    const f = fixture();
    delete f.session.projectorSecondaryLanguageId;
    f.session.projectorDefaultLanguageId = 'ja';
    f.session.projectorLanguageMode = mode;
    f.normalize();
    assert.equal(f.session.projectorLanguageMode, 'bilingual');
    assert.equal(f.session.projectorDefaultLanguageId, 'primary');
    assert.equal(f.session.projectorSecondaryLanguageId, 'ja');
    const stored = f.store();
    f.normalize();
    assert.deepEqual(f.store(), stored);
  }
});

test('arbitrary English/Japanese pair reaches preview/projector and survives storage, backup and undo', async () => {
  const f = fixture();
  const original = f.snapshot();
  f.call('setProjectorLanguageMode', {languageMode: 'bilingual'});
  assert.deepEqual(f.call('setProjectorLanguages', {languageId: 'en', secondaryLanguageId: 'ja'}), {ok: true});
  const revision = f.session.projectorRevision;
  for (const value of [f.store(), f.importBackup(), f.control().session]) {
    assert.equal(value.projectorDefaultLanguageId, 'en');
    assert.equal(value.projectorSecondaryLanguageId, 'ja');
  }
  const restored = f.normalize(JSON.parse(JSON.stringify(f.store())));
  assert.equal(restored.projectorSecondaryLanguageId, 'ja');
  const { resolveLanguageDisplayList, normalizeDisplayPayload } = await import('../../client/src/lib/displayPayload.js');
  const projection = normalizeDisplayPayload(f.projector());
  assert.deepEqual(resolveLanguageDisplayList(projection.languages, projection.defaultLanguageId,
    projection.languageMode, projection.secondaryLanguageId).map(language => language.id), ['en', 'ja']);
  assert.ok(revision >= 2);
  assert.ok(f.broadcasts.some(payload => payload.secondaryLanguageId === 'ja'));
  const pair = f.snapshot();
  assert.deepEqual(f.call('setProjectorLanguages', {languageId: 'ja', secondaryLanguageId: 'en'}), {ok: true});
  assert.equal(f.projector().defaultLanguageId, 'ja');
  assert.equal(f.projector().secondaryLanguageId, 'en');
  f.restore(original);
  assert.equal(f.session.projectorDefaultLanguageId, 'primary');
  f.restore(pair);
  assert.equal(f.session.projectorDefaultLanguageId, 'en');
  assert.equal(f.session.projectorSecondaryLanguageId, 'ja');
});

test('duplicate, unknown and unauthorized selections cannot change the saved pair', () => {
  const f = fixture();
  for (const payload of [
    {languageId: 'en', secondaryLanguageId: 'en'},
    {languageId: 'missing', secondaryLanguageId: 'ja'},
    {languageId: 'en', secondaryLanguageId: null},
  ]) assert.equal(f.call('setProjectorLanguages', payload).ok, false);
  assert.equal(f.call('setProjectorLanguages', {languageId: 'en', secondaryLanguageId: 'ja'}, false).ok, false);
  assert.equal(f.writes.length, 0);
  assert.equal(f.session.projectorDefaultLanguageId, 'primary');
});

test('deleted languages fall back to distinct available choices, or a single remaining language', () => {
  const f = fixture();
  f.call('setProjectorLanguages', {languageId: 'en', secondaryLanguageId: 'ja'});
  f.session.languages = f.session.languages.filter(language => language.id !== 'en');
  f.normalize();
  assert.equal(f.session.projectorDefaultLanguageId, 'primary');
  assert.equal(f.session.projectorSecondaryLanguageId, 'ja');
  f.session.languages = [f.session.languages[0]];
  f.normalize();
  assert.equal(f.session.projectorSecondaryLanguageId, null);
  assert.equal(f.call('setProjectorLanguages', {languageId: 'primary', secondaryLanguageId: null}).ok, true);
});

test('client and server cap legacy/invalid selections and preserve explicit order', async () => {
  const { resolveLanguageDisplayList } = await import('../../client/src/lib/displayPayload.js');
  for (const mode of ['single', 'bilingual', 'all', 'invalid']) {
    for (const top of ['primary', 'en', 'missing']) {
      for (const bottom of [undefined, null, 'ja', 'en', 'missing']) {
        const selection = resolveProjectorLanguages({languages, defaultLanguageId: top, secondaryLanguageId: bottom, languageMode: mode});
        const displayed = resolveLanguageDisplayList(languages, top, mode, bottom).map(language => language.id);
        const expected = selection.languageMode === 'single' ? [selection.defaultLanguageId]
          : [selection.defaultLanguageId, selection.secondaryLanguageId].filter(Boolean);
        assert.deepEqual(displayed, expected);
        assert.ok(displayed.length <= 2);
        assert.equal(new Set(displayed).size, displayed.length);
      }
    }
  }
  assert.equal(resolveLanguageDisplayList(languages, 'en', 'single').length, 1);
  assert.deepEqual(resolveLanguageDisplayList([languages[0]], 'en', 'bilingual', 'ja').map(l => l.id), ['primary']);
});
