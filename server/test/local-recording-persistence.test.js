const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-local-persistence-'));
process.env.DATABASE_URL = '';
process.env.SUBTITLE_MACHINE_DATA_DIR = directory;
const filename = path.join(directory, 'app-store.sqlite');
const old = new DatabaseSync(filename);
old.exec(`CREATE TABLE recording_assets (session_id TEXT NOT NULL,recording_id TEXT NOT NULL,
  audio BLOB NOT NULL,pcm BLOB,features BLOB,analysis TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(session_id,recording_id))`);
old.prepare('INSERT INTO recording_assets VALUES (?,?,?,?,?,?)').run('session', 'legacy', Buffer.from('old audio'), null, null, '{}');
old.close();
const storage = require('../src/persistence');

test('legacy SQLite migration retains cloud audio while allowing durable analysis-only assets and resumable chunks', async t => {
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const previous = await storage.getRecordingAsset('session', 'legacy', {audio: true});
  assert.equal(previous.audio.toString(), 'old audio');
  await storage.putRecordingAsset('session', 'local', {audio: null, features: Buffer.from('features'), analysis: {words: []}});
  await storage.putRecordingChunk('session', 'local', 1, Buffer.from('chunk'), {localRevision: 1});
  await storage.putRecordingChunk('session', 'local', 1, Buffer.from('updated chunk'), {localRevision: 1, transcribed: true});
  const overview = await storage.getRecordingAsset('session', 'local', {audio: true, features: false});
  assert.equal(overview.audio, null); assert.equal(overview.features, null); assert.equal(overview.featuresReady, true);
  const chunks = await storage.getRecordingChunks('session', 'local', {features: true});
  assert.equal(chunks.length, 1); assert.equal(chunks[0].features.toString(), 'updated chunk');
  assert.equal(chunks[0].analysis.transcribed, true);
  const inspection = new DatabaseSync(filename, {readOnly: true});
  assert.equal(inspection.prepare('SELECT audio FROM recording_assets WHERE recording_id=?').get('local').audio, null);
  assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM recording_chunks').get().count, 1);
  inspection.close();
  await storage.deleteRecordingAssets('session', 'local');
  assert.deepEqual(await storage.getRecordingChunks('session', 'local'), []);
  assert.equal(await storage.getRecordingAsset('session', 'local'), null);
  assert.equal((await storage.getRecordingAsset('session', 'legacy', {audio: true})).audio.toString(), 'old audio');
});
