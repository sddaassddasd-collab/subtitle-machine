const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE_PATH = path.join(DATA_DIR, 'app-store.json');

function createEmptyStore() {
  return {
    users: [],
    authSessions: [],
    sessions: [],
  };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStore() {
  ensureDataDir();

  if (!fs.existsSync(STORE_FILE_PATH)) {
    const emptyStore = createEmptyStore();
    fs.writeFileSync(
      STORE_FILE_PATH,
      JSON.stringify(emptyStore, null, 2),
      'utf8',
    );
    return emptyStore;
  }

  try {
    const raw = fs.readFileSync(STORE_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed?.users) ? parsed.users : [],
      authSessions: Array.isArray(parsed?.authSessions) ? parsed.authSessions : [],
      sessions: Array.isArray(parsed?.sessions) ? parsed.sessions : [],
    };
  } catch (_error) {
    return createEmptyStore();
  }
}

function saveStore(store) {
  ensureDataDir();
  const tempPath = `${STORE_FILE_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tempPath, STORE_FILE_PATH);
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
  STORE_FILE_PATH,
  createOpaqueToken,
  createPasswordHash,
  hashToken,
  loadStore,
  parseCookieHeader,
  saveStore,
  verifyPassword,
};
