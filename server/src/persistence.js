const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const APP_DIRECTORY_NAME = 'subtitle-machine';
const STORE_KEYS = ['users', 'authSessions', 'sessions'];
const LEGACY_DATA_DIR = path.join(__dirname, '..', 'data');
const LEGACY_STORE_FILE_PATH = path.join(LEGACY_DATA_DIR, 'app-store.json');

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
const DATABASE_FILE_PATH = path.join(DATA_DIR, 'app-store.sqlite');
let database = null;

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

function initializeDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_store (
      store_key TEXT PRIMARY KEY,
      store_value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function getDatabase() {
  if (database) {
    return database;
  }

  ensureDataDir();
  database = new DatabaseSync(DATABASE_FILE_PATH);
  initializeDatabase(database);
  return database;
}

function readLegacyStoreFile() {
  if (!fs.existsSync(LEGACY_STORE_FILE_PATH)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(LEGACY_STORE_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      raw,
      store: normalizeStore(parsed),
    };
  } catch (error) {
    console.warn('Failed to read legacy JSON store, skipping migration.', error);
    return null;
  }
}

function archiveAndRemoveLegacyStore(raw) {
  ensureDataDir();
  const backupPath = path.join(DATA_DIR, `legacy-app-store-${Date.now()}.json`);
  fs.writeFileSync(backupPath, raw, 'utf8');
  fs.unlinkSync(LEGACY_STORE_FILE_PATH);
}

function writeStore(db, store) {
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

function migrateLegacyStoreIfNeeded(db) {
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

  writeStore(db, legacyStore.store);

  try {
    archiveAndRemoveLegacyStore(legacyStore.raw);
  } catch (error) {
    console.warn('Legacy JSON store migrated but cleanup failed.', error);
  }
}

function loadStore() {
  const db = getDatabase();
  migrateLegacyStoreIfNeeded(db);

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

function saveStore(store) {
  const db = getDatabase();
  writeStore(db, store);
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
  DATABASE_FILE_PATH,
  LEGACY_STORE_FILE_PATH,
  createOpaqueToken,
  createPasswordHash,
  hashToken,
  loadStore,
  parseCookieHeader,
  saveStore,
  verifyPassword,
};
