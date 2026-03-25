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
  `);
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

async function writeStoreToPostgres(pool, store) {
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
    await writeStoreToPostgres(pool, sqliteStore.store);
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
  verifyPassword,
};
