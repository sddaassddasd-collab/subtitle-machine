const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');

const APP_DIRECTORY_NAME = 'subtitle-machine';
const STORE_KEYS = ['users', 'authSessions', 'sessions'];
const LEGACY_DATA_DIR = path.join(__dirname, '..', 'data');
const LEGACY_STORE_FILE_PATH = path.join(LEGACY_DATA_DIR, 'app-store.json');
const DATABASE_URL =
  typeof process.env.DATABASE_URL === 'string'
    ? process.env.DATABASE_URL.trim()
    : '';
const PERSISTENCE_BACKEND = DATABASE_URL ? 'postgres' : 'sqlite';

function resolveDataDir() {
  const configuredDir =
    typeof process.env.SUBTITLE_MACHINE_DATA_DIR === 'string'
      ? process.env.SUBTITLE_MACHINE_DATA_DIR.trim()
      : '';
  if (configuredDir) {
    return path.resolve(configuredDir);
  }

  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      APP_DIRECTORY_NAME,
    );
  }

  if (process.platform === 'win32') {
    const appData =
      typeof process.env.APPDATA === 'string' && process.env.APPDATA.trim()
        ? process.env.APPDATA.trim()
        : path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, APP_DIRECTORY_NAME);
  }

  const xdgDataHome =
    typeof process.env.XDG_DATA_HOME === 'string'
      ? process.env.XDG_DATA_HOME.trim()
      : '';
  return path.join(
    xdgDataHome || path.join(os.homedir(), '.local', 'share'),
    APP_DIRECTORY_NAME,
  );
}

const DATA_DIR = resolveDataDir();
const SQLITE_FILE_PATH = path.join(DATA_DIR, 'app-store.sqlite');
let sqliteDatabase = null;
let postgresPoolPromise = null;
let saveQueue = Promise.resolve();
let sqliteModule = null;

function createEmptyStore() {
  return {
    users: [],
    authSessions: [],
    sessions: [],
  };
}

function normalizeStore(store) {
  return {
    users: Array.isArray(store?.users) ? store.users : [],
    authSessions: Array.isArray(store?.authSessions) ? store.authSessions : [],
    sessions: Array.isArray(store?.sessions) ? store.sessions : [],
  };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getSqliteDatabaseSync() {
  if (!sqliteModule) {
    try {
      sqliteModule = require('node:sqlite');
    } catch (error) {
      throw new Error(
        'SQLite persistence requires a Node.js runtime that supports node:sqlite.',
        { cause: error },
      );
    }
  }

  return sqliteModule.DatabaseSync;
}

function normalizeBooleanEnv(rawValue, fallback = false) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function createPostgresConfig() {
  const useSsl = normalizeBooleanEnv(
    process.env.POSTGRES_SSL,
    normalizeBooleanEnv(process.env.PGSSLMODE === 'require' ? 'true' : '', false),
  );
  const config = {
    connectionString: DATABASE_URL,
  };

  if (useSsl) {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

function initializeSqliteDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_store (
      store_key TEXT PRIMARY KEY,
      store_value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recording_assets (
      session_id TEXT NOT NULL,
      recording_id TEXT NOT NULL,
      audio BLOB,
      pcm BLOB,
      features BLOB,
      analysis TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (session_id, recording_id)
    );
  `);
  if (db.prepare('PRAGMA table_info(recording_assets)').all().find(column => column.name === 'audio')?.notnull) {
    try { db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE recording_assets RENAME TO recording_assets_legacy;
      CREATE TABLE recording_assets (session_id TEXT NOT NULL, recording_id TEXT NOT NULL,
        audio BLOB, pcm BLOB, features BLOB, analysis TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (session_id, recording_id));
      INSERT INTO recording_assets SELECT * FROM recording_assets_legacy;
      DROP TABLE recording_assets_legacy;
      COMMIT;`); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS recording_chunks (
    session_id TEXT NOT NULL, recording_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
    features BLOB NOT NULL, analysis TEXT NOT NULL,
    PRIMARY KEY (session_id, recording_id, chunk_index))`);
  db.exec(`CREATE TABLE IF NOT EXISTS follow_runs (
    session_id TEXT NOT NULL, run_id TEXT NOT NULL, started_at INTEGER NOT NULL,
    ended_at INTEGER, data TEXT NOT NULL, PRIMARY KEY(session_id, run_id));
    CREATE INDEX IF NOT EXISTS follow_runs_session ON follow_runs(session_id, started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS follow_runs_open ON follow_runs(session_id) WHERE ended_at IS NULL;
    CREATE TABLE IF NOT EXISTS follow_events (
    session_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id, run_id, sequence));`);
}

function getSqliteDatabase() {
  if (sqliteDatabase) {
    return sqliteDatabase;
  }

  ensureDataDir();
  const DatabaseSync = getSqliteDatabaseSync();
  sqliteDatabase = new DatabaseSync(SQLITE_FILE_PATH);
  initializeSqliteDatabase(sqliteDatabase);
  return sqliteDatabase;
}

async function initializePostgresDatabase(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_store (
      store_key TEXT PRIMARY KEY,
      store_value JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);
  await pool.query(`CREATE TABLE IF NOT EXISTS recording_assets (
    session_id TEXT NOT NULL, recording_id TEXT NOT NULL, audio BYTEA,
    pcm BYTEA, features BYTEA, analysis JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (session_id, recording_id)
  )`);
  await pool.query('ALTER TABLE recording_assets ALTER COLUMN audio DROP NOT NULL');
  await pool.query(`CREATE TABLE IF NOT EXISTS recording_chunks (
    session_id TEXT NOT NULL, recording_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
    features BYTEA NOT NULL, analysis JSONB NOT NULL,
    PRIMARY KEY (session_id, recording_id, chunk_index))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS follow_runs (
    session_id TEXT NOT NULL, run_id TEXT NOT NULL, started_at BIGINT NOT NULL,
    ended_at BIGINT, data JSONB NOT NULL, PRIMARY KEY(session_id, run_id))`);
  await pool.query('CREATE INDEX IF NOT EXISTS follow_runs_session ON follow_runs(session_id, started_at DESC)');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS follow_runs_open ON follow_runs(session_id) WHERE ended_at IS NULL');
  await pool.query(`CREATE TABLE IF NOT EXISTS follow_events (
    session_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY(session_id, run_id, sequence))`);
}

async function getPostgresPool() {
  if (!postgresPoolPromise) {
    postgresPoolPromise = (async () => {
      const pool = new Pool(createPostgresConfig());
      await initializePostgresDatabase(pool);
      return pool;
    })();
  }

  return postgresPoolPromise;
}

function readLegacyStoreFile() {
  if (!fs.existsSync(LEGACY_STORE_FILE_PATH)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(LEGACY_STORE_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      source: 'legacy-json',
      raw,
      store: normalizeStore(parsed),
    };
  } catch (error) {
    console.warn('Failed to read legacy JSON store, skipping migration.', error);
    return null;
  }
}

function readStoreFromSqliteFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  let db = null;
  try {
    const DatabaseSync = getSqliteDatabaseSync();
    db = new DatabaseSync(filePath);
    const appStoreTable = db
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'app_store'
        `,
      )
      .get();

    if (!appStoreTable) {
      return null;
    }

    const store = createEmptyStore();
    const rows = db
      .prepare(
        `
          SELECT store_key, store_value
          FROM app_store
          WHERE store_key IN (?, ?, ?)
        `,
      )
      .all(...STORE_KEYS);

    rows.forEach((row) => {
      if (!STORE_KEYS.includes(row?.store_key)) {
        return;
      }

      try {
        const parsed = JSON.parse(row.store_value);
        store[row.store_key] = Array.isArray(parsed) ? parsed : [];
      } catch (_error) {
        store[row.store_key] = [];
      }
    });

    return {
      source: 'legacy-sqlite',
      store,
    };
  } catch (error) {
    console.warn('Failed to read legacy SQLite store, skipping migration.', error);
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close failures.
      }
    }
  }
}

function writeLegacyBackupFile(raw, sourceLabel = 'legacy-json') {
  ensureDataDir();
  const backupPath = path.join(
    DATA_DIR,
    `${sourceLabel}-backup-${Date.now()}.json`,
  );
  fs.writeFileSync(backupPath, raw, 'utf8');
}

function removeLegacyStoreFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return;
  }
  fs.unlinkSync(filePath);
}

function writeStoreToSqlite(db, store) {
  const normalized = normalizeStore(store);
  const statement = db.prepare(`
    INSERT INTO app_store (store_key, store_value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(store_key) DO UPDATE SET
      store_value = excluded.store_value,
      updated_at = excluded.updated_at
  `);
  const now = Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    STORE_KEYS.forEach((storeKey) => {
      statement.run(storeKey, JSON.stringify(normalized[storeKey]), now);
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function writeRecordingAssetsToPostgres(client, filePath, sessions) {
  const DatabaseSync = getSqliteDatabaseSync();
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recording_assets'").get()) return;
    const bytes = value => value ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : null;
    const retained = new Set(sessions.flatMap(session => Array.isArray(session?.recordings)
      ? session.recordings.filter(recording => recording?.id).map(recording => JSON.stringify([session.id, recording.id])) : []));
    // Copy one asset at a time within the same transaction as its manifest.
    // A failed migration leaves PostgreSQL empty and can safely be retried.
    for (const asset of db.prepare('SELECT * FROM recording_assets').iterate()) {
      if (!retained.has(JSON.stringify([asset.session_id, asset.recording_id]))) continue;
      await client.query(`INSERT INTO recording_assets (session_id, recording_id, audio, pcm, features, analysis)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (session_id, recording_id) DO NOTHING`,
      [asset.session_id, asset.recording_id, bytes(asset.audio), bytes(asset.pcm), bytes(asset.features), asset.analysis]);
    }
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recording_chunks'").get()) {
      for (const chunk of db.prepare('SELECT * FROM recording_chunks').iterate()) {
        if (!retained.has(JSON.stringify([chunk.session_id, chunk.recording_id]))) continue;
        await client.query(`INSERT INTO recording_chunks (session_id,recording_id,chunk_index,features,analysis)
          VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
        [chunk.session_id, chunk.recording_id, chunk.chunk_index, bytes(chunk.features), chunk.analysis]);
      }
    }
  } finally { db.close(); }
}

async function writeFollowHistoryToPostgres(client, filePath, sessions) {
  const DatabaseSync = getSqliteDatabaseSync();
  const db = new DatabaseSync(filePath, {readOnly: true});
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='follow_runs'").get()) return;
    const retained = new Set(sessions.map(session => session.id));
    for (const row of db.prepare('SELECT * FROM follow_runs').iterate()) {
      if (!retained.has(row.session_id)) continue;
      await client.query(`INSERT INTO follow_runs VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
        [row.session_id, row.run_id, row.started_at, row.ended_at, row.data]);
    }
    for (const row of db.prepare('SELECT * FROM follow_events').iterate()) {
      if (!retained.has(row.session_id)) continue;
      await client.query(`INSERT INTO follow_events VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
        [row.session_id, row.run_id, row.sequence, row.event_type, row.data]);
    }
  } finally { db.close(); }
}

async function writeStoreToPostgres(pool, store, sqlitePath = null) {
  const normalized = normalizeStore(store);
  const now = Date.now();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    for (const storeKey of STORE_KEYS) {
      await client.query(
        `
          INSERT INTO app_store (store_key, store_value, updated_at)
          VALUES ($1, $2::jsonb, $3)
          ON CONFLICT (store_key) DO UPDATE SET
            store_value = EXCLUDED.store_value,
            updated_at = EXCLUDED.updated_at
        `,
        [storeKey, JSON.stringify(normalized[storeKey]), now],
      );
    }
    if (sqlitePath) {
      await writeRecordingAssetsToPostgres(client, sqlitePath, normalized.sessions);
      await writeFollowHistoryToPostgres(client, sqlitePath, normalized.sessions);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function migrateToSqliteIfNeeded(db) {
  const row = db
    .prepare('SELECT COUNT(*) AS entryCount FROM app_store')
    .get();
  const entryCount = Number(row?.entryCount || 0);

  if (entryCount > 0) {
    return;
  }

  const legacyStore = readLegacyStoreFile();
  if (!legacyStore) {
    return;
  }

  writeStoreToSqlite(db, legacyStore.store);

  try {
    writeLegacyBackupFile(legacyStore.raw, legacyStore.source);
    removeLegacyStoreFile(LEGACY_STORE_FILE_PATH);
  } catch (error) {
    console.warn('Legacy JSON store migrated but cleanup failed.', error);
  }
}

async function migrateToPostgresIfNeeded(pool) {
  const existing = await pool.query('SELECT COUNT(*)::int AS entry_count FROM app_store');
  const entryCount = Number(existing.rows?.[0]?.entry_count || 0);

  if (entryCount > 0) {
    return;
  }

  const legacyJsonStore = readLegacyStoreFile();
  if (legacyJsonStore) {
    await writeStoreToPostgres(pool, legacyJsonStore.store);
    try {
      writeLegacyBackupFile(legacyJsonStore.raw, legacyJsonStore.source);
      removeLegacyStoreFile(LEGACY_STORE_FILE_PATH);
    } catch (error) {
      console.warn('Legacy JSON store migrated but cleanup failed.', error);
    }
    return;
  }

  const sqliteStore = readStoreFromSqliteFile(SQLITE_FILE_PATH);
  if (sqliteStore) {
    await writeStoreToPostgres(pool, sqliteStore.store, SQLITE_FILE_PATH);
  }
}

async function loadStoreFromSqlite() {
  const db = getSqliteDatabase();
  await migrateToSqliteIfNeeded(db);

  const store = createEmptyStore();
  const rows = db
    .prepare(
      `
        SELECT store_key, store_value
        FROM app_store
        WHERE store_key IN (?, ?, ?)
      `,
    )
    .all(...STORE_KEYS);

  rows.forEach((row) => {
    if (!STORE_KEYS.includes(row?.store_key)) {
      return;
    }

    try {
      const parsed = JSON.parse(row.store_value);
      store[row.store_key] = Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      store[row.store_key] = [];
    }
  });

  return store;
}

async function loadStoreFromPostgres() {
  const pool = await getPostgresPool();
  await migrateToPostgresIfNeeded(pool);

  const store = createEmptyStore();
  const result = await pool.query(
    `
      SELECT store_key, store_value
      FROM app_store
      WHERE store_key = ANY($1::text[])
    `,
    [STORE_KEYS],
  );

  result.rows.forEach((row) => {
    if (!STORE_KEYS.includes(row?.store_key)) {
      return;
    }
    store[row.store_key] = Array.isArray(row.store_value) ? row.store_value : [];
  });

  return store;
}

async function loadStore() {
  if (PERSISTENCE_BACKEND === 'postgres') {
    return loadStoreFromPostgres();
  }
  return loadStoreFromSqlite();
}

function scheduleSave(work) {
  saveQueue = saveQueue
    .catch(() => {})
    .then(() => work());
  return saveQueue;
}

function saveStore(store) {
  const normalized = normalizeStore(store);

  if (PERSISTENCE_BACKEND === 'postgres') {
    return scheduleSave(async () => {
      const pool = await getPostgresPool();
      await writeStoreToPostgres(pool, normalized);
    });
  }

  return scheduleSave(async () => {
    const db = getSqliteDatabase();
    writeStoreToSqlite(db, normalized);
  });
}

// Audio is stored separately from the small application snapshot: advancing a
// cue must never rewrite a recording. Both supported backends retain the assets.
async function putRecordingAsset(sessionId, recordingId, asset) {
  if (PERSISTENCE_BACKEND === 'postgres') {
    const pool = await getPostgresPool();
    await pool.query(`INSERT INTO recording_assets
      (session_id, recording_id, audio, pcm, features, analysis) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (session_id, recording_id) DO UPDATE SET
      audio=EXCLUDED.audio, pcm=EXCLUDED.pcm, features=EXCLUDED.features, analysis=EXCLUDED.analysis`,
    [sessionId, recordingId, asset.audio || null, asset.pcm || null, asset.features || null, JSON.stringify(asset.analysis || {})]);
  } else {
    getSqliteDatabase().prepare(`INSERT OR REPLACE INTO recording_assets
      (session_id, recording_id, audio, pcm, features, analysis) VALUES (?,?,?,?,?,?)`)
      .run(sessionId, recordingId, asset.audio || null, asset.pcm || null, asset.features || null, JSON.stringify(asset.analysis || {}));
  }
}

async function getRecordingAsset(sessionId, recordingId, { audio = false, pcm = false, features = true } = {}) {
  const columns = `${features ? 'features' : '(features IS NOT NULL) AS features_ready'}, analysis${audio ? ', audio' : ''}${pcm ? ', pcm' : ''}`;
  let row;
  if (PERSISTENCE_BACKEND === 'postgres') {
    row = (await (await getPostgresPool()).query(`SELECT ${columns} FROM recording_assets
      WHERE session_id=$1 AND recording_id=$2`, [sessionId, recordingId])).rows[0];
  } else {
    row = getSqliteDatabase().prepare(`SELECT ${columns} FROM recording_assets
      WHERE session_id=? AND recording_id=?`).get(sessionId, recordingId);
  }
  if (!row) return null;
  const bytes = value => value ? (Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength)) : null;
  return { ...row, analysis: typeof row.analysis === 'string' ? JSON.parse(row.analysis) : row.analysis,
    featuresReady: features ? Boolean(row.features) : Boolean(row.features_ready),
    features: bytes(row.features), audio: bytes(row.audio), pcm: bytes(row.pcm) };
}

async function updateRecordingAnalysis(sessionId, recordingId, features, analysis) {
  if (PERSISTENCE_BACKEND === 'postgres') {
    await (await getPostgresPool()).query(`UPDATE recording_assets SET
      features=COALESCE($3,features), pcm=CASE WHEN $3 IS NULL THEN pcm ELSE NULL END, analysis=$4
      WHERE session_id=$1 AND recording_id=$2`, [sessionId, recordingId, features, JSON.stringify(analysis)]);
  } else {
    getSqliteDatabase().prepare(`UPDATE recording_assets SET features=COALESCE(?,features),
      pcm=CASE WHEN ? IS NULL THEN pcm ELSE NULL END, analysis=? WHERE session_id=? AND recording_id=?`)
      .run(features, features, JSON.stringify(analysis), sessionId, recordingId);
  }
}

async function getRecordingAudioRange(sessionId, recordingId, start, length) {
  if (PERSISTENCE_BACKEND === 'postgres') {
    const row = (await (await getPostgresPool()).query(`SELECT SUBSTRING(audio FROM $3::int FOR $4::int) AS audio
      FROM recording_assets WHERE session_id=$1 AND recording_id=$2`, [sessionId, recordingId, start + 1, length])).rows[0];
    return row?.audio ? Buffer.from(row.audio) : null;
  }
  const row = getSqliteDatabase().prepare(`SELECT SUBSTR(audio,?,?) AS audio FROM recording_assets
    WHERE session_id=? AND recording_id=?`).get(start + 1, length, sessionId, recordingId);
  return row?.audio ? Buffer.from(row.audio) : null;
}

async function deleteRecordingAssets(sessionId, recordingId = null) {
  await deleteRecordingChunks(sessionId, recordingId);
  if (PERSISTENCE_BACKEND === 'postgres') {
    await (await getPostgresPool()).query(`DELETE FROM recording_assets WHERE session_id=$1${recordingId ? ' AND recording_id=$2' : ''}`,
      recordingId ? [sessionId, recordingId] : [sessionId]);
  } else {
    getSqliteDatabase().prepare(`DELETE FROM recording_assets WHERE session_id=?${recordingId ? ' AND recording_id=?' : ''}`)
      .run(...(recordingId ? [sessionId, recordingId] : [sessionId]));
  }
}

async function putRecordingChunk(sessionId, recordingId, index, features, analysis) {
  const values = [sessionId, recordingId, index, features, JSON.stringify(analysis)];
  if (PERSISTENCE_BACKEND === 'postgres') {
    await (await getPostgresPool()).query(`INSERT INTO recording_chunks
      (session_id,recording_id,chunk_index,features,analysis) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (session_id,recording_id,chunk_index) DO UPDATE SET features=EXCLUDED.features,analysis=EXCLUDED.analysis`, values);
  } else {
    getSqliteDatabase().prepare(`INSERT OR REPLACE INTO recording_chunks
      (session_id,recording_id,chunk_index,features,analysis) VALUES (?,?,?,?,?)`).run(...values);
  }
}

async function getRecordingChunks(sessionId, recordingId, {features = false} = {}) {
  const columns = `chunk_index,analysis${features ? ',features' : ''}`;
  const rows = PERSISTENCE_BACKEND === 'postgres'
    ? (await (await getPostgresPool()).query(`SELECT ${columns} FROM recording_chunks WHERE session_id=$1 AND recording_id=$2 ORDER BY chunk_index`, [sessionId, recordingId])).rows
    : getSqliteDatabase().prepare(`SELECT ${columns} FROM recording_chunks WHERE session_id=? AND recording_id=? ORDER BY chunk_index`).all(sessionId, recordingId);
  return rows.map(row => ({index: row.chunk_index,
    analysis: typeof row.analysis === 'string' ? JSON.parse(row.analysis) : row.analysis,
    ...(features ? {features: Buffer.from(row.features)} : {})}));
}

async function deleteRecordingChunks(sessionId, recordingId = null) {
  const values = recordingId ? [sessionId, recordingId] : [sessionId];
  if (PERSISTENCE_BACKEND === 'postgres') {
    await (await getPostgresPool()).query(`DELETE FROM recording_chunks WHERE session_id=$1${recordingId ? ' AND recording_id=$2' : ''}`, values);
  } else {
    getSqliteDatabase().prepare(`DELETE FROM recording_chunks WHERE session_id=?${recordingId ? ' AND recording_id=?' : ''}`).run(...values);
  }
}

// History is independent of the frequently rewritten session store and audio assets.
// A batch commits its append-only events and recovery cursor atomically. Retrying
// the same batch is safe, including after a lost PostgreSQL acknowledgement.
async function saveFollowHistory(run, events) {
  const values = [run.sessionId, run.id, run.startedAt, run.endedAt, JSON.stringify(run)];
  if (PERSISTENCE_BACKEND === 'postgres') {
    const client = await (await getPostgresPool()).connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO follow_runs VALUES ($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT(session_id,run_id) DO UPDATE SET ended_at=EXCLUDED.ended_at,data=EXCLUDED.data`, values);
      if (events.length) await client.query(`INSERT INTO follow_events(session_id,run_id,sequence,event_type,data)
        SELECT $1,$2,(event->>'sequence')::int,event->>'type',event FROM jsonb_array_elements($3::jsonb) event
        ON CONFLICT DO NOTHING`, [run.sessionId, run.id, JSON.stringify(events)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } else {
    const db = getSqliteDatabase();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO follow_runs VALUES (?,?,?,?,?) ON CONFLICT(session_id,run_id)
        DO UPDATE SET ended_at=excluded.ended_at,data=excluded.data`).run(...values);
      const insert = db.prepare('INSERT OR IGNORE INTO follow_events VALUES (?,?,?,?,?)');
      for (const event of events) insert.run(run.sessionId, run.id, event.sequence, event.type, JSON.stringify(event));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}
const followData = row => row ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) : null;
async function getOpenFollowRun(sessionId) {
  const row = PERSISTENCE_BACKEND === 'postgres'
    ? (await (await getPostgresPool()).query('SELECT data FROM follow_runs WHERE session_id=$1 AND ended_at IS NULL', [sessionId])).rows[0]
    : getSqliteDatabase().prepare('SELECT data FROM follow_runs WHERE session_id=? AND ended_at IS NULL').get(sessionId);
  const run = followData(row);
  if (!run) return null;
  const context = PERSISTENCE_BACKEND === 'postgres'
    ? (await (await getPostgresPool()).query(`SELECT data FROM follow_events WHERE session_id=$1 AND run_id=$2
      AND event_type='context' ORDER BY sequence DESC LIMIT 1`, [sessionId, run.id])).rows[0]
    : getSqliteDatabase().prepare(`SELECT data FROM follow_events WHERE session_id=? AND run_id=?
      AND event_type='context' ORDER BY sequence DESC LIMIT 1`).get(sessionId, run.id);
  return {run, context: followData(context)};
}
async function listOpenFollowSessionIds() {
  const rows = PERSISTENCE_BACKEND === 'postgres'
    ? (await (await getPostgresPool()).query('SELECT session_id FROM follow_runs WHERE ended_at IS NULL')).rows
    : getSqliteDatabase().prepare('SELECT session_id FROM follow_runs WHERE ended_at IS NULL').all();
  return rows.map(row => row.session_id);
}
async function listFollowRuns(sessionId, limit = 20, offset = 0) {
  const rows = PERSISTENCE_BACKEND === 'postgres'
    ? (await (await getPostgresPool()).query(`SELECT data FROM follow_runs WHERE session_id=$1
      ORDER BY started_at DESC,run_id DESC LIMIT $2 OFFSET $3`, [sessionId, limit, offset])).rows
    : getSqliteDatabase().prepare(`SELECT data FROM follow_runs WHERE session_id=?
      ORDER BY started_at DESC,run_id DESC LIMIT ? OFFSET ?`).all(sessionId, limit, offset);
  return rows.map(followData);
}
async function getFollowRun(sessionId, runId, {summary = false} = {}) {
  const row = PERSISTENCE_BACKEND === 'postgres'
    ? (await (await getPostgresPool()).query('SELECT data FROM follow_runs WHERE session_id=$1 AND run_id=$2', [sessionId, runId])).rows[0]
    : getSqliteDatabase().prepare('SELECT data FROM follow_runs WHERE session_id=? AND run_id=?').get(sessionId, runId);
  if (!row) return null;
  const run = followData(row), boundary = Number.isSafeInteger(run.nextSequence) ? run.nextSequence : 2147483647;
  const details = ['decision_trace', 'transcript_revision', 'acoustic_summary', 'capture_summary'];
  // The panel needs all cue visits, but only recent diagnostic previews. Avoid
  // reading hours of word arrays and trace samples on its five-second refresh.
  const filter = summary ? " AND event_type NOT IN ('decision_trace','transcript_revision','acoustic_summary','capture_summary')" : '';
  const rows = PERSISTENCE_BACKEND === 'postgres'
    ? (await (await getPostgresPool()).query(`SELECT data FROM follow_events WHERE session_id=$1 AND run_id=$2 AND sequence<$3${filter} ORDER BY sequence`, [sessionId, runId, boundary])).rows
    : getSqliteDatabase().prepare(`SELECT data FROM follow_events WHERE session_id=? AND run_id=? AND sequence<?${filter} ORDER BY sequence`).all(sessionId, runId, boundary);
  const events = rows.map(followData);
  if (!summary) return {run, events};
  const recent = PERSISTENCE_BACKEND === 'postgres'
    ? (await (await getPostgresPool()).query('SELECT data FROM follow_events WHERE session_id=$1 AND run_id=$2 AND sequence<$3 ORDER BY sequence DESC LIMIT 80', [sessionId, runId, boundary])).rows
    : getSqliteDatabase().prepare('SELECT data FROM follow_events WHERE session_id=? AND run_id=? AND sequence<? ORDER BY sequence DESC LIMIT 80').all(sessionId, runId, boundary);
  for (const row of recent) {
    const event = followData(row);
    if (!details.includes(event.type)) continue;
    const {samples, words: _words, before: _before, after: _after, normalizedText: _normalized, ...preview} = event;
    events.push({...preview, ...(samples ? {sampleCount: samples.length, samples: []} : {})});
  }
  events.sort((a, b) => a.sequence - b.sequence);
  return {run, events, scope: 'summary'};
}
async function deleteFollowHistory(sessionId, runId = null) {
  if (PERSISTENCE_BACKEND === 'postgres') {
    const client = await (await getPostgresPool()).connect();
    const values = runId ? [sessionId, runId] : [sessionId];
    const where = `session_id=$1${runId ? ' AND run_id=$2' : ''}`;
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM follow_events WHERE ${where}`, values);
      await client.query(`DELETE FROM follow_runs WHERE ${where}`, values);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } else {
    const db = getSqliteDatabase(), values = runId ? [sessionId, runId] : [sessionId];
    const where = `session_id=?${runId ? ' AND run_id=?' : ''}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`DELETE FROM follow_events WHERE ${where}`).run(...values);
      db.prepare(`DELETE FROM follow_runs WHERE ${where}`).run(...values);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}

function createOpaqueToken(byteLength = 18) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createPasswordHash(password) {
  const salt = createOpaqueToken(16);
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
  if (typeof passwordHash !== 'string') return false;
  const [scheme, salt, expected] = passwordHash.split(':');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseCookieHeader(headerValue = '') {
  return String(headerValue || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex <= 0) return cookies;
      const name = decodeURIComponent(part.slice(0, separatorIndex).trim());
      const value = decodeURIComponent(part.slice(separatorIndex + 1).trim());
      cookies[name] = value;
      return cookies;
    }, {});
}

module.exports = {
  DATA_DIR,
  DATABASE_URL,
  LEGACY_STORE_FILE_PATH,
  PERSISTENCE_BACKEND,
  SQLITE_FILE_PATH,
  createOpaqueToken,
  createPasswordHash,
  hashToken,
  loadStore,
  parseCookieHeader,
  saveStore,
  putRecordingAsset,
  getRecordingAsset,
  updateRecordingAnalysis,
  getRecordingAudioRange,
  deleteRecordingAssets,
  putRecordingChunk,
  getRecordingChunks,
  deleteRecordingChunks,
  saveFollowHistory,
  getOpenFollowRun,
  listOpenFollowSessionIds,
  listFollowRuns,
  getFollowRun,
  deleteFollowHistory,
  verifyPassword,
};
