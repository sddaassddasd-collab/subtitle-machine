const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { OpenAI } = require('openai');
const { OpenAIRealtimeWS } = require('openai/realtime/ws');
const { toFile } = require('openai/uploads');
const OpenCC = require('opencc-js');
const {
  createOpaqueToken,
  createPasswordHash,
  hashToken,
  loadStore,
  parseCookieHeader,
  PERSISTENCE_BACKEND,
  saveStore,
  verifyPassword,
} = require('./persistence');

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const DEV_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const ALLOWED_ORIGINS = parseAllowedOrigins(
  process.env.ALLOWED_ORIGINS,
  IS_PRODUCTION ? [] : DEV_ALLOWED_ORIGINS,
);
const COOKIE_SECURE = normalizeBooleanEnv(
  process.env.COOKIE_SECURE,
  IS_PRODUCTION,
);
const COOKIE_SAME_SITE = normalizeSameSiteValue(
  process.env.COOKIE_SAME_SITE,
  'lax',
);
const TRUST_PROXY_SETTING = normalizeTrustProxySetting(
  process.env.TRUST_PROXY,
  IS_PRODUCTION ? 1 : false,
);
const rateLimitBuckets = new Map();
let lastRateLimitSweepAt = 0;

if (IS_PRODUCTION && ALLOWED_ORIGINS.size === 0) {
  console.warn(
    'ALLOWED_ORIGINS is empty in production; configure it before exposing this service publicly.',
  );
}

if (COOKIE_SAME_SITE === 'none' && !COOKIE_SECURE) {
  console.warn(
    'COOKIE_SAME_SITE=none without COOKIE_SECURE=true is unsafe and may break modern browsers.',
  );
}

const app = express();
app.set('trust proxy', TRUST_PROXY_SETTING);
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      callback(null, !origin || isOriginAllowed(origin));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  },
});

app.use(appSecurityHeaders);
app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, !origin || isOriginAllowed(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  }),
);
app.use(express.json({ limit: '6mb' }));
app.use(authMiddleware);

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});

const sessions = new Map();
const transcriptionStreams = new Map();
const users = new Map();
const authSessions = new Map();
const viewerSessionTombstones = new Map();
const projectorSessionTombstones = new Map();
const projectorConnections = new Map();
const projectorPresence = new Map();
const AUTH_COOKIE_NAME = 'subtitle_machine_auth';
const ACCESS_COOKIE_NAME = 'subtitle_machine_access';
const AUTH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const PASSWORD_RESET_TTL_MS = 1000 * 60 * 15;
const PROJECTOR_PRESENCE_TTL_MS = 1000 * 35;
const PROJECTOR_PRESENCE_SWEEP_INTERVAL_MS = 5000;
const SESSION_HISTORY_LIMIT = 80;
const USER_ROLES = {
  ADMIN: 'admin',
  OPERATOR: 'operator',
  VIEWER: 'viewer',
};
const USER_ROLE_ORDER = [
  USER_ROLES.ADMIN,
  USER_ROLES.OPERATOR,
  USER_ROLES.VIEWER,
];
const ADMIN_BOOTSTRAP_USERNAME = normalizeUsername(
  process.env.ADMIN_BOOTSTRAP_USERNAME || '',
);
const ADMIN_BOOTSTRAP_PASSWORD = normalizePassword(
  process.env.ADMIN_BOOTSTRAP_PASSWORD || '',
);
const SHARED_ACCESS_PASSWORD = normalizePassword(
  process.env.SUBTITLE_MACHINE_ACCESS_PASSWORD || '20141017',
);
const SHARED_ACCESS_USER_ID = 'shared_access_user';
const SHARED_ACCESS_USERNAME = '控制端';
let projectorPresenceSweepTimer = null;
const SHARED_ACCESS_COOKIE_VALUE = hashToken(
  `shared-access:${SHARED_ACCESS_PASSWORD}`,
);
const SESSION_BACKUP_KIND = 'subtitle-machine-session-backup';
const SESSION_BACKUP_VERSION = 1;
const VIEWER_ALIAS_MAX_LENGTH = 48;

const defaultTranscriptionState = () => ({
  active: false,
  status: 'idle',
  text: '',
  isFinal: true,
  language: null,
  model: DEFAULT_TRANSCRIPTION_MODEL,
  transcriptionContext: '',
  semanticSegmentationEnabled:
    DEFAULT_TRANSCRIPTION_SEMANTIC_SEGMENTATION_ENABLED,
  dualChannelEnabled: DEFAULT_TRANSCRIPTION_DUAL_CHANNEL_ENABLED,
  speakerRecognitionEnabled:
    DEFAULT_TRANSCRIPTION_SPEAKER_RECOGNITION_ENABLED,
  error: '',
  updatedAt: null,
});

const DEFAULT_PROJECTOR_LAYOUT = Object.freeze({
  fontSizePercent: 100,
  offsetX: 0,
  offsetY: 24,
});
const PROJECTOR_DISPLAY_MODES = Object.freeze({
  SCRIPT: 'script',
  TRANSCRIPTION: 'transcription',
});

const PROJECTOR_STATUS_LEVELS = Object.freeze({
  IDLE: 'idle',
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
});

const DEFAULT_PROJECTOR_STATUS = Object.freeze({
  level: PROJECTOR_STATUS_LEVELS.IDLE,
  code: '',
  message: '',
  updatedAt: null,
});

const placeholderRegex = /^[第]?[零〇一二三四五六七八九十百千\d]+[句行條話]$/i;

const LINE_TYPES = {
  DIALOGUE: 'dialogue',
  DIRECTION: 'direction',
};

const MAX_LINE_WIDTH_UNITS = 20;
const MAX_LATIN_LINE_WIDTH_UNITS = MAX_LINE_WIDTH_UNITS * 3;
const MAX_LINE_BREAK_OVERSHOOT = 1.5;
const FULL_WIDTH_SUBTITLE_CHAR_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u;
const SUBTITLE_BREAK_WHITESPACE_PATTERN = /[\s\u3000]/u;
const SUBTITLE_BREAK_PUNCTUATION_PATTERN = /[，,、；;。．.!！？?：:…]/u;
const DEFAULT_SESSION_ID = 'default';
const MAX_CHUNK_LENGTH = 2500;
const MAX_PENDING_AUDIO_CHUNKS = 400;
const MAX_TRANSCRIPTION_DISPLAY_LINES = 8;
const MAX_TRANSCRIPTION_CONTEXT_CHARS = 600;
const SECONDARY_ALIGNMENT_DP_MAX_COMPLEXITY = 45000;
const LATIN_SCRIPT_LANGUAGE_CODES = new Set([
  'ca',
  'cs',
  'da',
  'de',
  'en',
  'es',
  'fi',
  'fr',
  'hr',
  'hu',
  'is',
  'it',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'sk',
  'sl',
  'sv',
  'tr',
]);
const LATIN_SCRIPT_CHAR_GLOBAL_PATTERN = /\p{Script=Latin}/gu;
const CJK_SCRIPT_CHAR_GLOBAL_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const LATIN_WORD_PATTERN =
  /[\p{Script=Latin}]+(?:['’\-][\p{Script=Latin}]+)*/gu;
const LATIN_SINGLE_WORD_PATTERN =
  /[\p{Script=Latin}]+(?:['’\-][\p{Script=Latin}]+)*/u;
const LATIN_BREAK_PUNCTUATION_PATTERN = /[,;:.!?…]/u;
const LATIN_STRONG_BREAK_PUNCTUATION_PATTERN = /[.!?…]/u;
const LATIN_WEAK_BREAK_PUNCTUATION_PATTERN = /[,;:]/u;
const LATIN_BOUNDARY_TRAILING_DECORATION_PATTERN = /["')\]»”’]/u;
const LATIN_BASE_BOUNDARY_SUFFIX_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'so',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'from',
  'with',
  'into',
  'onto',
  'by',
  'as',
  'if',
  'than',
  'then',
  'that',
  'this',
  'these',
  'those',
  'my',
  'your',
  'his',
  'her',
  'its',
  'our',
  'their',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'am',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'will',
  'would',
  'can',
  'could',
  'should',
  'may',
  'might',
  'must',
  'not',
]);
const LATIN_BASE_BOUNDARY_PREFIX_WORDS = new Set([
  'and',
  'or',
  'but',
  'so',
  'because',
  'if',
  'when',
  'while',
  'though',
  'although',
  'that',
  'which',
  'who',
  'whom',
  'whose',
  'where',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'from',
  'with',
  'into',
  'onto',
  'by',
  'as',
  'than',
  'then',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'am',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'will',
  'would',
  'can',
  'could',
  'should',
  'may',
  'might',
  'must',
  'not',
]);
const LATIN_BASE_ABBREVIATIONS = new Set([
  'dr',
  'etc',
  'eg',
  'ie',
  'mr',
  'mrs',
  'ms',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
]);
const FRENCH_BOUNDARY_SUFFIX_WORDS = new Set([
  'au',
  'aux',
  'ce',
  'ces',
  'cette',
  'de',
  'des',
  'du',
  'en',
  'et',
  'la',
  'le',
  'les',
  'mais',
  'ou',
  'pour',
  'que',
  'qui',
  'sur',
  'un',
  'une',
]);
const FRENCH_BOUNDARY_PREFIX_WORDS = new Set([
  'au',
  'aux',
  'avec',
  'dans',
  'de',
  'des',
  'du',
  'en',
  'et',
  'la',
  'le',
  'les',
  'mais',
  'ou',
  'par',
  'pour',
  'que',
  'qui',
  'sans',
  'sur',
  'un',
  'une',
]);
const FRENCH_ABBREVIATIONS = new Set([
  'dr',
  'env',
  'etc',
  'm',
  'mlle',
  'mme',
  'pr',
]);
const GERMAN_BOUNDARY_SUFFIX_WORDS = new Set([
  'aber',
  'am',
  'an',
  'auf',
  'bei',
  'das',
  'dem',
  'den',
  'der',
  'des',
  'die',
  'ein',
  'eine',
  'einem',
  'einen',
  'einer',
  'eines',
  'für',
  'im',
  'in',
  'mit',
  'oder',
  'und',
  'von',
  'vom',
  'zu',
  'zum',
  'zur',
]);
const GERMAN_BOUNDARY_PREFIX_WORDS = new Set([
  'aber',
  'am',
  'an',
  'auf',
  'bei',
  'das',
  'dem',
  'den',
  'der',
  'des',
  'die',
  'ein',
  'eine',
  'einem',
  'einen',
  'einer',
  'eines',
  'für',
  'im',
  'in',
  'mit',
  'oder',
  'und',
  'von',
  'vom',
  'zu',
  'zum',
  'zur',
]);
const GERMAN_ABBREVIATIONS = new Set([
  'bzw',
  'ca',
  'dh',
  'dr',
  'ggf',
  'prof',
  'usw',
  'zb',
]);
const SCRIPT_SEGMENTATION_PROFILES = Object.freeze({
  cjk: Object.freeze({
    key: 'cjk',
    family: 'cjk',
    maxLineWidthUnits: MAX_LINE_WIDTH_UNITS,
    maxLineBreakOvershoot: MAX_LINE_BREAK_OVERSHOOT,
    avoidBoundarySuffixWords: new Set(),
    avoidBoundaryPrefixWords: new Set(),
    abbreviations: new Set(),
  }),
  latin: Object.freeze({
    key: 'latin',
    family: 'latin',
    maxLineWidthUnits: MAX_LATIN_LINE_WIDTH_UNITS,
    maxLineBreakOvershoot: 3,
    avoidBoundarySuffixWords: mergeWordSets(LATIN_BASE_BOUNDARY_SUFFIX_WORDS),
    avoidBoundaryPrefixWords: mergeWordSets(LATIN_BASE_BOUNDARY_PREFIX_WORDS),
    abbreviations: mergeWordSets(LATIN_BASE_ABBREVIATIONS),
  }),
  fr: Object.freeze({
    key: 'fr',
    family: 'latin',
    maxLineWidthUnits: MAX_LATIN_LINE_WIDTH_UNITS,
    maxLineBreakOvershoot: 3.5,
    avoidBoundarySuffixWords: mergeWordSets(
      LATIN_BASE_BOUNDARY_SUFFIX_WORDS,
      FRENCH_BOUNDARY_SUFFIX_WORDS,
    ),
    avoidBoundaryPrefixWords: mergeWordSets(
      LATIN_BASE_BOUNDARY_PREFIX_WORDS,
      FRENCH_BOUNDARY_PREFIX_WORDS,
    ),
    abbreviations: mergeWordSets(LATIN_BASE_ABBREVIATIONS, FRENCH_ABBREVIATIONS),
  }),
  de: Object.freeze({
    key: 'de',
    family: 'latin',
    maxLineWidthUnits: MAX_LATIN_LINE_WIDTH_UNITS,
    maxLineBreakOvershoot: 4,
    avoidBoundarySuffixWords: mergeWordSets(
      LATIN_BASE_BOUNDARY_SUFFIX_WORDS,
      GERMAN_BOUNDARY_SUFFIX_WORDS,
    ),
    avoidBoundaryPrefixWords: mergeWordSets(
      LATIN_BASE_BOUNDARY_PREFIX_WORDS,
      GERMAN_BOUNDARY_PREFIX_WORDS,
    ),
    abbreviations: mergeWordSets(LATIN_BASE_ABBREVIATIONS, GERMAN_ABBREVIATIONS),
  }),
});
const AUDIO_PCM_SAMPLE_RATE = 24000;
const AUDIO_PCM_BYTES_PER_SAMPLE = 2;
const parsedForceCommitIntervalMs = Number(
  process.env.TRANSCRIPTION_FORCE_COMMIT_INTERVAL_MS,
);
const FORCE_COMMIT_INTERVAL_MS = Number.isFinite(parsedForceCommitIntervalMs)
  ? Math.max(0, parsedForceCommitIntervalMs)
  : 900;
const parsedCommitCooldownMs = Number(
  process.env.TRANSCRIPTION_COMMIT_COOLDOWN_MS,
);
const COMMIT_COOLDOWN_MS = Number.isFinite(parsedCommitCooldownMs)
  ? Math.max(0, parsedCommitCooldownMs)
  : 500;
const parsedMinCommitAudioMs = Number(
  process.env.TRANSCRIPTION_MIN_COMMIT_AUDIO_MS,
);
const MIN_COMMIT_AUDIO_MS = Number.isFinite(parsedMinCommitAudioMs)
  ? Math.max(0, parsedMinCommitAudioMs)
  : 400;
const TRANSCRIPTION_CORRECTION_MODEL =
  process.env.TRANSCRIPTION_CORRECTION_MODEL || 'gpt-4o-mini';
const SECONDARY_ALIGNMENT_MODEL =
  process.env.SECONDARY_ALIGNMENT_MODEL || 'gpt-4o';
const SECONDARY_ALIGNMENT_PARSE_LIMIT_MULTIPLIER = 3;
const TRANSCRIPTION_CORRECTION_ENABLED =
  process.env.TRANSCRIPTION_CORRECTION_ENABLED !== 'false';
const DEFAULT_TRANSCRIPTION_SEMANTIC_SEGMENTATION_ENABLED =
  process.env.TRANSCRIPTION_SEMANTIC_SEGMENTATION_ENABLED !== 'false';
const DEFAULT_TRANSCRIPTION_SPEAKER_RECOGNITION_ENABLED =
  process.env.TRANSCRIPTION_SPEAKER_RECOGNITION_ENABLED === 'true';
const VALID_SEMANTIC_VAD_EAGERNESS = new Set([
  'low',
  'medium',
  'high',
  'auto',
]);
const TRANSCRIPTION_SEMANTIC_VAD_EAGERNESS = VALID_SEMANTIC_VAD_EAGERNESS.has(
  process.env.TRANSCRIPTION_SEMANTIC_VAD_EAGERNESS,
)
  ? process.env.TRANSCRIPTION_SEMANTIC_VAD_EAGERNESS
  : 'high';
const parsedSemanticFallbackCommitMs = Number(
  process.env.TRANSCRIPTION_SEMANTIC_FALLBACK_COMMIT_MS,
);
const TRANSCRIPTION_SEMANTIC_FALLBACK_COMMIT_MS = Number.isFinite(
  parsedSemanticFallbackCommitMs,
)
  ? Math.max(0, parsedSemanticFallbackCommitMs)
  : 2200;
const parsedSilenceLevelThreshold = Number(
  process.env.TRANSCRIPTION_SILENCE_LEVEL_THRESHOLD,
);
const TRANSCRIPTION_SILENCE_LEVEL_THRESHOLD = Number.isFinite(
  parsedSilenceLevelThreshold,
)
  ? Math.min(Math.max(parsedSilenceLevelThreshold, 0), 1)
  : 0.012;
const parsedBoundaryMinChars = Number(
  process.env.TRANSCRIPTION_BOUNDARY_MIN_CHARS,
);
const TRANSCRIPTION_BOUNDARY_MIN_CHARS = Number.isFinite(parsedBoundaryMinChars)
  ? Math.max(1, Math.floor(parsedBoundaryMinChars))
  : 10;
const parsedBoundarySoftMaxChars = Number(
  process.env.TRANSCRIPTION_BOUNDARY_SOFT_MAX_CHARS,
);
const TRANSCRIPTION_BOUNDARY_SOFT_MAX_CHARS = Number.isFinite(
  parsedBoundarySoftMaxChars,
)
  ? Math.max(TRANSCRIPTION_BOUNDARY_MIN_CHARS, Math.floor(parsedBoundarySoftMaxChars))
  : 26;
const parsedBoundaryHardMaxChars = Number(
  process.env.TRANSCRIPTION_BOUNDARY_HARD_MAX_CHARS,
);
const TRANSCRIPTION_BOUNDARY_HARD_MAX_CHARS = Number.isFinite(
  parsedBoundaryHardMaxChars,
)
  ? Math.max(
      TRANSCRIPTION_BOUNDARY_SOFT_MAX_CHARS,
      Math.floor(parsedBoundaryHardMaxChars),
    )
  : 38;
const parsedBoundaryWeakPauseMs = Number(
  process.env.TRANSCRIPTION_BOUNDARY_WEAK_PAUSE_MS,
);
const TRANSCRIPTION_BOUNDARY_WEAK_PAUSE_MS = Number.isFinite(
  parsedBoundaryWeakPauseMs,
)
  ? Math.max(0, parsedBoundaryWeakPauseMs)
  : 120;
const parsedBoundaryStrongPauseMs = Number(
  process.env.TRANSCRIPTION_BOUNDARY_STRONG_PAUSE_MS,
);
const TRANSCRIPTION_BOUNDARY_STRONG_PAUSE_MS = Number.isFinite(
  parsedBoundaryStrongPauseMs,
)
  ? Math.max(
      TRANSCRIPTION_BOUNDARY_WEAK_PAUSE_MS,
      parsedBoundaryStrongPauseMs,
    )
  : 320;
const DEFAULT_TRANSCRIPTION_DUAL_CHANNEL_ENABLED =
  process.env.TRANSCRIPTION_DUAL_CHANNEL_ENABLED !== 'false';
const parsedSpeakerWindowMaxLines = Number(
  process.env.TRANSCRIPTION_SPEAKER_WINDOW_MAX_LINES,
);
const TRANSCRIPTION_SPEAKER_WINDOW_MAX_LINES = Number.isFinite(
  parsedSpeakerWindowMaxLines,
)
  ? Math.max(2, Math.floor(parsedSpeakerWindowMaxLines))
  : 4;
const parsedSpeakerWindowMaxMs = Number(
  process.env.TRANSCRIPTION_SPEAKER_WINDOW_MAX_MS,
);
const TRANSCRIPTION_SPEAKER_WINDOW_MAX_MS = Number.isFinite(
  parsedSpeakerWindowMaxMs,
)
  ? Math.max(1000, parsedSpeakerWindowMaxMs)
  : 16000;
const TRANSCRIPTION_ACCURATE_MODEL =
  process.env.TRANSCRIPTION_ACCURATE_MODEL || 'gpt-4o-transcribe-latest';
const TRANSCRIPTION_ACCURATE_PROMPT =
  typeof process.env.TRANSCRIPTION_ACCURATE_PROMPT === 'string'
    ? process.env.TRANSCRIPTION_ACCURATE_PROMPT.trim()
    : '';
const parsedAccurateMinSegmentMs = Number(
  process.env.TRANSCRIPTION_ACCURATE_MIN_SEGMENT_MS,
);
const TRANSCRIPTION_ACCURATE_MIN_SEGMENT_MS = Number.isFinite(
  parsedAccurateMinSegmentMs,
)
  ? Math.max(0, parsedAccurateMinSegmentMs)
  : 400;
const parsedAccurateMaxSegmentMs = Number(
  process.env.TRANSCRIPTION_ACCURATE_MAX_SEGMENT_MS,
);
const TRANSCRIPTION_ACCURATE_MAX_SEGMENT_MS = Number.isFinite(
  parsedAccurateMaxSegmentMs,
)
  ? Math.max(1000, parsedAccurateMaxSegmentMs)
  : 8000;
const parsedAccurateMaxPendingSegments = Number(
  process.env.TRANSCRIPTION_ACCURATE_MAX_PENDING_SEGMENTS,
);
const TRANSCRIPTION_ACCURATE_MAX_PENDING_SEGMENTS = Number.isFinite(
  parsedAccurateMaxPendingSegments,
)
  ? Math.max(1, parsedAccurateMaxPendingSegments)
  : 40;
const TRANSCRIPTION_TRADITIONAL_OUTPUT_ENABLED =
  process.env.TRANSCRIPTION_TRADITIONAL_OUTPUT_ENABLED !== 'false';
const TRANSCRIPTION_TRADITIONAL_OUTPUT_PROMPT =
  typeof process.env.TRANSCRIPTION_TRADITIONAL_OUTPUT_PROMPT === 'string'
    ? process.env.TRANSCRIPTION_TRADITIONAL_OUTPUT_PROMPT.trim()
    : '';
const punctuationOnlyRegex = /^[\p{P}\p{S}\s]+$/u;
const strongSentencePunctuationRegex = /[。！？!?]$/u;
const weakSentencePunctuationRegex = /[，,、；;：:]$/u;
const englishStrongSentencePunctuationRegex = /[.!?]["')\]]*$/u;
const englishWeakSentencePunctuationRegex = /[,;:]["')\]]*$/u;
const avoidBoundarySuffixRegex =
  /(的|了|著|过|過|在|跟|和|與|及|而且|但是|如果|因為|所以|就是|然後|還有|對|把|被|給|讓|嗎|呢|吧)$/u;
const avoidBoundaryPrefixRegex =
  /^(的|了|著|过|過|在|跟|和|與|及|而且|但是|如果|因為|所以|就是|然後|還有|對|把|被|給|讓|嗎|呢|吧)/u;
const avoidEnglishBoundarySuffixRegex =
  /\b(a|an|the|and|or|but|so|to|of|in|on|at|for|from|with|into|onto|by|as|if|than|then|that|this|these|those|my|your|his|her|its|our|their|is|are|was|were|be|been|being|am|do|does|did|have|has|had|will|would|can|could|should|may|might|must|not)$/iu;
const avoidEnglishBoundaryPrefixRegex =
  /^(and|or|but|so|because|if|when|while|though|although|that|which|who|whom|whose|where|to|of|in|on|at|for|from|with|into|onto|by|as|than|then|is|are|was|were|be|been|being|am|do|does|did|have|has|had|will|would|can|could|should|may|might|must|not)\b/iu;
const DEFAULT_REALTIME_WS_MODEL =
  process.env.OPENAI_REALTIME_WS_MODEL || 'gpt-realtime';
const DEFAULT_REALTIME_SESSION_TYPE = 'realtime';
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';
const VALID_TRANSCRIPTION_MODELS = new Set([
  'gpt-4o-transcribe',
  'gpt-4o-transcribe-latest',
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe-diarize',
  'whisper-1',
]);

const fallbackCodes = new Set([
  'INVALID_LLM_OUTPUT',
  'PLACEHOLDER_OUTPUT',
  'INVALID_JSON',
  'MISSING_OUTPUT',
  'EMPTY_OUTPUT',
]);

let cnToTraditionalTaiwanConverter = null;
try {
  cnToTraditionalTaiwanConverter = OpenCC.Converter({
    from: 'cn',
    to: 'twp',
  });
} catch (error) {
  console.warn('Failed to initialize OpenCC converter:', error);
}

function clampLineType(rawType) {
  if (typeof rawType !== 'string') return null;
  const normalized = rawType.toLowerCase();
  if (normalized === LINE_TYPES.DIALOGUE) return LINE_TYPES.DIALOGUE;
  if (normalized === LINE_TYPES.DIRECTION) return LINE_TYPES.DIRECTION;
  return null;
}

function normalizeLineMusic(rawMusic) {
  return rawMusic === true;
}

function normalizeInteger(rawValue, fallback, min = null, max = null) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (Number.isFinite(min) && rounded < min) return min;
  if (Number.isFinite(max) && rounded > max) return max;
  return rounded;
}

function normalizeProjectorLayout(rawLayout) {
  const source =
    rawLayout && typeof rawLayout === 'object'
      ? rawLayout
      : DEFAULT_PROJECTOR_LAYOUT;

  return {
    fontSizePercent: normalizeInteger(
      source.fontSizePercent,
      DEFAULT_PROJECTOR_LAYOUT.fontSizePercent,
    ),
    offsetX: normalizeInteger(source.offsetX, DEFAULT_PROJECTOR_LAYOUT.offsetX),
    offsetY: normalizeInteger(source.offsetY, DEFAULT_PROJECTOR_LAYOUT.offsetY),
  };
}

function projectorLayoutsEqual(leftLayout, rightLayout) {
  const left = normalizeProjectorLayout(leftLayout);
  const right = normalizeProjectorLayout(rightLayout);
  return (
    left.fontSizePercent === right.fontSizePercent &&
    left.offsetX === right.offsetX &&
    left.offsetY === right.offsetY
  );
}

function normalizeProjectorDisplayMode(rawMode) {
  return rawMode === PROJECTOR_DISPLAY_MODES.TRANSCRIPTION
    ? PROJECTOR_DISPLAY_MODES.TRANSCRIPTION
    : PROJECTOR_DISPLAY_MODES.SCRIPT;
}

function normalizeProjectorRevision(rawRevision) {
  return normalizeInteger(rawRevision, 0, 0, Number.MAX_SAFE_INTEGER);
}

function isLineMarkedMusic(entry) {
  return Boolean(entry && typeof entry === 'object' && entry.music === true);
}

function stripBom(text) {
  if (!text) return '';
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function extractJsonArray(raw) {
  if (typeof raw !== 'string') return null;
  const start = raw.indexOf('[');
  if (start === -1) return null;
  let candidate = raw.slice(start);
  const end = candidate.lastIndexOf(']');
  if (end !== -1) {
    candidate = candidate.slice(0, end + 1);
  }
  candidate = candidate.trim();
  if (!candidate.startsWith('[')) {
    candidate = `[${candidate}`;
  }
  if (!candidate.endsWith(']')) {
    const lastBrace = candidate.lastIndexOf('}');
    if (lastBrace !== -1) {
      candidate = `${candidate.slice(0, lastBrace + 1)}]`;
    }
  }
  candidate = candidate.replace(/,\s*\]$/, ']');
  return candidate;
}

function parseJsonArrayLoose(raw) {
  if (typeof raw !== 'string') {
    const error = new Error('原始內容不是字串');
    error.code = 'INVALID_JSON';
    throw error;
  }

  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // try to salvage array portion
  }

  const candidate = extractJsonArray(trimmed);
  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch {
      // will attempt regex extraction below
    }
  }

  const matches = trimmed.match(/\{[^{}]*\}/g);
  if (matches && matches.length > 0) {
    const reconstructed = `[${matches.join(',')}]`;
    try {
      return JSON.parse(reconstructed);
    } catch {
      // fallthrough to error
    }
  }

  const error = new Error('OpenAI 回傳內容不是有效 JSON');
  error.code = 'INVALID_JSON';
  error.details = trimmed.slice(0, 2000);
  throw error;
}

function generateId(prefix) {
  const core = createOpaqueToken(12);
  return prefix ? `${prefix}_${core}` : core;
}

function normalizeUsername(rawUsername) {
  if (typeof rawUsername !== 'string') return '';
  return stripBom(rawUsername).trim().toLowerCase();
}

function normalizeDisplayName(rawUsername) {
  if (typeof rawUsername !== 'string') return '';
  return stripBom(rawUsername).trim().slice(0, 48);
}

function normalizeViewerAlias(rawAlias) {
  if (typeof rawAlias !== 'string') return '';

  return stripBom(rawAlias)
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s]+/gu, '-')
    .replace(/[–—－ー]+/gu, '-')
    .replace(
      /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Latin}\p{Number}_-]+/gu,
      '',
    )
    .replace(/-{2,}/g, '-')
    .replace(/_{2,}/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, VIEWER_ALIAS_MAX_LENGTH);
}

function normalizePassword(rawPassword) {
  if (typeof rawPassword !== 'string') return '';
  return rawPassword.trim();
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

function normalizeSameSiteValue(rawValue, fallback = 'lax') {
  if (typeof rawValue !== 'string') return fallback;
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'strict' || normalized === 'lax' || normalized === 'none') {
    return normalized;
  }
  return fallback;
}

function parseAllowedOrigins(rawValue, fallbackOrigins = []) {
  const providedOrigins =
    typeof rawValue === 'string' && rawValue.trim()
      ? rawValue
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean)
      : [];
  return new Set(providedOrigins.length > 0 ? providedOrigins : fallbackOrigins);
}

function normalizeTrustProxySetting(rawValue, fallback = false) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(normalized)) {
    return false;
  }
  if (['true', '1', 'on', 'yes'].includes(normalized)) {
    return true;
  }
  if (/^\d+$/.test(normalized)) {
    return Number.parseInt(normalized, 10);
  }

  return rawValue.trim();
}

function isOriginAllowed(origin) {
  if (typeof origin !== 'string' || !origin.trim()) {
    return true;
  }
  return ALLOWED_ORIGINS.has(origin.trim());
}

function appSecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');

  if (IS_PRODUCTION) {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  }

  next();
}

function sweepRateLimitBucketsIfNeeded() {
  const now = Date.now();
  if (now - lastRateLimitSweepAt < 60 * 1000) {
    return;
  }

  lastRateLimitSweepAt = now;
  Array.from(rateLimitBuckets.entries()).forEach(([bucketKey, bucket]) => {
    if (!bucket || !Number.isFinite(bucket.resetAt) || bucket.resetAt <= now) {
      rateLimitBuckets.delete(bucketKey);
    }
  });
}

function getRequestIp(req) {
  return (
    req.ip ||
    req.headers['x-forwarded-for'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function createRateLimitMiddleware({
  windowMs,
  max,
  message,
  keyPrefix,
  keyGenerator,
}) {
  return (req, res, next) => {
    sweepRateLimitBucketsIfNeeded();
    const now = Date.now();
    const derivedKey =
      typeof keyGenerator === 'function'
        ? keyGenerator(req)
        : getRequestIp(req);
    const bucketKey = `${keyPrefix}:${derivedKey || 'unknown'}`;
    const currentBucket = rateLimitBuckets.get(bucketKey);

    if (!currentBucket || currentBucket.resetAt <= now) {
      rateLimitBuckets.set(bucketKey, {
        count: 1,
        resetAt: now + windowMs,
      });
      return next();
    }

    if (currentBucket.count >= max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((currentBucket.resetAt - now) / 1000),
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: message });
    }

    currentBucket.count += 1;
    rateLimitBuckets.set(bucketKey, currentBucket);
    return next();
  };
}

function normalizeUserRole(rawRole, fallbackRole = USER_ROLES.VIEWER) {
  if (typeof rawRole !== 'string') return fallbackRole;
  const normalizedRole = rawRole.trim().toLowerCase();
  return USER_ROLE_ORDER.includes(normalizedRole) ? normalizedRole : fallbackRole;
}

function isUserDisabled(user) {
  return Boolean(
    user &&
      Number.isFinite(user.disabledAt) &&
      user.disabledAt > 0,
  );
}

function isSharedAccessUser(user) {
  return Boolean(
    user &&
      (user.isSharedAccess === true || user.id === SHARED_ACCESS_USER_ID),
  );
}

function canManageSessions(user) {
  if (isSharedAccessUser(user)) return true;
  if (!user || isUserDisabled(user)) return false;
  return (
    user.role === USER_ROLES.ADMIN || user.role === USER_ROLES.OPERATOR
  );
}

function isAdminUser(user) {
  if (isSharedAccessUser(user)) return false;
  return Boolean(user && user.role === USER_ROLES.ADMIN && !isUserDisabled(user));
}

function getPublicResetState(user) {
  const reset = user?.passwordReset;
  if (
    !reset ||
    typeof reset !== 'object' ||
    !Number.isFinite(reset.expiresAt) ||
    reset.expiresAt <= Date.now()
  ) {
    return null;
  }

  return {
    requestedAt:
      Number.isFinite(reset.requestedAt) && reset.requestedAt > 0
        ? reset.requestedAt
        : Number.isFinite(reset.createdAt) && reset.createdAt > 0
          ? reset.createdAt
        : null,
    expiresAt: reset.expiresAt,
  };
}

function serializeUser(user) {
  if (!user) return null;
  if (isSharedAccessUser(user)) {
    return {
      id: SHARED_ACCESS_USER_ID,
      username: SHARED_ACCESS_USERNAME,
      role: USER_ROLES.OPERATOR,
      disabled: false,
      disabledAt: null,
      canManageSessions: true,
      passwordReset: null,
      createdAt: null,
    };
  }
  return {
    id: user.id,
    username: user.username,
    role: normalizeUserRole(user.role, USER_ROLES.VIEWER),
    disabled: isUserDisabled(user),
    disabledAt: isUserDisabled(user) ? user.disabledAt : null,
    canManageSessions: canManageSessions(user),
    passwordReset: getPublicResetState(user),
    createdAt: user.createdAt,
  };
}

function createAuthTokenRecord(userId) {
  const token = createOpaqueToken(24);
  const now = Date.now();
  return {
    token,
    record: {
      id: generateId('auth'),
      tokenHash: hashToken(token),
      userId,
      createdAt: now,
      expiresAt: now + AUTH_TOKEN_TTL_MS,
    },
  };
}

function cleanupExpiredAuthSessions() {
  const now = Date.now();
  Array.from(authSessions.entries()).forEach(([tokenHash, record]) => {
    if (!record || !Number.isFinite(record.expiresAt) || record.expiresAt <= now) {
      authSessions.delete(tokenHash);
    }
  });
}

function cleanupExpiredPasswordResetTokens() {
  const now = Date.now();
  users.forEach((user) => {
    const reset = user?.passwordReset;
    if (
      reset &&
      (!Number.isFinite(reset.expiresAt) || reset.expiresAt <= now)
    ) {
      user.passwordReset = null;
    }
  });
}

function revokeUserAuthSessions(userId) {
  Array.from(authSessions.entries()).forEach(([tokenHash, record]) => {
    if (record?.userId === userId) {
      authSessions.delete(tokenHash);
    }
  });
}

function countAdminUsers() {
  return Array.from(users.values()).filter((user) => isAdminUser(user)).length;
}

function persistApplicationStore({ throwOnError = false } = {}) {
  cleanupExpiredAuthSessions();
  cleanupExpiredPasswordResetTokens();
  const nextStore = {
    users: Array.from(users.values()).map((user) => ({
      id: user.id,
      username: user.username,
      usernameNormalized: user.usernameNormalized,
      role: normalizeUserRole(user.role, USER_ROLES.VIEWER),
      disabledAt: isUserDisabled(user) ? user.disabledAt : null,
      passwordReset:
        user.passwordReset && typeof user.passwordReset === 'object'
          ? user.passwordReset
          : null,
      passwordHash: user.passwordHash,
      createdAt: user.createdAt,
    })),
    authSessions: Array.from(authSessions.values()).map((record) => ({
      id: record.id,
      tokenHash: record.tokenHash,
      userId: record.userId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    })),
    sessions: Array.from(sessions.values()).map((session) =>
      serializeSessionForStorage(session),
    ),
  };

  const savePromise = saveStore(nextStore);
  if (throwOnError) {
    return savePromise;
  }

  return savePromise.catch((error) => {
    console.error('Failed to persist application store:', error);
  });
}

function findUserByNormalizedUsername(usernameNormalized) {
  return Array.from(users.values()).find(
    (user) => user.usernameNormalized === usernameNormalized,
  );
}

function createSharedAccessUser() {
  return {
    id: SHARED_ACCESS_USER_ID,
    username: SHARED_ACCESS_USERNAME,
    usernameNormalized: SHARED_ACCESS_USERNAME.toLowerCase(),
    role: USER_ROLES.OPERATOR,
    disabledAt: null,
    passwordReset: null,
    passwordHash: '',
    createdAt: 0,
    isSharedAccess: true,
  };
}

function safeTokenEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isSharedAccessCookieValid(cookieValue) {
  return safeTokenEquals(cookieValue, SHARED_ACCESS_COOKIE_VALUE);
}

function resolveAuthFromCookieHeader(headerValue) {
  cleanupExpiredAuthSessions();
  cleanupExpiredPasswordResetTokens();
  const cookies = parseCookieHeader(headerValue);
  if (isSharedAccessCookieValid(cookies[ACCESS_COOKIE_NAME])) {
    return {
      user: createSharedAccessUser(),
      authSession: null,
    };
  }

  const token = cookies[AUTH_COOKIE_NAME];
  if (token) {
    const authSession = authSessions.get(hashToken(token));
    if (authSession) {
      const user = users.get(authSession.userId) || null;
      if (user && !isUserDisabled(user)) {
        return { user, authSession };
      }

      authSessions.delete(authSession.tokenHash);
    }
  }

  return { user: null, authSession: null };
}

function authMiddleware(req, res, next) {
  const { user, authSession } = resolveAuthFromCookieHeader(req.headers.cookie);
  req.authUser = user;
  req.authSession = authSession;
  if (!user && authSession?.tokenHash) {
    clearAuthCookie(res);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.authUser) {
    return res.status(401).json({ error: '請先登入' });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.authUser) {
    return res.status(401).json({ error: '請先登入' });
  }
  if (!isAdminUser(req.authUser)) {
    return res.status(403).json({ error: '需要管理員權限' });
  }
  return next();
}

function requireSessionManager(req, res, next) {
  if (!req.authUser) {
    return res.status(401).json({ error: '請先登入' });
  }
  if (!canManageSessions(req.authUser)) {
    return res.status(403).json({ error: '目前權限無法管理控制端場次' });
  }
  return next();
}

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: COOKIE_SAME_SITE,
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: AUTH_TOKEN_TTL_MS,
  });
}

function setAccessCookie(res) {
  res.cookie(ACCESS_COOKIE_NAME, SHARED_ACCESS_COOKIE_VALUE, {
    httpOnly: true,
    sameSite: COOKIE_SAME_SITE,
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: AUTH_TOKEN_TTL_MS,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: COOKIE_SAME_SITE,
    secure: COOKIE_SECURE,
    path: '/',
  });
}

function clearAccessCookie(res) {
  res.clearCookie(ACCESS_COOKIE_NAME, {
    httpOnly: true,
    sameSite: COOKIE_SAME_SITE,
    secure: COOKIE_SECURE,
    path: '/',
  });
}

function requestPasswordReset(user) {
  const now = Date.now();
  user.passwordReset = {
    requestedAt: now,
    expiresAt: now + PASSWORD_RESET_TTL_MS,
    status: 'pending',
  };
  return user.passwordReset;
}

function clearPasswordResetCode(user) {
  if (!user) return;
  user.passwordReset = null;
}

function createUserRecord({
  username,
  usernameNormalized,
  password,
  role = USER_ROLES.OPERATOR,
}) {
  return {
    id: generateId('user'),
    username,
    usernameNormalized,
    role: normalizeUserRole(role, USER_ROLES.VIEWER),
    disabledAt: null,
    passwordReset: null,
    passwordHash: createPasswordHash(password),
    createdAt: Date.now(),
  };
}

function ensureAdminBootstrapUser() {
  if (ADMIN_BOOTSTRAP_USERNAME && ADMIN_BOOTSTRAP_PASSWORD) {
    const existing = findUserByNormalizedUsername(ADMIN_BOOTSTRAP_USERNAME);
    if (!existing) {
      const bootstrapUser = createUserRecord({
        username: ADMIN_BOOTSTRAP_USERNAME,
        usernameNormalized: ADMIN_BOOTSTRAP_USERNAME,
        password: ADMIN_BOOTSTRAP_PASSWORD,
        role: USER_ROLES.ADMIN,
      });
      users.set(bootstrapUser.id, bootstrapUser);
    } else {
      existing.role = USER_ROLES.ADMIN;
      existing.disabledAt = null;
    }
  }

  if (countAdminUsers() === 0 && users.size > 0) {
    const oldestUser = Array.from(users.values()).sort(
      (left, right) => (left.createdAt || 0) - (right.createdAt || 0),
    )[0];
    if (oldestUser) {
      oldestUser.role = USER_ROLES.ADMIN;
      oldestUser.disabledAt = null;
    }
  }
}

function getAdminUserPayload(user) {
  const sessionCount = Array.from(sessions.values()).filter(
    (session) => session.ownerUserId === user.id,
  ).length;

  return {
    ...serializeUser(user),
    sessionCount,
  };
}

function getPublicSessionUnavailablePayload(
  role,
  { session = null, token = '', reason = '' } = {},
) {
  const roleLabel = role === 'projector' ? '投影端' : '檢視端';

  if (reason === 'deleted') {
    const message = `本場次已被移除，${roleLabel}已失效`;
    return {
      reason: 'deleted',
      message,
      error: message,
    };
  }

  if (session && session.status === 'ended') {
    const message = `本場次已結束，${roleLabel}已失效`;
    return {
      reason: 'ended',
      message,
      error: message,
    };
  }

  const tombstoneStore =
    role === 'projector' ? projectorSessionTombstones : viewerSessionTombstones;
  const tombstone =
    typeof token === 'string' && token.trim() ? tombstoneStore.get(token.trim()) : null;
  if (tombstone && typeof tombstone === 'object') {
    const message =
      typeof tombstone.message === 'string' && tombstone.message.trim()
        ? tombstone.message.trim()
        : `本場次已被移除，${roleLabel}已失效`;
    return {
      reason:
        typeof tombstone.reason === 'string' && tombstone.reason.trim()
          ? tombstone.reason.trim()
          : 'deleted',
      message,
      error: message,
    };
  }

  if (!session && IS_PRODUCTION && PERSISTENCE_BACKEND !== 'postgres') {
    const message =
      '場次不存在；若剛發生服務重啟或重新部署，且未使用資料庫保存場次，資料可能已遺失';
    return {
      reason: 'storage_lost',
      message,
      error: message,
    };
  }

  const message = '場次不存在';
  return {
    reason: 'missing',
    message,
    error: message,
  };
}

function rememberPublicSessionTombstones(session, reason = 'deleted') {
  if (!session || typeof session !== 'object') return;

  if (typeof session.viewerToken === 'string' && session.viewerToken.trim()) {
    viewerSessionTombstones.set(
      session.viewerToken.trim(),
      getPublicSessionUnavailablePayload('viewer', { reason }),
    );
  }
  if (typeof session.projectorToken === 'string' && session.projectorToken.trim()) {
    projectorSessionTombstones.set(
      session.projectorToken.trim(),
      getPublicSessionUnavailablePayload('projector', { reason }),
    );
  }
}

function clearPublicSessionTombstones(session) {
  if (!session || typeof session !== 'object') return;
  if (typeof session.viewerToken === 'string' && session.viewerToken.trim()) {
    viewerSessionTombstones.delete(session.viewerToken.trim());
  }
  if (typeof session.projectorToken === 'string' && session.projectorToken.trim()) {
    projectorSessionTombstones.delete(session.projectorToken.trim());
  }
}

function deleteOwnedSessionsForUser(userId, reason = 'owner removed') {
  const ownedSessions = Array.from(sessions.values()).filter(
    (session) => session.ownerUserId === userId,
  );

  ownedSessions.forEach((session) => {
    stopTranscriptionStream(session.id, {
      keepText: false,
      reason,
    });
    const viewerPayload = getPublicSessionUnavailablePayload('viewer', {
      reason: 'deleted',
    });
    const projectorPayload = getPublicSessionUnavailablePayload('projector', {
      reason: 'deleted',
    });
    io.to(`viewer:${session.id}`).emit('viewer:expired', viewerPayload);
    io.to(`projector:${session.id}`).emit('projector:expired', projectorPayload);
    rememberPublicSessionTombstones(session, 'deleted');
    clearProjectorPresence(session.id);
    projectorConnections.delete(session.id);
    sessions.delete(session.id);
  });

  return ownedSessions.length;
}

function ensureUserCanTransitionFromAdmin(user, nextRole, nextDisabled) {
  const removingAdminPrivileges =
    isAdminUser(user) &&
    (normalizeUserRole(nextRole, user.role) !== USER_ROLES.ADMIN ||
      nextDisabled === true);

  if (removingAdminPrivileges && countAdminUsers() <= 1) {
    return '至少要保留一個啟用中的管理員帳號';
  }

  return '';
}

function normalizePunctuation(text, languageCode = '') {
  if (typeof text !== 'string') return '';

  const profile = resolveScriptSegmentationProfile(languageCode, text);
  if (profile.family === 'latin') {
    return text
      .replace(/，/g, ',')
      .replace(/。|．/g, '.')
      .replace(/、/g, ',')
      .replace(/；/g, ';')
      .replace(/：/g, ':')
      .replace(/！/g, '!')
      .replace(/？/g, '?');
  }

  return text.replace(/[.,，。、]/g, ' ');
}

function normalizeScriptPromptText(text, languageCode = '') {
  if (typeof text !== 'string') return '';

  const stripped = stripBom(text);
  if (!stripped) return '';

  const profile = resolveScriptSegmentationProfile(languageCode, stripped);
  if (profile.family === 'latin') {
    return normalizePunctuation(stripped, languageCode);
  }

  return stripped;
}

function normalizeSecondaryAlignmentText(text, languageCode = '') {
  return normalizeScriptPromptText(text, languageCode);
}

function chunkLongUnit(unit, limit) {
  const chunks = [];
  let remaining = unit;

  while (remaining.length > limit) {
    chunks.push(remaining.slice(0, limit));
    remaining = remaining.slice(limit);
  }

  if (remaining.trim().length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function chunkScript(rawText, limit = MAX_CHUNK_LENGTH, options = {}) {
  const profile = resolveScriptSegmentationProfile(
    options.languageCode,
    rawText,
  );
  const units = [];

  rawText
    .split(/\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .forEach((paragraph) => {
      const sentences = splitScriptTextUnits(paragraph, profile, {
        includeWeakBreaks: false,
      });
      sentences.forEach((sentence) => {
        const trimmed = sentence.trim();
        if (trimmed) {
          units.push(trimmed);
        }
      });
    });

  if (units.length === 0) {
    return rawText.trim().length ? [rawText.trim()] : [];
  }

  const chunks = [];
  let current = '';

  const pushCurrent = () => {
    if (current.trim().length > 0) {
      chunks.push(current.trim());
    }
    current = '';
  };

  units.forEach((unit) => {
    if (unit.length > limit) {
      if (current) {
        pushCurrent();
      }
      chunkLongUnit(unit, limit).forEach((piece) => {
        chunks.push(piece.trim());
      });
      return;
    }

    const appended = current ? `${current}\n${unit}` : unit;
    if (appended.length > limit && current) {
      pushCurrent();
      current = unit;
    } else {
      current = appended;
    }
  });

  if (current) {
    pushCurrent();
  }

  return chunks.length ? chunks : [rawText.trim()];
}

function sanitizeLineText(text) {
  if (typeof text !== 'string') {
    text = text == null ? '' : String(text);
  }
  return stripBom(text).replace(/\r?\n/g, ' ').trim();
}

function mergeWordSets(...sets) {
  const merged = new Set();

  sets.forEach((set) => {
    if (!(set instanceof Set)) return;
    set.forEach((word) => {
      const normalized = normalizeLatinWord(word);
      if (normalized) {
        merged.add(normalized);
      }
    });
  });

  return merged;
}

function normalizeLanguageCode(rawLanguageCode) {
  if (typeof rawLanguageCode !== 'string') return '';
  const sanitized = rawLanguageCode.trim().toLowerCase();
  if (!sanitized) return '';

  const [base] = sanitized.split(/[-_]/u);
  return base || sanitized;
}

function normalizeLatinWord(word) {
  if (typeof word !== 'string') return '';
  return word
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^'\p{Script=Latin}]+/gu, '')
    .replace(/^'+|'+$/g, '');
}

function countScriptMatches(text, pattern) {
  if (typeof text !== 'string' || !text) return 0;
  return (text.match(pattern) || []).length;
}

function isLatinHeavyTextSample(text) {
  const sanitized = sanitizeLineText(text);
  if (!sanitized) return false;

  const latinMatches = countScriptMatches(
    sanitized,
    LATIN_SCRIPT_CHAR_GLOBAL_PATTERN,
  );
  if (latinMatches < 4) return false;

  const cjkMatches = countScriptMatches(sanitized, CJK_SCRIPT_CHAR_GLOBAL_PATTERN);
  return latinMatches >= cjkMatches;
}

function resolveScriptSegmentationProfile(languageCode = '', sampleText = '') {
  const normalizedCode = normalizeLanguageCode(languageCode);

  if (normalizedCode === 'fr') {
    return SCRIPT_SEGMENTATION_PROFILES.fr;
  }
  if (normalizedCode === 'de') {
    return SCRIPT_SEGMENTATION_PROFILES.de;
  }
  if (/^(zh|ja|ko)$/u.test(normalizedCode)) {
    return SCRIPT_SEGMENTATION_PROFILES.cjk;
  }
  if (normalizedCode && LATIN_SCRIPT_LANGUAGE_CODES.has(normalizedCode)) {
    return SCRIPT_SEGMENTATION_PROFILES.latin;
  }
  if (isLatinHeavyTextSample(sampleText)) {
    return SCRIPT_SEGMENTATION_PROFILES.latin;
  }

  return SCRIPT_SEGMENTATION_PROFILES.cjk;
}

function getLastLatinWord(text) {
  if (typeof text !== 'string') return '';
  const matches = text.match(LATIN_WORD_PATTERN) || [];
  return normalizeLatinWord(matches[matches.length - 1] || '');
}

function getFirstLatinWord(text) {
  if (typeof text !== 'string') return '';
  const match = text.match(LATIN_SINGLE_WORD_PATTERN);
  return normalizeLatinWord(match ? match[0] : '');
}

function consumeLatinBoundaryTail(text, startIndex) {
  let index = startIndex;
  while (index < text.length) {
    const char = text[index];
    if (
      LATIN_STRONG_BREAK_PUNCTUATION_PATTERN.test(char) ||
      LATIN_BOUNDARY_TRAILING_DECORATION_PATTERN.test(char)
    ) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function isLatinBoundaryAbbreviation(leftRawText, rightRawText, profile) {
  const left = sanitizeLineText(leftRawText);
  if (!left) return false;

  if (/(\d)\.(\d)$/u.test(left)) {
    return /^\d/u.test((rightRawText || '').trim());
  }
  if (/(?:\b\p{Script=Latin}\.){2,}["')\]]*$/u.test(left)) {
    return true;
  }

  const wordMatch = left.match(/([\p{Script=Latin}]+)\.["')\]]*$/u);
  if (!wordMatch) return false;

  const normalizedWord = normalizeLatinWord(wordMatch[1]);
  if (!normalizedWord) return false;
  if (profile.abbreviations.has(normalizedWord)) return true;
  if (normalizedWord.length <= 2 && (rightRawText || '').trim()) {
    return true;
  }

  return false;
}

function shouldSplitLatinSentenceAt({
  sentenceText,
  boundaryIndex,
  boundaryEnd,
  profile,
  includeWeakBreaks,
}) {
  const boundaryChar = sentenceText[boundaryIndex];
  if (!boundaryChar) return false;
  if (!includeWeakBreaks && LATIN_WEAK_BREAK_PUNCTUATION_PATTERN.test(boundaryChar)) {
    return false;
  }

  const leftRawText = sentenceText.slice(0, boundaryEnd);
  const rightRawText = sentenceText.slice(boundaryEnd);
  if (!rightRawText.trim()) return true;

  if (LATIN_STRONG_BREAK_PUNCTUATION_PATTERN.test(boundaryChar)) {
    if (boundaryChar === '.' && isLatinBoundaryAbbreviation(leftRawText, rightRawText, profile)) {
      return false;
    }

    const nextLatinWord = getFirstLatinWord(rightRawText);
    const nextNonWhitespaceChar = (rightRawText.match(/\S/u) || [''])[0];
    if (
      boundaryChar === '.' &&
      nextLatinWord &&
      /^\p{Ll}/u.test(nextNonWhitespaceChar)
    ) {
      return false;
    }
    return true;
  }

  return LATIN_WEAK_BREAK_PUNCTUATION_PATTERN.test(boundaryChar);
}

function splitLatinTextUnits(
  text,
  profile,
  { includeWeakBreaks = false } = {},
) {
  const units = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const isBoundary =
      LATIN_STRONG_BREAK_PUNCTUATION_PATTERN.test(char) ||
      (includeWeakBreaks && LATIN_WEAK_BREAK_PUNCTUATION_PATTERN.test(char));
    if (!isBoundary) continue;

    const boundaryEnd = consumeLatinBoundaryTail(text, index + 1);
    if (
      !shouldSplitLatinSentenceAt({
        sentenceText: text.slice(start),
        boundaryIndex: index - start,
        boundaryEnd: boundaryEnd - start,
        profile,
        includeWeakBreaks,
      })
    ) {
      index = boundaryEnd - 1;
      continue;
    }

    const unit = text.slice(start, boundaryEnd).trim();
    if (unit) {
      units.push(unit);
    }
    start = boundaryEnd;
    index = boundaryEnd - 1;
  }

  const tail = text.slice(start).trim();
  if (tail) {
    units.push(tail);
  }

  return units.length > 0 ? units : [text.trim()];
}

function splitScriptTextUnits(
  text,
  profile,
  { includeWeakBreaks = false } = {},
) {
  if (profile.family === 'latin') {
    return splitLatinTextUnits(text, profile, { includeWeakBreaks });
  }

  const pattern = includeWeakBreaks
    ? /[^。！？!?；;，,、]+[。！？!?；;，,、]?/gu
    : /[^。！？!?]+[。！？!?]?/gu;
  return text.match(pattern) || [text];
}

function resolveLineLengthConfig(limitOrOptions, sampleText = '') {
  if (typeof limitOrOptions === 'number') {
    const profile = resolveScriptSegmentationProfile('', sampleText);
    return {
      limit: Math.max(1, limitOrOptions),
      profile,
    };
  }

  const options =
    limitOrOptions && typeof limitOrOptions === 'object' ? limitOrOptions : {};
  const profile = resolveScriptSegmentationProfile(
    options.languageCode,
    options.sampleText || sampleText,
  );
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, options.limit)
    : profile.maxLineWidthUnits;

  return {
    limit,
    profile,
  };
}

function scoreBreakCandidate(candidate, text, limit, profile) {
  const leftRaw = text.slice(0, candidate.cut);
  const rightRaw = text.slice(candidate.cut);
  const left = sanitizeLineText(leftRaw);
  const right = sanitizeLineText(rightRaw);
  if (!left) return Number.NEGATIVE_INFINITY;
  if (!right) return Number.POSITIVE_INFINITY;

  let score = 0;
  const overflow = Math.max(0, candidate.width - limit);
  const underfill = Math.max(0, limit - candidate.width);

  score -= overflow * 1.6;
  score -= underfill * (profile.family === 'latin' ? 0.45 : 0.7);

  if (candidate.kind === 'punctuation') {
    if (profile.family === 'latin') {
      if (LATIN_STRONG_BREAK_PUNCTUATION_PATTERN.test(candidate.char)) {
        score += 4;
      } else if (/[;:]/u.test(candidate.char)) {
        score += 2.2;
      } else if (/,/u.test(candidate.char)) {
        score += 0.9;
      }
    } else if (/[。！？!?]/u.test(candidate.char)) {
      score += 3.5;
    } else {
      score += 1.2;
    }
  } else if (candidate.kind === 'whitespace') {
    score += profile.family === 'latin' ? 0.35 : 0.1;
  }

  if (profile.family === 'latin') {
    const leftWord = getLastLatinWord(left);
    const rightWord = getFirstLatinWord(right);

    if (profile.avoidBoundarySuffixWords.has(leftWord)) {
      score -= 4;
    }
    if (profile.avoidBoundaryPrefixWords.has(rightWord)) {
      score -= 4;
    }
    if (/['’\-]\s*$/u.test(leftRaw) || /^\s*['’\-]/u.test(rightRaw)) {
      score -= 6;
    }
    if (isLatinBoundaryAbbreviation(leftRaw, rightRaw, profile)) {
      score -= 6;
    }
  }

  return score;
}

function isLikelyDirection(text) {
  const trimmed = sanitizeLineText(text);
  if (!trimmed) return false;

  const bracketPattern = /^[（(【《〈「『\[{]+.*[）)】》〉」』\]}]+$/;
  const isBracketWrapped = bracketPattern.test(trimmed);
  const innerBracketText = isBracketWrapped
    ? trimmed
        .replace(/^[（(【《〈「『\[{]+/, '')
        .replace(/[）)】》〉」』\]}]+$/, '')
        .trim()
    : '';
  const keywordTarget = innerBracketText || trimmed;

  const startsWithKeyword =
    /^(舞台|燈光|音效|鼓聲|掌聲|旁白|全場|幕前|幕後|場景|轉場|黑場|環境音|所有人|眾人|合唱|群眾|燈暗|燈亮|黑燈|大合唱|音樂|序曲|旁白聲)/;
  if (startsWithKeyword.test(trimmed)) {
    return true;
  }

  if (!/[。！？!?]$/.test(trimmed) && trimmed.length <= 16) {
    const shortKeywords = /(舞台|燈光|音效|暗|靜場|沉默|鼓聲|掌聲|開燈|滅燈|移動|進場|退場|轉身)/;
    if (shortKeywords.test(trimmed)) {
      return true;
    }
  }

  const normalized = keywordTarget.replace(/[「」『』“”"'[\]【】（）()]/g, '');
  const directionKeywords = [
    '舞台',
    '燈光',
    '音效',
    '鼓聲',
    '掌聲',
    '黑場',
    '轉場',
    '幕',
    '暗',
    '亮',
    '靜',
    '沉默',
    '旁白',
    '群眾',
    '合唱',
    '環境音',
    '音樂',
    '奏起',
    '響起',
    '舞者',
    '演員',
    '走向',
    '退場',
    '進場',
    '登場',
    '起身',
    '坐下',
    '站起',
    '看向',
    '抱住',
    '摟住',
    '移動',
    '轉向',
    '指向',
    '望向',
    '停頓',
  ];

  const keywordHits = directionKeywords.reduce(
    (count, keyword) => (normalized.includes(keyword) ? count + 1 : count),
    0,
  );

  if (isBracketWrapped) {
    if (
      keywordHits >= 1 ||
      /^(舞台|燈光|音效|鼓聲|掌聲|旁白|全場|眾人|合唱|群眾|黑場|轉場|燈暗|燈亮|黑燈|音樂|序曲|旁白聲|幕前|幕後)$/u.test(
        keywordTarget,
      )
    ) {
      return true;
    }
    return false;
  }

  if (!/["「」『』“”]/.test(trimmed) && keywordHits >= 2) {
    return true;
  }

  const colonIndex = Math.max(trimmed.indexOf('：'), trimmed.indexOf(':'));
  if (colonIndex > -1 && colonIndex <= 6) {
    const speaker = trimmed.slice(0, colonIndex);
    if (/(舞台|燈光|音效|鼓聲|掌聲|音樂)/.test(speaker)) {
      return true;
    }
    return false;
  }

  if (
    keywordHits >= 1 &&
    !/[。！？!?]/.test(trimmed) &&
    trimmed.length <= 24 &&
    !/:|：/.test(trimmed)
  ) {
    return true;
  }

  if (
    !/[。！？!?]/.test(trimmed) &&
    /(向|朝|緩緩|慢慢|看著|走向|退後|收起|拿起|放下|起身|坐下|站起|抱住|走上|走下|握住)/.test(trimmed)
  ) {
    return true;
  }

  return false;
}

function normalizeRoleName(rawRole) {
  const role = sanitizeLineText(rawRole).replace(/[：:]$/u, '').trim();
  if (!role) return null;
  return role.slice(0, 48);
}

function extractRoleFromDialogueText(text) {
  const sanitized = sanitizeLineText(text);
  if (!sanitized) {
    return { text: '', role: null };
  }

  const colonIndex = Math.max(sanitized.indexOf('：'), sanitized.indexOf(':'));
  if (colonIndex < 1 || colonIndex > 12) {
    return { text: sanitized, role: null };
  }

  const rawRole = sanitized.slice(0, colonIndex).trim();
  const remainder = sanitized.slice(colonIndex + 1).trim();
  if (!remainder) {
    return { text: sanitized, role: null };
  }

  if (
    /[，。！？!?「」『』（）()]/u.test(rawRole) ||
    /\s{2,}/u.test(rawRole) ||
    isLikelyDirection(rawRole)
  ) {
    return { text: sanitized, role: null };
  }

  const role = normalizeRoleName(rawRole);
  if (!role) {
    return { text: sanitized, role: null };
  }

  return {
    text: remainder,
    role,
  };
}

function normalizeTranslationsMap(
  rawTranslations,
  primaryLanguageId = 'primary',
  fallbackText = '',
) {
  const translations = {};

  if (rawTranslations && typeof rawTranslations === 'object') {
    Object.entries(rawTranslations).forEach(([languageId, value]) => {
      const normalizedLanguageId = sanitizeLineText(languageId);
      if (!normalizedLanguageId) return;
      const text = sanitizeLineText(value);
      if (!text && text !== '') return;
      translations[normalizedLanguageId] = text;
    });
  }

  const primaryText = sanitizeLineText(
    translations[primaryLanguageId] ?? fallbackText,
  );
  translations[primaryLanguageId] = primaryText;
  return translations;
}

function createLineRecord(entry, primaryLanguageId = 'primary') {
  const rawType = clampLineType(entry?.type) || LINE_TYPES.DIALOGUE;
  const rawText = sanitizeLineText(entry?.text ?? '');
  const extracted =
    rawType === LINE_TYPES.DIALOGUE
      ? extractRoleFromDialogueText(rawText)
      : { text: rawText, role: null };
  const text = extracted.text;
  const role = normalizeRoleName(entry?.role ?? extracted.role);
  const translations = normalizeTranslationsMap(
    entry?.translations,
    primaryLanguageId,
    text,
  );
  translations[primaryLanguageId] = text;

  return {
    id:
      typeof entry?.id === 'string' && entry.id.trim().length > 0
        ? entry.id.trim()
        : generateId('line'),
    text,
    type: rawType,
    music: normalizeLineMusic(entry?.music),
    role: rawType === LINE_TYPES.DIALOGUE ? role : null,
    translations,
  };
}

function normalizeLineEntry(entry, keepEmpty = false, options = {}) {
  const primaryLanguageId =
    typeof options.primaryLanguageId === 'string' && options.primaryLanguageId
      ? options.primaryLanguageId
      : 'primary';
  if (entry == null) return null;

  if (typeof entry === 'string') {
    const text = sanitizeLineText(entry);
    if (!text) {
      if (keepEmpty) {
        return createLineRecord(
          {
            text: '',
            type: LINE_TYPES.DIALOGUE,
            music: false,
            role: null,
            translations: { [primaryLanguageId]: '' },
          },
          primaryLanguageId,
        );
      }
      return null;
    }
    return createLineRecord(
      {
        text,
        type: isLikelyDirection(text)
          ? LINE_TYPES.DIRECTION
          : LINE_TYPES.DIALOGUE,
        music: false,
        role: null,
        translations: { [primaryLanguageId]: text },
      },
      primaryLanguageId,
    );
  }

  if (typeof entry === 'object') {
    const rawTranslations =
      entry.translations && typeof entry.translations === 'object'
        ? entry.translations
        : null;
    const inferredText =
      (rawTranslations &&
        sanitizeLineText(
          rawTranslations[primaryLanguageId] ||
            Object.values(rawTranslations).find(
              (value) => typeof value === 'string' && sanitizeLineText(value),
            ) ||
            '',
        )) ||
      '';
    const text = sanitizeLineText(
      entry.text ?? entry.line ?? entry.caption ?? inferredText,
    );
    if (!text && !keepEmpty) return null;
    const rawType = clampLineType(
      entry.type ?? entry.kind ?? entry.category ?? '',
    );

    let type;
    if (rawType) {
      type = rawType;
    } else {
      type = isLikelyDirection(text)
        ? LINE_TYPES.DIRECTION
        : LINE_TYPES.DIALOGUE;
    }

    return createLineRecord(
      {
        id: entry.id,
        text,
        type,
        music: normalizeLineMusic(
          entry.music ?? entry.hasMusic ?? entry.isMusic,
        ),
        role: entry.role ?? entry.speaker ?? entry.character ?? null,
        translations: rawTranslations || { [primaryLanguageId]: text },
      },
      primaryLanguageId,
    );
  }

  return null;
}

function isLatinHeavyText(text) {
  return isLatinHeavyTextSample(text);
}

function normalizeScriptLines(entries, options = {}) {
  const keepEmpty = Boolean(options.keepEmpty);
  const primaryLanguageId =
    typeof options.primaryLanguageId === 'string' && options.primaryLanguageId
      ? options.primaryLanguageId
      : 'primary';
  if (!Array.isArray(entries)) {
    return [];
  }

  const normalized = [];

  entries.forEach((entry) => {
    const base = normalizeLineEntry(entry, keepEmpty, {
      primaryLanguageId,
    });
    if (!base) return;

    if (!base.text) {
      if (keepEmpty) {
        normalized.push(
          createLineRecord(
            {
              ...base,
              text: '',
              type:
                base.type === LINE_TYPES.DIRECTION
                  ? LINE_TYPES.DIRECTION
                  : LINE_TYPES.DIALOGUE,
              music: base.music === true,
            },
            primaryLanguageId,
          ),
        );
      }
      return;
    }

    const expanded = expandStageDirectionSegments(base);
    expanded.forEach((item) => {
      const text = sanitizeLineText(item.text);
      if (!text) {
        if (keepEmpty) {
          normalized.push(
            createLineRecord(
              {
                ...item,
                text: '',
                type:
                  item.type === LINE_TYPES.DIRECTION
                    ? LINE_TYPES.DIRECTION
                    : LINE_TYPES.DIALOGUE,
                music: item.music === true,
              },
              primaryLanguageId,
            ),
          );
        }
        return;
      }
      const cleanedText = text
        .replace(/^[」』》〉\]\)}]+/, '')
        .replace(/[「『《〈\[\(]+$/, '')
        .trim();
      if (!cleanedText && !keepEmpty) return;
      if (!cleanedText.replace(/[\p{P}\p{S}]/gu, '').trim()) {
        if (!keepEmpty) {
          return;
        }
      }
      normalized.push(
        createLineRecord(
          {
            ...item,
            text: cleanedText,
            type:
              item.type === LINE_TYPES.DIRECTION
                ? LINE_TYPES.DIRECTION
                : LINE_TYPES.DIALOGUE,
            music: item.music === true,
          },
          primaryLanguageId,
        ),
      );
    });
  });

  if (keepEmpty) {
    return normalized;
  }

  return normalized.filter((entry) => entry.text.length > 0);
}

function expandStageDirectionSegments(entry) {
  if (!entry || !entry.text) return [];
  if (entry.type === LINE_TYPES.DIRECTION) {
    return [entry];
  }
  const translationKeys = Object.keys(entry.translations || {}).filter(Boolean);
  if (translationKeys.length > 1) {
    return [entry];
  }

  const pattern =
    /（[^）]*）|\([^)]*\)|【[^】]*】|［[^］]*］|〈[^〉]*〉|《[^》]*》/g;
  const text = entry.text;
  const segments = [];
  let lastIndex = 0;
  let match;

  const pushSegment = (rawText, type) => {
    const sanitized = sanitizeLineText(rawText);
    if (!sanitized) return;

    if (
      type === LINE_TYPES.DIALOGUE &&
      segments.length > 0 &&
      segments[segments.length - 1].type === LINE_TYPES.DIALOGUE
    ) {
      const previous = segments[segments.length - 1];
      const needsLeadingSpace =
        /[\s\u3000，,。．\.、！!？?:：；;（(【「『《〈]$/.test(previous.text) ||
        /^[\s\u3000，,。．\.、！!？?:：；;）)】」』》〉]/.test(sanitized)
          ? ''
          : ' ';
      previous.text = `${previous.text}${needsLeadingSpace}${sanitized}`.trim();
    } else {
      segments.push({
        id: generateId('line'),
        text: sanitized,
        type,
        music: entry.music === true,
        role: type === LINE_TYPES.DIALOGUE ? entry.role || null : null,
        translations:
          entry.translations && typeof entry.translations === 'object'
            ? { ...entry.translations }
            : undefined,
      });
    }
  };

  while ((match = pattern.exec(text)) !== null) {
    pushSegment(text.slice(lastIndex, match.index), LINE_TYPES.DIALOGUE);

    const directiveRaw = match[0];
    const directiveType = isLikelyDirection(directiveRaw)
      ? LINE_TYPES.DIRECTION
      : LINE_TYPES.DIALOGUE;
    pushSegment(directiveRaw, directiveType);

    lastIndex = pattern.lastIndex;
  }

  pushSegment(text.slice(lastIndex), LINE_TYPES.DIALOGUE);

  if (segments.length === 0) {
    return [entry];
  }

  return segments;
}

function getSubtitleCharWidth(char) {
  if (!char) return 0;
  if (SUBTITLE_BREAK_WHITESPACE_PATTERN.test(char)) {
    return 0.25;
  }
  return FULL_WIDTH_SUBTITLE_CHAR_PATTERN.test(char) ? 1 : 0.5;
}

function measureSubtitleTextWidth(text) {
  if (typeof text !== 'string') {
    text = text == null ? '' : String(text);
  }

  let width = 0;
  for (const char of text) {
    width += getSubtitleCharWidth(char);
  }
  return width;
}

function enforceLineLengths(entries, limitOrOptions = MAX_LINE_WIDTH_UNITS) {
  const result = [];

  entries.forEach((entry) => {
    if (!entry || !entry.text) return;
    const { limit, profile } = resolveLineLengthConfig(limitOrOptions, entry.text);

    if (
      entry.type === LINE_TYPES.DIRECTION ||
      measureSubtitleTextWidth(entry.text) <= limit
    ) {
      result.push(entry);
      return;
    }

    const chunks = chunkDialogueText(entry.text, {
      limit,
      languageCode: profile.key,
    });
    chunks.forEach((chunk) => {
      const text = sanitizeLineText(chunk);
      if (!text) return;
      result.push(
        createLineRecord(
          {
            id: generateId('line'),
            text,
            type: LINE_TYPES.DIALOGUE,
            music: entry.music === true,
            role: entry.role || null,
            translations: { primary: text },
          },
          'primary',
        ),
      );
    });
  });

  return result;
}

function chunkDialogueText(text, limitOrOptions = MAX_LINE_WIDTH_UNITS) {
  const { limit, profile } = resolveLineLengthConfig(limitOrOptions, text);
  const sentences = splitScriptTextUnits(text, profile, {
    includeWeakBreaks: profile.family !== 'latin',
  });
  const chunks = [];

  sentences.forEach((sentence) => {
    let remaining = sanitizeLineText(sentence);
    if (!remaining) return;

    while (measureSubtitleTextWidth(remaining) > limit) {
      const cut = findBreakPosition(remaining, {
        limit,
        languageCode: profile.key,
      });
      if (cut >= remaining.length) {
        break;
      }
      const part = sanitizeLineText(remaining.slice(0, cut));
      if (part) {
        chunks.push(part);
      }
      remaining = sanitizeLineText(remaining.slice(cut));
      if (!remaining) break;
    }

    if (remaining) {
      chunks.push(remaining);
    }
  });

  return chunks;
}

function findBreakPosition(text, limitOrOptions = MAX_LINE_WIDTH_UNITS) {
  const { limit, profile } = resolveLineLengthConfig(limitOrOptions, text);

  if (measureSubtitleTextWidth(text) <= limit) {
    return text.length;
  }

  let width = 0;
  let offset = 0;
  let hardCut = text.length;
  const candidates = [];

  for (const char of text) {
    const charWidth = getSubtitleCharWidth(char);
    const nextOffset = offset + char.length;
    width += charWidth;

    if (SUBTITLE_BREAK_WHITESPACE_PATTERN.test(char)) {
      candidates.push({
        cut: nextOffset,
        width,
        kind: 'whitespace',
        char,
      });
    } else {
      const punctuationPattern =
        profile.family === 'latin'
          ? LATIN_BREAK_PUNCTUATION_PATTERN
          : SUBTITLE_BREAK_PUNCTUATION_PATTERN;
      if (punctuationPattern.test(char)) {
        candidates.push({
          cut: nextOffset,
          width,
          kind: 'punctuation',
          char,
        });
      }
    }

    if (hardCut === text.length && width > limit) {
      hardCut = Math.max(offset, char.length);
    }
    if (width > limit + profile.maxLineBreakOvershoot) {
      break;
    }

    offset = nextOffset;
  }

  const bestCandidate = candidates.reduce((best, candidate) => {
    if (candidate.cut <= 0 || candidate.cut >= text.length) {
      return best;
    }

    const score = scoreBreakCandidate(candidate, text, limit, profile);
    if (!best || score > best.score) {
      return {
        cut: candidate.cut,
        score,
      };
    }

    return best;
  }, null);

  if (bestCandidate?.cut > 0) {
    return bestCandidate.cut;
  }
  return hardCut;
}

function ensureSessionLines(session) {
  if (!session) return [];
  const primaryLanguageId = getPrimaryLanguageId(session);
  const normalized = normalizeScriptLines(session.lines || [], {
    keepEmpty: true,
    primaryLanguageId,
  });
  session.lines = normalized;
  return session.lines;
}

function createLanguageDefinition(rawLanguage = {}, index = 0) {
  const fallbackIsPrimary = index === 0;
  const providedId =
    typeof rawLanguage.id === 'string' && rawLanguage.id.trim()
      ? rawLanguage.id.trim()
      : '';
  const id = fallbackIsPrimary ? 'primary' : providedId || generateId('lang');
  const name = sanitizeLineText(
    rawLanguage.name || (fallbackIsPrimary ? '第一語言' : `語言 ${index + 1}`),
  ).slice(0, 40);
  const code = sanitizeLineText(
    rawLanguage.code || `lang-${index + 1}`,
  ).slice(0, 20);

  return {
    id,
    name: name || (fallbackIsPrimary ? '第一語言' : `語言 ${index + 1}`),
    code: code || `lang-${index + 1}`,
    isPrimary: fallbackIsPrimary,
  };
}

function getPrimaryLanguageId(session) {
  const primaryLanguage = Array.isArray(session?.languages)
    ? session.languages[0]
    : null;
  return primaryLanguage?.id || 'primary';
}

function resolveSessionLanguageId(session, rawLanguageId) {
  const languages = Array.isArray(session?.languages) ? session.languages : [];
  const normalizedLanguageId =
    typeof rawLanguageId === 'string' && rawLanguageId.trim()
      ? rawLanguageId.trim()
      : '';

  if (
    normalizedLanguageId &&
    languages.some((language) => language?.id === normalizedLanguageId)
  ) {
    return normalizedLanguageId;
  }

  return getPrimaryLanguageId(session);
}

function buildBlankTranslationsForSession(session) {
  const translations = {};
  const languages = Array.isArray(session?.languages) ? session.languages : [];
  languages.forEach((language, index) => {
    const languageId =
      typeof language?.id === 'string' && language.id.trim()
        ? language.id.trim()
        : index === 0
          ? 'primary'
          : generateId('lang');
    translations[languageId] = '';
  });
  if (!Object.prototype.hasOwnProperty.call(translations, 'primary')) {
    translations.primary = '';
  }
  return translations;
}

function getLineLanguageText(line, languageId = 'primary') {
  if (!line || typeof line !== 'object') return '';
  if (languageId === 'primary') {
    return sanitizeLineText(line.text || '');
  }
  if (
    line.translations &&
    typeof line.translations[languageId] === 'string'
  ) {
    return sanitizeLineText(line.translations[languageId]);
  }
  return '';
}

function lineHasAnyLanguageText(line) {
  if (!line || typeof line !== 'object') return false;
  if (sanitizeLineText(line.text || '')) {
    return true;
  }

  return Object.values(line.translations || {}).some(
    (value) => typeof value === 'string' && sanitizeLineText(value),
  );
}

function clearLineLanguageText(line, languageId) {
  if (!line || typeof line !== 'object') {
    return createLineRecord(
      {
        text: languageId === 'primary' ? '' : '',
        type: LINE_TYPES.DIALOGUE,
        music: false,
        role: null,
        translations: { primary: '', [languageId]: '' },
      },
      'primary',
    );
  }

  const translations = normalizeTranslationsMap(
    line.translations,
    'primary',
    line.text || '',
  );
  translations[languageId] = '';

  return createLineRecord(
    {
      ...line,
      text:
        languageId === 'primary'
          ? ''
          : sanitizeLineText(line.text || ''),
      translations,
    },
    'primary',
  );
}

function createBlankSessionLine(session, options = {}) {
  const targetLanguageId = resolveSessionLanguageId(session, options.languageId);
  const targetText = sanitizeLineText(options.text || '');
  const primaryText = targetLanguageId === 'primary' ? targetText : '';
  const translations = {
    ...buildBlankTranslationsForSession(session),
    primary: primaryText,
  };
  translations[targetLanguageId] = targetText;

  return createLineRecord(
    {
      id: options.id || generateId('line'),
      text: primaryText,
      type:
        options.type === LINE_TYPES.DIRECTION
          ? LINE_TYPES.DIRECTION
          : LINE_TYPES.DIALOGUE,
      music: normalizeLineMusic(options.music),
      role:
        options.type === LINE_TYPES.DIRECTION
          ? null
          : normalizeRoleName(options.role) || null,
      translations,
    },
    'primary',
  );
}

function updateSessionLineLanguageText(line, languageId, text) {
  const targetLanguageId = sanitizeLineText(languageId) || 'primary';
  const currentPrimaryText = sanitizeLineText(line?.text || '');
  const translations = normalizeTranslationsMap(
    line?.translations,
    'primary',
    currentPrimaryText,
  );
  const nextText = sanitizeLineText(text);
  translations[targetLanguageId] = nextText;

  return createLineRecord(
    {
      ...(line && typeof line === 'object' ? line : {}),
      text: targetLanguageId === 'primary' ? nextText : currentPrimaryText,
      translations,
    },
    'primary',
  );
}

function createBlankSessionLineLike(session, sourceLine, languageId, text = '') {
  return createBlankSessionLine(session, {
    type:
      sourceLine?.type === LINE_TYPES.DIRECTION
        ? LINE_TYPES.DIRECTION
        : LINE_TYPES.DIALOGUE,
    music: isLineMarkedMusic(sourceLine),
    role: sourceLine?.role || null,
    languageId,
    text,
  });
}

function normalizeProjectorStatus(rawStatus) {
  const source = rawStatus && typeof rawStatus === 'object' ? rawStatus : {};
  const level =
    source.level === PROJECTOR_STATUS_LEVELS.INFO ||
    source.level === PROJECTOR_STATUS_LEVELS.WARNING ||
    source.level === PROJECTOR_STATUS_LEVELS.ERROR
      ? source.level
      : PROJECTOR_STATUS_LEVELS.IDLE;

  return {
    level,
    code: sanitizeLineText(source.code || '').slice(0, 48),
    message: sanitizeLineText(source.message || '').slice(0, 240),
    updatedAt:
      typeof source.updatedAt === 'number' && Number.isFinite(source.updatedAt)
        ? source.updatedAt
        : null,
  };
}

function ensureProjectorStatus(session) {
  if (!session || typeof session !== 'object') {
    return { ...DEFAULT_PROJECTOR_STATUS };
  }

  session.projectorStatus = normalizeProjectorStatus(session.projectorStatus);
  return session.projectorStatus;
}

function setProjectorStatus(session, rawStatus = {}) {
  if (!session || typeof session !== 'object') return { ...DEFAULT_PROJECTOR_STATUS };

  const level =
    rawStatus.level === PROJECTOR_STATUS_LEVELS.INFO ||
    rawStatus.level === PROJECTOR_STATUS_LEVELS.WARNING ||
    rawStatus.level === PROJECTOR_STATUS_LEVELS.ERROR
      ? rawStatus.level
      : PROJECTOR_STATUS_LEVELS.IDLE;

  session.projectorStatus = {
    level,
    code: sanitizeLineText(rawStatus.code || '').slice(0, 48),
    message: sanitizeLineText(rawStatus.message || '').slice(0, 240),
    updatedAt:
      typeof rawStatus.occurredAt === 'number' && Number.isFinite(rawStatus.occurredAt)
        ? rawStatus.occurredAt
        : Date.now(),
  };

  return session.projectorStatus;
}

function getProjectorConnectionCount(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return 0;
  const connections = projectorConnections.get(sessionId.trim());
  return connections instanceof Set ? connections.size : 0;
}

function addProjectorConnection(sessionId, socketId) {
  if (
    typeof sessionId !== 'string' ||
    !sessionId.trim() ||
    typeof socketId !== 'string' ||
    !socketId.trim()
  ) {
    return 0;
  }

  const normalizedSessionId = sessionId.trim();
  const connections = projectorConnections.get(normalizedSessionId) || new Set();
  connections.add(socketId.trim());
  projectorConnections.set(normalizedSessionId, connections);
  return connections.size;
}

function removeProjectorConnection(sessionId, socketId) {
  if (
    typeof sessionId !== 'string' ||
    !sessionId.trim() ||
    typeof socketId !== 'string' ||
    !socketId.trim()
  ) {
    return 0;
  }

  const normalizedSessionId = sessionId.trim();
  const connections = projectorConnections.get(normalizedSessionId);
  if (!(connections instanceof Set)) {
    return 0;
  }

  connections.delete(socketId.trim());
  if (connections.size === 0) {
    projectorConnections.delete(normalizedSessionId);
    return 0;
  }

  projectorConnections.set(normalizedSessionId, connections);
  return connections.size;
}

function getProjectorPresenceLastSeenAt(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  const presence = projectorPresence.get(sessionId.trim());
  if (
    !presence ||
    typeof presence.lastSeenAt !== 'number' ||
    !Number.isFinite(presence.lastSeenAt)
  ) {
    return null;
  }

  return presence.lastSeenAt;
}

function isProjectorRecentlySeen(sessionId, now = Date.now()) {
  const lastSeenAt = getProjectorPresenceLastSeenAt(sessionId);
  if (!lastSeenAt) return false;
  return now - lastSeenAt <= PROJECTOR_PRESENCE_TTL_MS;
}

function isProjectorAvailable(sessionId, now = Date.now()) {
  return (
    getProjectorConnectionCount(sessionId) > 0 ||
    isProjectorRecentlySeen(sessionId, now)
  );
}

function markProjectorPresence(sessionId, occurredAt = Date.now()) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return { becameAvailable: false, lastSeenAt: null };
  }

  const normalizedSessionId = sessionId.trim();
  const normalizedOccurredAt =
    typeof occurredAt === 'number' && Number.isFinite(occurredAt)
      ? occurredAt
      : Date.now();
  const wasAvailable = isProjectorAvailable(normalizedSessionId, normalizedOccurredAt);

  projectorPresence.set(normalizedSessionId, {
    lastSeenAt: normalizedOccurredAt,
  });

  return {
    becameAvailable: !wasAvailable,
    lastSeenAt: normalizedOccurredAt,
  };
}

function clearProjectorPresence(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return;
  projectorPresence.delete(sessionId.trim());
}

function sweepProjectorPresence() {
  const now = Date.now();

  sessions.forEach((session, sessionId) => {
    if (getProjectorConnectionCount(sessionId) > 0) {
      return;
    }

    const lastSeenAt = getProjectorPresenceLastSeenAt(sessionId);
    if (!lastSeenAt) {
      return;
    }

    if (now - lastSeenAt <= PROJECTOR_PRESENCE_TTL_MS) {
      return;
    }

    clearProjectorPresence(sessionId);

    const projectorSession = getSession(sessionId);
    if (!projectorSession) {
      return;
    }

    setProjectorStatus(projectorSession, {
      level: PROJECTOR_STATUS_LEVELS.WARNING,
      code: 'disconnected',
      message: '投影端已斷線',
    });
    persistSession(projectorSession);
    broadcastControlState(sessionId);
  });
}

function ensureSessionLanguages(session) {
  const uniqueIds = new Set();
  const inputLanguages = Array.isArray(session?.languages) ? session.languages : [];
  const normalized = inputLanguages.map((language, index) => {
    const next = createLanguageDefinition(language, index);
    if (uniqueIds.has(next.id)) {
      next.id = index === 0 ? 'primary' : generateId('lang');
    }
    next.isPrimary = index === 0;
    uniqueIds.add(next.id);
    return next;
  });

  if (normalized.length === 0) {
    normalized.push(createLanguageDefinition({}, 0));
  }

  if (normalized[0].id !== 'primary') {
    normalized.unshift(createLanguageDefinition({}, 0));
  } else {
    normalized[0] = createLanguageDefinition(normalized[0], 0);
  }

  session.languages = normalized.map((language, index) =>
    createLanguageDefinition(language, index),
  );
  return session.languages;
}

function createCellDefinition(rawCell = {}, index = 0, primaryLanguageId = 'primary') {
  const name = sanitizeLineText(rawCell.name || `儲存格 ${index + 1}`).slice(0, 48);
  const rawLines = Array.isArray(rawCell.lines) ? rawCell.lines : [];

  return {
    id:
      typeof rawCell.id === 'string' && rawCell.id.trim()
        ? rawCell.id.trim()
        : generateId('cell'),
    name: name || `儲存格 ${index + 1}`,
    lines: normalizeScriptLines(rawLines, {
      keepEmpty: true,
      primaryLanguageId,
    }),
  };
}

function getSelectedCell(session) {
  if (!session || !Array.isArray(session.cells) || session.cells.length === 0) {
    return null;
  }

  const selected =
    typeof session.selectedCellId === 'string'
      ? session.cells.find((cell) => cell.id === session.selectedCellId)
      : null;
  return selected || session.cells[0] || null;
}

function syncSelectedCellLines(session) {
  if (!session) return [];
  const cell = getSelectedCell(session);
  if (!cell) {
    session.lines = [];
    return session.lines;
  }

  session.selectedCellId = cell.id;
  session.lines = cell.lines;
  ensureSessionLines(session);
  cell.lines = session.lines;

  if (session.currentIndex >= session.lines.length) {
    session.currentIndex = Math.max(session.lines.length - 1, 0);
  }

  return session.lines;
}

function ensureSessionHistory(session) {
  if (!session.history || typeof session.history !== 'object') {
    session.history = { past: [], future: [] };
  }
  if (!Array.isArray(session.history.past)) {
    session.history.past = [];
  }
  if (!Array.isArray(session.history.future)) {
    session.history.future = [];
  }
  return session.history;
}

function captureSessionSnapshot(session) {
  return JSON.parse(
    JSON.stringify({
      languages: session.languages,
      cells: session.cells,
      selectedCellId: session.selectedCellId,
      currentIndex: session.currentIndex,
      displayEnabled: session.displayEnabled,
      roleColorEnabled: session.roleColorEnabled,
      musicEffectEnabled: session.musicEffectEnabled,
      viewerDefaultLanguageId: session.viewerDefaultLanguageId,
      projectorDefaultLanguageId: session.projectorDefaultLanguageId,
      projectorDisplayMode: session.projectorDisplayMode,
      status: session.status,
      endedAt: session.endedAt || null,
    }),
  );
}

function pushSessionHistory(session) {
  const history = ensureSessionHistory(session);
  history.past.push(captureSessionSnapshot(session));
  if (history.past.length > SESSION_HISTORY_LIMIT) {
    history.past.splice(0, history.past.length - SESSION_HISTORY_LIMIT);
  }
  history.future = [];
}

function restoreSessionSnapshot(session, snapshot) {
  if (!session || !snapshot) return;
  session.languages = Array.isArray(snapshot.languages)
    ? snapshot.languages
    : session.languages;
  session.cells = Array.isArray(snapshot.cells) ? snapshot.cells : session.cells;
  session.selectedCellId =
    typeof snapshot.selectedCellId === 'string'
      ? snapshot.selectedCellId
      : session.selectedCellId;
  session.currentIndex = Number.isInteger(snapshot.currentIndex)
    ? snapshot.currentIndex
    : 0;
  session.displayEnabled = snapshot.displayEnabled !== false;
  session.roleColorEnabled = snapshot.roleColorEnabled !== false;
  session.musicEffectEnabled = snapshot.musicEffectEnabled !== false;
  session.viewerDefaultLanguageId =
    typeof snapshot.viewerDefaultLanguageId === 'string'
      ? snapshot.viewerDefaultLanguageId
      : session.viewerDefaultLanguageId;
  session.projectorDefaultLanguageId =
    typeof snapshot.projectorDefaultLanguageId === 'string'
      ? snapshot.projectorDefaultLanguageId
      : session.projectorDefaultLanguageId;
  session.projectorDisplayMode = normalizeProjectorDisplayMode(
    snapshot.projectorDisplayMode || session.projectorDisplayMode,
  );
  session.status = snapshot.status === 'ended' ? 'ended' : 'active';
  session.endedAt =
    Number.isFinite(snapshot.endedAt) && snapshot.endedAt > 0
      ? snapshot.endedAt
      : null;
  ensureSessionStructure(session);
}

function canUndoSession(session) {
  return ensureSessionHistory(session).past.length > 0;
}

function canRedoSession(session) {
  return ensureSessionHistory(session).future.length > 0;
}

function undoSessionHistory(session) {
  const history = ensureSessionHistory(session);
  if (history.past.length === 0) return false;
  history.future.push(captureSessionSnapshot(session));
  const snapshot = history.past.pop();
  restoreSessionSnapshot(session, snapshot);
  return true;
}

function redoSessionHistory(session) {
  const history = ensureSessionHistory(session);
  if (history.future.length === 0) return false;
  history.past.push(captureSessionSnapshot(session));
  const snapshot = history.future.pop();
  restoreSessionSnapshot(session, snapshot);
  return true;
}

function ensureSessionStructure(session) {
  if (!session || typeof session !== 'object') return null;
  const createdAt =
    Number.isFinite(session.createdAt) && session.createdAt > 0
      ? session.createdAt
      : Date.now();

  session.id =
    typeof session.id === 'string' && session.id.trim()
      ? session.id.trim()
      : generateId('session');
  session.ownerUserId =
    typeof session.ownerUserId === 'string' && session.ownerUserId.trim()
      ? session.ownerUserId.trim()
      : session.ownerUserId || '';
  session.title =
    sanitizeLineText(session.title || '') ||
    `場次 ${new Date(createdAt).toLocaleString('zh-TW', {
      hour12: false,
    })}`;
  session.viewerToken =
    typeof session.viewerToken === 'string' && session.viewerToken.trim()
      ? session.viewerToken.trim()
      : createOpaqueToken(18);
  session.viewerAlias = normalizeViewerAlias(session.viewerAlias);
  session.projectorToken =
    typeof session.projectorToken === 'string' && session.projectorToken.trim()
      ? session.projectorToken.trim()
      : createOpaqueToken(18);
  session.createdAt = createdAt;
  session.updatedAt =
    Number.isFinite(session.updatedAt) && session.updatedAt > 0
      ? session.updatedAt
      : createdAt;
  session.status = session.status === 'ended' ? 'ended' : 'active';
  session.endedAt =
    Number.isFinite(session.endedAt) && session.endedAt > 0
      ? session.endedAt
      : null;
  session.displayEnabled = session.displayEnabled !== false;
  session.roleColorEnabled = session.roleColorEnabled !== false;
  session.musicEffectEnabled = session.musicEffectEnabled !== false;
  session.projectorLayout = normalizeProjectorLayout(session.projectorLayout);
  session.projectorDisplayMode = normalizeProjectorDisplayMode(
    session.projectorDisplayMode,
  );
  session.projectorRevision = normalizeProjectorRevision(session.projectorRevision);
  ensureProjectorStatus(session);

  ensureSessionLanguages(session);
  session.viewerDefaultLanguageId = resolveSessionLanguageId(
    session,
    session.viewerDefaultLanguageId,
  );
  session.projectorDefaultLanguageId = resolveSessionLanguageId(
    session,
    session.projectorDefaultLanguageId,
  );
  const primaryLanguageId = getPrimaryLanguageId(session);

  const rawCells =
    Array.isArray(session.cells) && session.cells.length > 0
      ? session.cells
      : [
          {
            id: generateId('cell'),
            name: '儲存格 1',
            lines: Array.isArray(session.lines) ? session.lines : [],
          },
        ];

  session.cells = rawCells.map((cell, index) =>
    createCellDefinition(cell, index, primaryLanguageId),
  );

  const selectedCell = getSelectedCell(session);
  session.selectedCellId = selectedCell?.id || session.cells[0].id;
  session.currentIndex = Number.isInteger(session.currentIndex)
    ? Math.max(session.currentIndex, 0)
    : 0;
  session.transcription = ensureTranscriptionState(session);
  ensureSessionHistory(session);
  syncSelectedCellLines(session);

  return session;
}

function createSessionRecord(ownerUserId) {
  const now = Date.now();
  return ensureSessionStructure({
    id: generateId('session'),
    ownerUserId,
    viewerToken: createOpaqueToken(18),
    viewerAlias: '',
    projectorToken: createOpaqueToken(18),
    title: '',
    createdAt: now,
    updatedAt: now,
    status: 'active',
    displayEnabled: true,
    roleColorEnabled: true,
    musicEffectEnabled: true,
    viewerDefaultLanguageId: 'primary',
    projectorDefaultLanguageId: 'primary',
    projectorLayout: DEFAULT_PROJECTOR_LAYOUT,
    projectorDisplayMode: PROJECTOR_DISPLAY_MODES.SCRIPT,
    projectorRevision: 0,
    projectorStatus: { ...DEFAULT_PROJECTOR_STATUS },
    languages: [createLanguageDefinition({}, 0)],
    selectedCellId: null,
    currentIndex: 0,
    cells: [createCellDefinition({}, 0, 'primary')],
  });
}

function serializeSessionForStorage(session) {
  const normalized = ensureSessionStructure({ ...session });
  return {
    id: normalized.id,
    ownerUserId: normalized.ownerUserId,
    title: normalized.title,
    viewerToken: normalized.viewerToken,
    viewerAlias: normalized.viewerAlias,
    projectorToken: normalized.projectorToken,
    status: normalized.status,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    endedAt: normalized.endedAt,
    displayEnabled: normalized.displayEnabled,
    roleColorEnabled: normalized.roleColorEnabled,
    musicEffectEnabled: normalized.musicEffectEnabled,
    viewerDefaultLanguageId: normalized.viewerDefaultLanguageId,
    projectorDefaultLanguageId: normalized.projectorDefaultLanguageId,
    projectorLayout: normalized.projectorLayout,
    projectorDisplayMode: normalized.projectorDisplayMode,
    projectorRevision: normalized.projectorRevision,
    projectorStatus: normalized.projectorStatus,
    selectedCellId: normalized.selectedCellId,
    currentIndex: normalized.currentIndex,
    languages: normalized.languages.map((language) => ({
      id: language.id,
      name: language.name,
      code: language.code,
      isPrimary: language.isPrimary === true,
    })),
    cells: normalized.cells.map((cell) => ({
      id: cell.id,
      name: cell.name,
      lines: cell.lines,
    })),
  };
}

function buildSessionBackupPayload(session) {
  const normalized = ensureSessionStructure(session);
  return {
    kind: SESSION_BACKUP_KIND,
    version: SESSION_BACKUP_VERSION,
    exportedAt: Date.now(),
    session: serializeSessionForStorage(normalized),
  };
}

function getSessionBackupSource(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('備份檔格式錯誤');
  }

  if (
    payload.kind === SESSION_BACKUP_KIND &&
    payload.session &&
    typeof payload.session === 'object' &&
    !Array.isArray(payload.session)
  ) {
    return payload.session;
  }

  if (
    payload.session &&
    typeof payload.session === 'object' &&
    !Array.isArray(payload.session)
  ) {
    return payload.session;
  }

  if (Array.isArray(payload.cells)) {
    return payload;
  }

  throw new Error('備份檔內沒有可還原的場次資料');
}

function resolveImportedSessionOwnerUserId(rawOwnerUserId, authUser) {
  const normalizedOwnerUserId =
    typeof rawOwnerUserId === 'string' && rawOwnerUserId.trim()
      ? rawOwnerUserId.trim()
      : '';

  if (!authUser) {
    return normalizedOwnerUserId;
  }

  if (isSharedAccessUser(authUser)) {
    return normalizedOwnerUserId || authUser.id;
  }

  return authUser.id;
}

function createImportedSessionFromBackup(payload, authUser) {
  const rawSession = JSON.parse(JSON.stringify(getSessionBackupSource(payload)));
  if (
    typeof rawSession.id !== 'string' ||
    rawSession.id.trim().length === 0
  ) {
    throw new Error('備份檔缺少場次 ID，無法保留原本場次');
  }

  rawSession.ownerUserId = resolveImportedSessionOwnerUserId(
    rawSession.ownerUserId,
    authUser,
  );

  const session = ensureSessionStructure(rawSession);
  session.history = { past: [], future: [] };
  session.transcription = defaultTranscriptionState();
  syncSelectedCellLines(session);

  return session;
}

function validateImportedSessionConflict(session) {
  if (sessions.has(session.id)) {
    throw new Error('相同場次 ID 已存在，無法匯入此備份');
  }

  const viewerTokenSession = getSessionByViewerToken(session.viewerToken);
  if (viewerTokenSession) {
    throw new Error('viewer 連結已被其他場次使用，無法還原此備份');
  }

  const viewerAliasSession = getSessionByViewerAlias(session.viewerAlias);
  if (session.viewerAlias && viewerAliasSession) {
    throw new Error('檢視端入口名稱已被其他場次使用，無法還原此備份');
  }

  const projectorTokenSession = getSessionByProjectorToken(session.projectorToken);
  if (projectorTokenSession) {
    throw new Error('projector 連結已被其他場次使用，無法還原此備份');
  }
}

function hydrateApplicationStore(persistedStore) {
  users.clear();
  authSessions.clear();
  sessions.clear();

  persistedStore.users.forEach((user) => {
    if (!user || typeof user !== 'object') return;
    if (typeof user.id !== 'string' || !user.id.trim()) return;
    users.set(user.id, {
      id: user.id,
      username: normalizeDisplayName(user.username),
      usernameNormalized: normalizeUsername(
        user.usernameNormalized || user.username,
      ),
      role: normalizeUserRole(
        user.role,
        USER_ROLES.VIEWER,
      ),
      disabledAt:
        Number.isFinite(user.disabledAt) && user.disabledAt > 0
          ? user.disabledAt
          : null,
      passwordReset:
        user.passwordReset && typeof user.passwordReset === 'object'
          ? user.passwordReset
          : null,
      passwordHash:
        typeof user.passwordHash === 'string' ? user.passwordHash : '',
      createdAt:
        Number.isFinite(user.createdAt) && user.createdAt > 0
          ? user.createdAt
          : Date.now(),
    });
  });

  persistedStore.authSessions.forEach((authSession) => {
    if (!authSession || typeof authSession !== 'object') return;
    if (typeof authSession.tokenHash !== 'string' || !authSession.tokenHash) {
      return;
    }
    authSessions.set(authSession.tokenHash, authSession);
  });

  persistedStore.sessions.forEach((rawSession) => {
    const normalized = ensureSessionStructure(rawSession);
    if (!normalized || !normalized.id) return;
    sessions.set(normalized.id, normalized);
  });

  cleanupExpiredAuthSessions();
  ensureAdminBootstrapUser();
}

async function initializeApplicationStore() {
  const persistedStore = await loadStore();
  hydrateApplicationStore(persistedStore);
  await persistApplicationStore({ throwOnError: true });
}

function normalizeForComparison(text) {
  return text
    .replace(/[\s\u3000]/g, '')
    .replace(
      /[，,。．\.、！!？?\-—:：;；"“”‘’'（）()《》〈〉【】\[\]{}<>「」『』·•…~—‐﹣﹘﹣﹖﹗﹔﹕]/g,
      '',
    );
}

function hasMeaningfulOverlap(line, normalizedScript) {
  const normalizedLine = normalizeForComparison(line);
  if (!normalizedLine) return false;

  if (normalizedScript.includes(normalizedLine)) {
    return true;
  }

  if (normalizedLine.length <= 3) {
    return normalizedScript.includes(normalizedLine);
  }

  const maxSnippet = Math.min(8, normalizedLine.length);
  for (let size = maxSnippet; size >= 3; size -= 1) {
    for (let start = 0; start <= normalizedLine.length - size; start += 1) {
      const snippet = normalizedLine.slice(start, start + size);
      if (normalizedScript.includes(snippet)) {
        return true;
      }
    }
  }

  return false;
}

function fallbackSegmentScript(rawText, options = {}) {
  const profile = resolveScriptSegmentationProfile(
    options.languageCode,
    rawText,
  );
  const lines = [];
  const paragraphs = rawText
    .split(/\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  paragraphs.forEach((paragraph) => {
    const units = splitScriptTextUnits(paragraph, profile, {
      includeWeakBreaks: false,
    })
      .map((sentence) => sentence.trim())
      .filter(Boolean);

    units.forEach((unit) => {
      const text = sanitizeLineText(unit);
      if (!text) return;
      lines.push({
        text,
        type: isLikelyDirection(text)
          ? LINE_TYPES.DIRECTION
          : LINE_TYPES.DIALOGUE,
      });
    });
  });

  return lines;
}

function sanitizeModelLines(parsed, sourceText, options = {}) {
  const normalized = normalizeScriptLines(parsed);
  const cleaned = enforceLineLengths(normalized, {
    languageCode: options.languageCode,
    sampleText: sourceText,
    ...(Number.isFinite(options.lineLimit)
      ? { limit: Math.max(1, options.lineLimit) }
      : {}),
  });

  if (cleaned.length === 0) {
    const error = new Error('OpenAI 未產生有效的字幕資料');
    error.code = 'EMPTY_OUTPUT';
    throw error;
  }

  const onlyPlaceholders =
    cleaned.length > 0 &&
    cleaned.every((line) => {
      const normalizedText = line.text
        .replace(/[\s。．，,、\.!！?？:：;；\-（）()【】\[\]「」『』<>《》〈〉]/g, '')
        .trim();
      return placeholderRegex.test(normalizedText);
    });

  if (onlyPlaceholders) {
    const error = new Error('OpenAI 回傳結果缺少劇本台詞內容');
    error.code = 'PLACEHOLDER_OUTPUT';
    throw error;
  }

  const normalizedSource = normalizeForComparison(sourceText);
  const invalidLines = cleaned.filter((line) => {
    const stripped = line.text.replace(/[\p{P}\p{S}]/gu, '').trim();
    if (!stripped) {
      return false;
    }
    return !hasMeaningfulOverlap(stripped, normalizedSource);
  });

  if (invalidLines.length > 0) {
    const error = new Error('OpenAI 回傳結果含有不在劇本文字');
    error.code = 'INVALID_LLM_OUTPUT';
    error.details = invalidLines.slice(0, 5);
    throw error;
  }

  return cleaned;
}

async function parseChunk({
  client,
  chunkText,
  chunkIndex,
  totalChunks,
  languageCode = '',
  mode = 'subtitle',
  lineLimit = null,
}) {
  const profile = resolveScriptSegmentationProfile(languageCode, chunkText);
  const lineWidthUnits = Number.isFinite(lineLimit)
    ? Math.max(1, Math.trunc(lineLimit))
    : profile.maxLineWidthUnits;
  const languagePrompt =
    normalizeLanguageCode(languageCode) || profile.key || 'auto';
  const isAlignmentMode = mode === 'alignment';
  const prompt = [
    {
      role: 'system',
      content:
        isAlignmentMode
          ? 'You segment theater scripts into ordered semantic units for multilingual alignment.'
          : 'You split theater scripts into concise subtitle lines for live performances.',
    },
    {
      role: 'user',
      content: `
你正在拆解第 ${chunkIndex + 1} 段（共 ${totalChunks} 段）的劇本內容，請輸出 JSON array，元素格式為：
{ "type": "dialogue" | "direction", "text": "原文內容", "role": "角色名稱或 null" }

請保持原始順序與文字，不新增或刪除任何內容，也不要重複前面處理過的段落。
如果能明確辨識台詞說話角色，請填入 role；若無法確定就填 null。
若原文是「角色：台詞」，請把角色放進 role，text 只保留實際台詞。
${isAlignmentMode ? '你現在切的是多語對齊用的語意單位，不是最終字幕行。請盡量保留完整句意，不要為了字幕長度過度切碎。只有在角色切換、舞台指示獨立、句意完成、段落轉換或強標點斷點時才切開。' : '若文字過長，請以保留語意為優先切段。'}
劇本語言代碼（若可判斷）：${languagePrompt}
每段請控制在不超過 ${lineWidthUnits} 個全形字寬單位：
- 中文、日文、韓文與全形標點大約算 1 單位
- 英文字母、數字與半形標點大約算 0.5 單位
- 空白更少
英文、法文、德文或其他拉丁語系請優先在單字邊界切開，不要為了湊長度把單字切碎，也不要因冠詞、介系詞、縮寫或撇號前後過早斷行。
內容如下：
${chunkText}
      `.trim(),
    },
  ];

  const response = await client.responses.create({
    model: 'gpt-4o-mini',
    input: prompt,
    temperature: 0.1,
    max_output_tokens: 4000,
  });

  const output = response.output_text?.trim();
  if (!output) {
    const error = new Error('未能取得 OpenAI 回應');
    error.code = 'MISSING_OUTPUT';
    throw error;
  }

  const sanitized = output
    .replace(/^```json/i, '')
    .replace(/^```/i, '')
    .replace(/```$/i, '')
    .trim();

  const parsed = parseJsonArrayLoose(sanitized);

  if (!Array.isArray(parsed)) {
    const error = new Error('OpenAI 回傳格式不是 JSON array');
    error.code = 'INVALID_JSON';
    throw error;
  }

  return sanitizeModelLines(parsed, chunkText, {
    languageCode,
    lineLimit: lineWidthUnits,
  });
}

function getSecondaryAlignmentParseLimit(languageCode = '', sampleText = '') {
  const profile = resolveScriptSegmentationProfile(languageCode, sampleText);
  return Math.max(
    Math.round(profile.maxLineWidthUnits * SECONDARY_ALIGNMENT_PARSE_LIMIT_MULTIPLIER),
    profile.family === 'latin' ? 72 : 30,
  );
}

async function parseAlignmentScriptWithOpenAI(rawText, apiKey, options = {}) {
  const languageCode =
    typeof options.languageCode === 'string' ? options.languageCode : '';
  const client = new OpenAI({ apiKey });
  const chunks = chunkScript(rawText, MAX_CHUNK_LENGTH, { languageCode });
  const combined = [];
  const lineLimit = getSecondaryAlignmentParseLimit(languageCode, rawText);

  for (let index = 0; index < chunks.length; index += 1) {
    const chunkText = chunks[index];

    try {
      const parsedLines = await parseChunk({
        client,
        chunkText,
        chunkIndex: index,
        totalChunks: chunks.length,
        languageCode,
        mode: 'alignment',
        lineLimit,
      });
      combined.push(...parsedLines);
    } catch (error) {
      if (fallbackCodes.has(error?.code)) {
        console.warn(
          `Alignment chunk ${index + 1}/${chunks.length} failed validation, using fallback.`,
          error,
        );
        combined.push(
          ...normalizeScriptLines(
            fallbackSegmentScript(chunkText, { languageCode }),
          ),
        );
        continue;
      }

      throw error;
    }
  }

  if (combined.length === 0) {
    const error = new Error('OpenAI 未產生可對齊的語意單位');
    error.code = 'EMPTY_OUTPUT';
    throw error;
  }

  const normalized = normalizeScriptLines(combined);
  if (normalized.length === 0) {
    const error = new Error('OpenAI 未產生可對齊的語意單位');
    error.code = 'EMPTY_OUTPUT';
    throw error;
  }

  return normalized;
}

function sanitizeTranscriptionText(text) {
  return sanitizeLineText(text).replace(/\s+/g, ' ').trim();
}

function isChineseLanguageCode(language) {
  return typeof language === 'string' && /^zh(?:-|$)/iu.test(language.trim());
}

function shouldPreferTraditionalChinese(language) {
  return (
    TRANSCRIPTION_TRADITIONAL_OUTPUT_ENABLED && isChineseLanguageCode(language)
  );
}

function traditionalizeChineseText(text) {
  if (!text) return '';
  if (typeof cnToTraditionalTaiwanConverter !== 'function') return text;
  try {
    return cnToTraditionalTaiwanConverter(text);
  } catch (_error) {
    return text;
  }
}

function stripTranscriptionPromptLeak(text, promptText = '') {
  const sanitized = sanitizeTranscriptionText(text);
  if (!sanitized) return '';

  const promptCandidates = [
    promptText,
    TRANSCRIPTION_TRADITIONAL_OUTPUT_PROMPT,
  ]
    .map((candidate) => sanitizeTranscriptionText(candidate || ''))
    .filter(Boolean);

  for (const normalizedPromptText of promptCandidates) {
    if (sanitized === normalizedPromptText) {
      return '';
    }

    if (!sanitized.startsWith(normalizedPromptText)) {
      continue;
    }

    return sanitized
      .slice(normalizedPromptText.length)
      .replace(/^[，,。.!?！？；;：:\-\s]+/u, '')
      .trim();
  }

  return sanitized;
}

function normalizeTranscriptionOutputText(text, language, promptText = '') {
  const sanitized = stripTranscriptionPromptLeak(text, promptText);
  if (!sanitized) return '';
  if (!shouldPreferTraditionalChinese(language)) {
    return sanitized;
  }
  return sanitizeTranscriptionText(traditionalizeChineseText(sanitized));
}

function sanitizeTranscriptionMultilineText(text) {
  if (typeof text !== 'string') {
    text = text == null ? '' : String(text);
  }

  const normalized = stripBom(text).replace(/\r\n?/g, '\n');
  const lines = normalized
    .split('\n')
    .map((line) => sanitizeTranscriptionText(line))
    .filter(Boolean);
  return lines.join('\n').trim();
}

function normalizeTranscriptionContext(rawContext) {
  if (typeof rawContext !== 'string') return '';

  const normalized = stripBom(rawContext)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => sanitizeLineText(line))
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!normalized) return '';
  return normalized.slice(0, MAX_TRANSCRIPTION_CONTEXT_CHARS).trim();
}

function buildTranscriptionContextPrompt(transcriptionContext) {
  const normalizedContext = normalizeTranscriptionContext(transcriptionContext);
  if (!normalizedContext) return '';

  return [
    '以下是這段語音的主題、關鍵詞與專有名詞參考。',
    '僅在音訊內容或上下文明確支持時優先採用，不要為了符合提示而捏造不存在的內容。',
    normalizedContext,
  ].join('\n');
}

function buildRealtimeTranscriptionPrompt({ language, transcriptionContext }) {
  const promptParts = [];

  if (
    shouldPreferTraditionalChinese(language) &&
    TRANSCRIPTION_TRADITIONAL_OUTPUT_PROMPT
  ) {
    promptParts.push(TRANSCRIPTION_TRADITIONAL_OUTPUT_PROMPT);
  }

  const contextPrompt = buildTranscriptionContextPrompt(transcriptionContext);
  if (contextPrompt) {
    promptParts.push(contextPrompt);
  }

  return promptParts.join('\n\n').trim();
}

function buildAccurateTranscriptionPrompt({ language, transcriptionContext }) {
  const promptParts = [];

  if (TRANSCRIPTION_ACCURATE_PROMPT) {
    promptParts.push(TRANSCRIPTION_ACCURATE_PROMPT);
  }

  const contextPrompt = buildTranscriptionContextPrompt(transcriptionContext);
  if (contextPrompt) {
    promptParts.push(contextPrompt);
  }

  if (
    shouldPreferTraditionalChinese(language) &&
    TRANSCRIPTION_TRADITIONAL_OUTPUT_PROMPT
  ) {
    promptParts.push(TRANSCRIPTION_TRADITIONAL_OUTPUT_PROMPT);
  }

  return promptParts.join('\n\n').trim();
}

function getTranscriptionTextLength(text) {
  return measureSubtitleTextWidth(sanitizeTranscriptionText(text));
}

function joinTranscriptionTexts(leftText, rightText) {
  const left = sanitizeTranscriptionText(leftText);
  const right = sanitizeTranscriptionText(rightText);
  if (!left) return right;
  if (!right) return left;

  const lastChar = left.slice(-1);
  const firstChar = right.charAt(0);
  if (!lastChar || !firstChar) {
    return sanitizeTranscriptionText(`${left}${right}`);
  }

  const needsSpace =
    /[\p{L}\p{N}]/u.test(lastChar) &&
    /[\p{L}\p{N}]/u.test(firstChar) &&
    !/[\p{Script=Han}]/u.test(lastChar) &&
    !/[\p{Script=Han}]/u.test(firstChar);

  return sanitizeTranscriptionText(needsSpace ? `${left} ${right}` : `${left}${right}`);
}

function composeFragmentTexts(fragments) {
  if (!Array.isArray(fragments) || fragments.length === 0) return '';
  return fragments.reduce(
    (combined, fragment) =>
      joinTranscriptionTexts(combined, fragment?.text || ''),
    '',
  );
}

function mergeAccurateSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;

  const validSegments = segments.filter(
    (segment) =>
      segment &&
      Buffer.isBuffer(segment.pcm) &&
      segment.pcm.length > 0,
  );
  if (validSegments.length === 0) return null;

  const totalBytes = validSegments.reduce(
    (sum, segment) => sum + segment.pcm.length,
    0,
  );
  const totalDurationMs = validSegments.reduce((sum, segment) => {
    const durationMs =
      Number.isFinite(segment.durationMs) && segment.durationMs > 0
        ? segment.durationMs
        : getPcmDurationMs(segment.pcm.length);
    return sum + durationMs;
  }, 0);

  return {
    id: validSegments.map((segment) => segment.id).join('+'),
    pcm: Buffer.concat(
      validSegments.map((segment) => segment.pcm),
      totalBytes,
    ),
    durationMs: totalDurationMs,
    createdAt: Date.now(),
  };
}

function clearMergedLineOverridesForItem(stream, itemId) {
  if (!stream?.mergedLineOverrides || !itemId) return;
  Array.from(stream.mergedLineOverrides.keys()).forEach((key) => {
    if (!key.split('|').includes(itemId)) return;
    stream.mergedLineOverrides.delete(key);
  });
}

function getLastDraftItemId(stream) {
  if (!stream?.draftByItemId || stream.draftByItemId.size === 0) return null;
  let lastKey = null;
  stream.draftByItemId.forEach((_value, key) => {
    lastKey = key;
  });
  return lastKey;
}

function setDraftLine(stream, itemId, text) {
  if (!stream || !itemId) return;

  const sanitized = sanitizeTranscriptionText(text);
  if (!sanitized) {
    stream.draftByItemId.delete(itemId);
    if (stream.activeDraftItemId === itemId) {
      stream.activeDraftItemId = getLastDraftItemId(stream);
    }
    return;
  }

  stream.draftByItemId.set(itemId, sanitized);
  stream.activeDraftItemId = itemId;
}

function takeDraftLine(stream, itemId) {
  if (!stream || !itemId) return '';
  const draft = stream.draftByItemId.get(itemId) || '';
  stream.draftByItemId.delete(itemId);
  if (stream.activeDraftItemId === itemId) {
    stream.activeDraftItemId = getLastDraftItemId(stream);
  }
  return sanitizeTranscriptionText(draft);
}

function upsertCompletedFragment(
  stream,
  { itemId, text, accurateSegment = null, boundaryMeta = null } = {},
) {
  if (!stream || !itemId) return null;
  const sanitized = sanitizeTranscriptionText(text);
  if (!sanitized) return null;

  const existing = stream.fragmentByItemId.get(itemId);
  if (existing) {
    existing.text = sanitized;
    existing.corrected = false;
    existing.accurateSegment =
      accurateSegment || existing.accurateSegment || null;
    existing.boundaryMeta = boundaryMeta || existing.boundaryMeta || null;
    if (!Number.isInteger(existing.speakerId)) {
      existing.speakerId = null;
    }
    clearMergedLineOverridesForItem(stream, itemId);
    return existing;
  }

  const fragment = {
    itemId,
    text: sanitized,
    corrected: false,
    accurateSegment: accurateSegment || null,
    boundaryMeta: boundaryMeta || null,
    speakerId: null,
    completedAt: Date.now(),
  };
  stream.completedFragments.push(fragment);
  stream.fragmentByItemId.set(itemId, fragment);
  clearMergedLineOverridesForItem(stream, itemId);
  return fragment;
}

function shouldBreakBetweenFragments({
  currentText,
  previousFragment,
  nextFragment,
}) {
  const left = sanitizeTranscriptionText(currentText);
  const right = sanitizeTranscriptionText(nextFragment?.text || '');
  if (!left) return false;
  if (!right) return true;

  const mergedText = joinTranscriptionTexts(left, right);
  const leftLength = getTranscriptionTextLength(left);
  const mergedLength = getTranscriptionTextLength(mergedText);
  const englishHeavyBoundary = isLatinHeavyText(`${left} ${right}`);
  if (mergedLength >= TRANSCRIPTION_BOUNDARY_HARD_MAX_CHARS) {
    return true;
  }

  const boundaryMeta = previousFragment?.boundaryMeta || {};
  let score = 0;

  if (boundaryMeta.reason === 'semantic') score += 2;
  if (boundaryMeta.pauseMs >= TRANSCRIPTION_BOUNDARY_STRONG_PAUSE_MS) {
    score += 2;
  } else if (boundaryMeta.pauseMs >= TRANSCRIPTION_BOUNDARY_WEAK_PAUSE_MS) {
    score += 1;
  }

  if (strongSentencePunctuationRegex.test(left)) {
    score += 2;
  } else if (weakSentencePunctuationRegex.test(left)) {
    score += 0.5;
  }

  if (englishStrongSentencePunctuationRegex.test(left)) {
    score += 2;
  } else if (englishWeakSentencePunctuationRegex.test(left)) {
    score += 0.5;
  } else if (englishHeavyBoundary) {
    score -= 1.25;
  }

  if (avoidBoundarySuffixRegex.test(left)) {
    score -= 2;
  }
  if (avoidBoundaryPrefixRegex.test(right)) {
    score -= 2;
  }
  if (avoidEnglishBoundarySuffixRegex.test(left)) {
    score -= 2;
  }
  if (avoidEnglishBoundaryPrefixRegex.test(right)) {
    score -= 2;
  }
  if (englishHeavyBoundary && /^[a-z]/u.test(right)) {
    score -= 0.75;
  }

  if (boundaryMeta.forced) {
    score -= 1.5;
  }
  if (leftLength < TRANSCRIPTION_BOUNDARY_MIN_CHARS) {
    score -= 1.5;
  }
  if (mergedLength >= TRANSCRIPTION_BOUNDARY_SOFT_MAX_CHARS) {
    score += 1.5;
  }

  return score >= 2.5;
}

function buildDisplayLineFromFragments(stream, fragments) {
  const itemIds = fragments.map((fragment) => fragment.itemId);
  const key = itemIds.join('|');
  const baseText = composeFragmentTexts(fragments);
  const overrideText = sanitizeTranscriptionText(
    stream?.mergedLineOverrides?.get(key) || '',
  );
  const text =
    overrideText && shouldApplyAccurateReplacement(baseText, overrideText)
      ? overrideText
      : baseText;

  return {
    key,
    itemIds,
    itemId: itemIds[0] || null,
    text,
    speakerId: getLineSpeakerId({ fragments }),
    corrected:
      fragments.some((fragment) => fragment.corrected === true) ||
      Boolean(overrideText),
    fragments,
    accurateSegment: mergeAccurateSegments(
      fragments.map((fragment) => fragment.accurateSegment),
    ),
  };
}

function refreshGroupedTranscriptionLines(stream) {
  if (!stream) {
    return [];
  }

  const builtLines = [];
  let currentGroup = [];

  stream.completedFragments.forEach((fragment) => {
    if (!fragment?.itemId || !fragment.text) return;
    if (currentGroup.length === 0) {
      currentGroup = [fragment];
      return;
    }

    const previousFragment = currentGroup[currentGroup.length - 1];
    const currentText = composeFragmentTexts(currentGroup);
    if (
      shouldBreakBetweenFragments({
        currentText,
        previousFragment,
        nextFragment: fragment,
      })
    ) {
      builtLines.push(buildDisplayLineFromFragments(stream, currentGroup));
      currentGroup = [fragment];
      return;
    }

    currentGroup.push(fragment);
  });

  if (currentGroup.length > 0) {
    builtLines.push(buildDisplayLineFromFragments(stream, currentGroup));
  }

  const keptLines = builtLines.slice(-MAX_TRANSCRIPTION_DISPLAY_LINES);
  const keptItemIds = new Set(
    keptLines.flatMap((line) => line.itemIds),
  );
  if (stream.completedFragments.length > keptItemIds.size) {
    stream.completedFragments = stream.completedFragments.filter((fragment) =>
      keptItemIds.has(fragment.itemId),
    );
    stream.fragmentByItemId = new Map(
      stream.completedFragments.map((fragment) => [fragment.itemId, fragment]),
    );
  }

  stream.finalizedLines = keptLines;
  stream.finalizedLineByItemId = new Map();
  keptLines.forEach((line) => {
    line.itemIds.forEach((itemId) => {
      stream.finalizedLineByItemId.set(itemId, line);
    });
  });

  Array.from(stream.mergedLineOverrides.keys()).forEach((key) => {
    if (stream.finalizedLines.some((line) => line.key === key)) return;
    stream.mergedLineOverrides.delete(key);
  });

  return keptLines;
}

function buildTranscriptionDisplayEntries(stream) {
  if (!stream) {
    return [];
  }

  const historyEntries = refreshGroupedTranscriptionLines(stream)
    .map((line) => ({
      text: sanitizeTranscriptionText(line?.text || ''),
      speakerId: Number.isInteger(line?.speakerId) ? line.speakerId : null,
      isFinal: true,
    }))
    .filter((entry) => entry.text);

  const draftItemId = stream.activeDraftItemId;
  const fallbackDraftId = getLastDraftItemId(stream);
  const selectedDraftId = draftItemId || fallbackDraftId;
  const draftText = selectedDraftId
    ? sanitizeTranscriptionText(stream.draftByItemId.get(selectedDraftId) || '')
    : '';

  if (!draftText) {
    return historyEntries;
  }

  if (historyEntries.length === 0) {
    return [
      {
        text: draftText,
        speakerId: null,
        isFinal: false,
      },
    ];
  }

  const lastFragment =
    Array.isArray(stream.completedFragments) && stream.completedFragments.length > 0
      ? stream.completedFragments[stream.completedFragments.length - 1]
      : null;
  const currentLine = historyEntries[historyEntries.length - 1];
  const shouldStartNewLine = shouldBreakBetweenFragments({
    currentText: currentLine.text,
    previousFragment: lastFragment,
    nextFragment: { text: draftText },
  });

  if (shouldStartNewLine) {
    return [
      ...historyEntries,
      {
        text: draftText,
        speakerId: null,
        isFinal: false,
      },
    ];
  }

  const mergedEntries = historyEntries.slice(0, -1);
  mergedEntries.push({
    text: joinTranscriptionTexts(currentLine.text, draftText),
    speakerId: currentLine.speakerId,
    isFinal: false,
  });
  return mergedEntries;
}

function getTranscriptionDisplayParts(stream) {
  const entries = buildTranscriptionDisplayEntries(stream);
  if (entries.length === 0) {
    return { historyLines: [], draftText: '' };
  }

  const lastEntry = entries[entries.length - 1];
  if (lastEntry?.isFinal === false) {
    return {
      historyLines: entries
        .slice(0, -1)
        .map((entry) => entry.text)
        .filter(Boolean),
      draftText: lastEntry.text,
    };
  }

  return {
    historyLines: entries.map((entry) => entry.text).filter(Boolean),
    draftText: '',
  };
}

function syncTranscriptionStateFromStream(sessionId, stream, patch = {}) {
  const { historyLines, draftText } = getTranscriptionDisplayParts(stream);
  const composed = draftText ? [...historyLines, draftText] : historyLines;
  const text = sanitizeTranscriptionMultilineText(composed.join('\n'));
  const isFinal = draftText.length === 0;

  updateTranscriptionState(sessionId, {
    active: true,
    status: 'running',
    text,
    isFinal,
    error: '',
    ...patch,
  });
  broadcastTranscriptionState(sessionId);
  broadcastViewerState(sessionId);
}

async function correctTranscriptionLine({
  client,
  text,
  language,
  transcriptionContext,
}) {
  const original = normalizeTranscriptionOutputText(text, language);
  if (!original) return '';
  const normalizedContext = normalizeTranscriptionContext(transcriptionContext);

  const prompt = [
    {
      role: 'system',
      content:
        'You post-edit speech transcripts. Correct obvious recognition mistakes only. Keep original meaning and language. Return one corrected line only.',
    },
    {
      role: 'user',
      content: `
請修正下列語音辨識單行文字中的明顯錯字或同音誤字。
限制：
1. 不改變原意。
2. 不新增不存在的資訊。
3. 只輸出修正後的一行文字，不要解釋。
4. 若原句已正確，原樣輸出。
${language ? `5. 目標語言代碼：${language}` : ''}
${shouldPreferTraditionalChinese(language) ? '6. 若輸出為中文，請一律使用繁體中文（台灣用字）。' : ''}
${normalizedContext ? `7. 以下是本段內容的主題、關鍵詞與專有名詞參考；僅在能幫助修正明顯辨識錯誤時採用，不要硬套：\n${normalizedContext}` : ''}

原句：
${original}
      `.trim(),
    },
  ];

  const response = await client.responses.create({
    model: TRANSCRIPTION_CORRECTION_MODEL,
    input: prompt,
    temperature: 0,
    max_output_tokens: 200,
  });

  const output = normalizeTranscriptionOutputText(
    response.output_text || '',
    language,
  );
  if (!output) return '';
  if (output.length > Math.max(original.length * 2, 80)) {
    return original;
  }
  return output;
}

async function transcribeAccurateSegmentLine({
  client,
  segment,
  language,
  dualChannelEnabled,
  transcriptionContext,
}) {
  if (!dualChannelEnabled) return '';
  if (!isAccurateSegmentEligible(segment)) return '';

  const wavBuffer = createWavFromPcm16Mono(segment.pcm);
  if (!wavBuffer.length) return '';

  const audioFile = await toFile(
    wavBuffer,
    `segment-${segment.id || Date.now()}.wav`,
    { type: 'audio/wav' },
  );

  const promptText = buildAccurateTranscriptionPrompt({
    language,
    transcriptionContext,
  });
  const response = await client.audio.transcriptions.create({
    file: audioFile,
    model: TRANSCRIPTION_ACCURATE_MODEL,
    ...(language ? { language } : {}),
    ...(promptText ? { prompt: promptText } : {}),
  });

  const rawText =
    typeof response === 'string' ? response : response?.text || '';
  return normalizeTranscriptionOutputText(rawText, language, promptText);
}

function shouldApplyAccurateReplacement(currentText, candidateText) {
  const current = sanitizeTranscriptionText(currentText);
  const candidate = sanitizeTranscriptionText(candidateText);

  if (!candidate) return false;
  if (candidate === current) return false;
  if (punctuationOnlyRegex.test(candidate)) return false;
  if (!current) return true;

  if (candidate.length > Math.max(current.length * 3, 140)) {
    return false;
  }
  if (current.length >= 12 && candidate.length < Math.floor(current.length * 0.3)) {
    return false;
  }

  const toComparableChars = (text) =>
    Array.from(text).filter((char) => /[\p{L}\p{N}]/u.test(char));
  const currentChars = new Set(toComparableChars(current));
  const candidateChars = new Set(toComparableChars(candidate));

  if (currentChars.size >= 4 && candidateChars.size >= 4) {
    let overlapCount = 0;
    currentChars.forEach((char) => {
      if (candidateChars.has(char)) {
        overlapCount += 1;
      }
    });
    const overlapRatio =
      overlapCount / Math.max(Math.min(currentChars.size, candidateChars.size), 1);

    if (
      overlapRatio < 0.25 &&
      !candidate.includes(current) &&
      !current.includes(candidate)
    ) {
      return false;
    }
  }

  return true;
}

function queueTranscriptionCorrection({
  stream,
  isCurrent,
  client,
  sessionId,
  itemId,
  language,
  accurateSegment,
}) {
  if (!stream || !itemId) return;
  const dualChannelEnabled = stream.dualChannelEnabled === true;
  if (!TRANSCRIPTION_CORRECTION_ENABLED && !dualChannelEnabled) {
    return;
  }

  stream.correctionChain = stream.correctionChain
    .then(async () => {
      if (!isCurrent() || stream.closing) return;
      const fragment = stream.fragmentByItemId.get(itemId);
      if (!fragment || !fragment.text) return;

      let nextText = fragment.text;
      let changed = false;

      if (dualChannelEnabled) {
        try {
          const refined = await transcribeAccurateSegmentLine({
            client,
            segment: accurateSegment,
            language,
            dualChannelEnabled,
            transcriptionContext: stream.transcriptionContext,
          });
          if (!isCurrent() || stream.closing) return;
          if (shouldApplyAccurateReplacement(nextText, refined)) {
            nextText = refined;
            changed = true;
          }
        } catch (error) {
          stream.lastTransportError =
            sanitizeLineText(error?.message || '') || stream.lastTransportError;
        }
      }

      if (TRANSCRIPTION_CORRECTION_ENABLED) {
        try {
          const corrected = await correctTranscriptionLine({
            client,
            text: nextText,
            language,
            transcriptionContext: stream.transcriptionContext,
          });
          if (!isCurrent() || stream.closing) return;
          if (corrected && corrected !== nextText) {
            nextText = corrected;
            changed = true;
          }
        } catch (error) {
          stream.lastTransportError =
            sanitizeLineText(error?.message || '') || stream.lastTransportError;
        }
      }

      if (!changed || nextText === fragment.text) {
        return;
      }

      fragment.text = nextText;
      fragment.corrected = true;
      clearMergedLineOverridesForItem(stream, itemId);
      syncTranscriptionStateFromStream(sessionId, stream);
    })
    .catch(() => {});
}

function queueMergedLineCorrection({
  stream,
  isCurrent,
  client,
  sessionId,
  line,
  language,
}) {
  if (!stream || !line?.key || !Array.isArray(line.itemIds) || line.itemIds.length < 2) {
    return;
  }

  const key = line.key;
  if (stream.mergedLineCorrectionKeys.has(key)) return;

  const fragments = line.itemIds
    .map((itemId) => stream.fragmentByItemId.get(itemId) || null)
    .filter(Boolean);
  if (fragments.length < 2) return;

  const baseText = composeFragmentTexts(fragments);
  if (!baseText) return;

  const mergedSegment = mergeAccurateSegments(
    fragments.map((fragment) => fragment.accurateSegment),
  );
  const dualChannelEnabled = stream.dualChannelEnabled === true;
  const shouldUseMergedAudio =
    dualChannelEnabled &&
    fragments.some((fragment) => fragment.boundaryMeta?.forced === true) &&
    isAccurateSegmentEligible(mergedSegment);

  if (!shouldUseMergedAudio && !TRANSCRIPTION_CORRECTION_ENABLED) {
    return;
  }

  stream.mergedLineCorrectionKeys.add(key);
  stream.correctionChain = stream.correctionChain
    .then(async () => {
      if (!isCurrent() || stream.closing) return;

      let nextText = baseText;
      let changed = false;

      if (shouldUseMergedAudio) {
        try {
          const refined = await transcribeAccurateSegmentLine({
            client,
            segment: mergedSegment,
            language,
            dualChannelEnabled,
            transcriptionContext: stream.transcriptionContext,
          });
          if (!isCurrent() || stream.closing) return;
          if (shouldApplyAccurateReplacement(nextText, refined)) {
            nextText = refined;
            changed = true;
          }
        } catch (error) {
          stream.lastTransportError =
            sanitizeLineText(error?.message || '') || stream.lastTransportError;
        }
      }

      if (TRANSCRIPTION_CORRECTION_ENABLED) {
        try {
          const corrected = await correctTranscriptionLine({
            client,
            text: nextText,
            language,
            transcriptionContext: stream.transcriptionContext,
          });
          if (!isCurrent() || stream.closing) return;
          if (corrected && corrected !== nextText) {
            nextText = corrected;
            changed = true;
          }
        } catch (error) {
          stream.lastTransportError =
            sanitizeLineText(error?.message || '') || stream.lastTransportError;
        }
      }

      if (!changed || nextText === baseText) {
        return;
      }

      stream.mergedLineOverrides.set(key, nextText);
      syncTranscriptionStateFromStream(sessionId, stream);
    })
    .catch(() => {})
    .finally(() => {
      stream.mergedLineCorrectionKeys.delete(key);
    });
}

async function transcribeSpeakerWindow({
  client,
  segment,
  language,
}) {
  if (!getSpeakerRecognitionSegmentEligibility(segment).eligible) return null;

  const wavBuffer = createWavFromPcm16Mono(segment.pcm);
  if (!wavBuffer.length) return null;

  const audioFile = await toFile(
    wavBuffer,
    `speaker-window-${segment.id || Date.now()}.wav`,
    { type: 'audio/wav' },
  );

  const response = await client.audio.transcriptions.create({
    file: audioFile,
    model: 'gpt-4o-transcribe-diarize',
    response_format: 'diarized_json',
    chunking_strategy: 'auto',
    ...(language ? { language } : {}),
  });

  if (!response || !Array.isArray(response.segments)) {
    return null;
  }

  return response;
}

function getLineDurationMs(line) {
  if (!line?.accurateSegment) return 0;
  return getSegmentDurationMs(line.accurateSegment);
}

function getLineSpeakerId(line) {
  if (!line?.fragments?.length) return null;
  const counts = new Map();
  line.fragments.forEach((fragment) => {
    if (!Number.isInteger(fragment?.speakerId)) return;
    counts.set(fragment.speakerId, (counts.get(fragment.speakerId) || 0) + 1);
  });

  let selectedId = null;
  let selectedCount = 0;
  counts.forEach((count, speakerId) => {
    if (count <= selectedCount) return;
    selectedId = speakerId;
    selectedCount = count;
  });
  return selectedId;
}

function buildSpeakerRecognitionWindow(stream) {
  if (!stream?.speakerRecognitionEnabled) {
    return {
      key: '',
      lines: [],
      segment: null,
      reason: 'disabled',
    };
  }

  const groupedLines = refreshGroupedTranscriptionLines(stream);
  const diarizableLines = groupedLines.filter(
    (line) => getSpeakerRecognitionSegmentEligibility(line?.accurateSegment).eligible,
  );
  if (diarizableLines.length < 2) {
    return {
      key: '',
      lines: [],
      segment: null,
      reason: 'not-enough-eligible-lines',
      eligibleLineCount: diarizableLines.length,
      totalLineCount: groupedLines.length,
      totalDurationMs: diarizableLines.reduce(
        (sum, line) => sum + getLineDurationMs(line),
        0,
      ),
    };
  }

  const selectedLines = [];
  let totalDurationMs = 0;
  for (
    let index = diarizableLines.length - 1;
    index >= 0 && selectedLines.length < TRANSCRIPTION_SPEAKER_WINDOW_MAX_LINES;
    index -= 1
  ) {
    const candidate = diarizableLines[index];
    const durationMs = getLineDurationMs(candidate);
    if (durationMs <= 0) continue;
    if (
      selectedLines.length >= 2 &&
      totalDurationMs + durationMs > TRANSCRIPTION_SPEAKER_WINDOW_MAX_MS
    ) {
      break;
    }

    selectedLines.unshift(candidate);
    totalDurationMs += durationMs;
  }

  if (selectedLines.length < 2) {
    return {
      key: '',
      lines: selectedLines,
      segment: null,
      reason: 'window-too-small',
      eligibleLineCount: diarizableLines.length,
      totalLineCount: groupedLines.length,
      totalDurationMs,
    };
  }

  const segment = mergeAccurateSegments(
    selectedLines.map((line) => line.accurateSegment),
  );
  const key = selectedLines.map((line) => line.key).join('||');
  const eligibility = getSpeakerRecognitionSegmentEligibility(segment);
  if (!eligibility.eligible) {
    return {
      key,
      lines: selectedLines,
      segment: null,
      reason: `window-${eligibility.reason}`,
      eligibleLineCount: diarizableLines.length,
      totalLineCount: groupedLines.length,
      totalDurationMs: eligibility.durationMs,
    };
  }

  return {
    key,
    lines: selectedLines,
    segment,
    reason: '',
    eligibleLineCount: diarizableLines.length,
    totalLineCount: groupedLines.length,
    totalDurationMs: eligibility.durationMs,
  };
}

function assignSpeakerIdToLine(stream, line, speakerId) {
  if (!stream || !line || !Number.isInteger(speakerId)) return false;
  let changed = false;
  line.itemIds.forEach((itemId) => {
    const fragment = stream.fragmentByItemId.get(itemId);
    if (!fragment || fragment.speakerId === speakerId) return;
    fragment.speakerId = speakerId;
    changed = true;
  });
  return changed;
}

function mapDiarizedSpeakersToLines(window, diarizedSegments = []) {
  if (!window?.lines?.length || !Array.isArray(diarizedSegments)) {
    return [];
  }

  const lineRanges = [];
  let cursorSeconds = 0;
  window.lines.forEach((line) => {
    const durationSeconds = getLineDurationMs(line) / 1000;
    const range = {
      line,
      start: cursorSeconds,
      end: cursorSeconds + durationSeconds,
      votes: new Map(),
    };
    cursorSeconds = range.end;
    lineRanges.push(range);
  });

  diarizedSegments.forEach((segment) => {
    const speaker = typeof segment?.speaker === 'string' ? segment.speaker : '';
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    if (!speaker || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return;
    }

    lineRanges.forEach((range) => {
      const overlapSeconds =
        Math.min(end, range.end) - Math.max(start, range.start);
      if (overlapSeconds <= 0) return;
      range.votes.set(
        speaker,
        (range.votes.get(speaker) || 0) + overlapSeconds,
      );
    });
  });

  return lineRanges
    .map((range) => {
      let localSpeaker = '';
      let maxOverlap = 0;
      range.votes.forEach((overlap, speaker) => {
        if (overlap <= maxOverlap) return;
        localSpeaker = speaker;
        maxOverlap = overlap;
      });
      if (!localSpeaker) return null;
      return {
        line: range.line,
        localSpeaker,
      };
    })
    .filter(Boolean);
}

function resolveGlobalSpeakerMappings(stream, assignments) {
  const votesByLocalSpeaker = new Map();
  assignments.forEach(({ line, localSpeaker }) => {
    const existingSpeakerId = getLineSpeakerId(line);
    if (!Number.isInteger(existingSpeakerId)) return;

    if (!votesByLocalSpeaker.has(localSpeaker)) {
      votesByLocalSpeaker.set(localSpeaker, new Map());
    }
    const votes = votesByLocalSpeaker.get(localSpeaker);
    votes.set(existingSpeakerId, (votes.get(existingSpeakerId) || 0) + 1);
  });

  const usedGlobalIds = new Set();
  const localToGlobal = new Map();
  votesByLocalSpeaker.forEach((votes, localSpeaker) => {
    let selectedGlobalId = null;
    let selectedCount = 0;
    votes.forEach((count, globalId) => {
      if (usedGlobalIds.has(globalId) || count <= selectedCount) return;
      selectedGlobalId = globalId;
      selectedCount = count;
    });
    if (!Number.isInteger(selectedGlobalId)) return;
    localToGlobal.set(localSpeaker, selectedGlobalId);
    usedGlobalIds.add(selectedGlobalId);
  });

  assignments.forEach(({ localSpeaker }) => {
    if (localToGlobal.has(localSpeaker)) return;
    localToGlobal.set(localSpeaker, stream.nextSpeakerId);
    usedGlobalIds.add(stream.nextSpeakerId);
    stream.nextSpeakerId += 1;
  });

  return localToGlobal;
}

function queueSpeakerRecognition({
  stream,
  isCurrent,
  client,
  sessionId,
  language,
}) {
  if (!stream?.speakerRecognitionEnabled) return;

  const window = buildSpeakerRecognitionWindow(stream);
  if (!window?.segment || !window.key) {
    logSpeakerRecognitionDiagnostic(stream, window?.reason || 'window-unavailable', {
      eligibleLineCount: window?.eligibleLineCount,
      totalLineCount: window?.totalLineCount,
      selectedLineCount: window?.lines?.length || 0,
      totalDurationMs: window?.totalDurationMs,
    });
    return;
  }
  if (stream.pendingSpeakerWindowKeys.has(window.key)) {
    logSpeakerRecognitionDiagnostic(stream, 'window-already-pending', {
      key: window.key,
      selectedLineCount: window.lines.length,
      totalDurationMs: window.totalDurationMs,
    });
    return;
  }

  clearSpeakerRecognitionDiagnostic(stream);

  stream.pendingSpeakerWindowKeys.add(window.key);
  stream.speakerRecognitionChain = stream.speakerRecognitionChain
    .then(async () => {
      if (!isCurrent() || stream.closing) return;

      const response = await transcribeSpeakerWindow({
        client,
        segment: window.segment,
        language,
      });
      if (!isCurrent() || stream.closing) return;
      if (!response?.segments?.length) {
        logSpeakerRecognitionDiagnostic(stream, 'diarize-empty-response', {
          key: window.key,
          selectedLineCount: window.lines.length,
          totalDurationMs: window.totalDurationMs,
        });
        return;
      }

      const assignments = mapDiarizedSpeakersToLines(window, response.segments);
      if (assignments.length === 0) {
        logSpeakerRecognitionDiagnostic(stream, 'no-line-assignments', {
          key: window.key,
          selectedLineCount: window.lines.length,
          diarizedSegmentCount: response.segments.length,
          totalDurationMs: window.totalDurationMs,
        });
        return;
      }

      const localToGlobal = resolveGlobalSpeakerMappings(stream, assignments);
      let changed = false;
      assignments.forEach(({ line, localSpeaker }) => {
        const globalSpeakerId = localToGlobal.get(localSpeaker);
        if (!Number.isInteger(globalSpeakerId)) return;
        if (assignSpeakerIdToLine(stream, line, globalSpeakerId)) {
          changed = true;
        }
      });

      clearSpeakerRecognitionDiagnostic(stream);
      if (changed) {
        syncTranscriptionStateFromStream(sessionId, stream);
      }
    })
    .catch((error) => {
      stream.lastTransportError =
        sanitizeLineText(error?.message || '') || stream.lastTransportError;
      logSpeakerRecognitionDiagnostic(stream, 'request-failed', {
        message: sanitizeLineText(error?.message || ''),
      });
    })
    .finally(() => {
      stream.pendingSpeakerWindowKeys.delete(window.key);
    });
}

function normalizeLanguageCode(rawLanguage) {
  if (typeof rawLanguage !== 'string') return null;
  const trimmed = rawLanguage.trim();
  if (!trimmed) return null;
  if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/u.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function normalizeDualChannelEnabled(rawEnabled) {
  if (typeof rawEnabled === 'boolean') return rawEnabled;
  return DEFAULT_TRANSCRIPTION_DUAL_CHANNEL_ENABLED;
}

function normalizeSpeakerRecognitionEnabled(rawEnabled) {
  if (typeof rawEnabled === 'boolean') return rawEnabled;
  return DEFAULT_TRANSCRIPTION_SPEAKER_RECOGNITION_ENABLED;
}

function normalizeTranscriptionContextValue(rawContext) {
  return normalizeTranscriptionContext(rawContext);
}

function normalizeSemanticSegmentationEnabled(rawEnabled) {
  if (typeof rawEnabled === 'boolean') return rawEnabled;
  return DEFAULT_TRANSCRIPTION_SEMANTIC_SEGMENTATION_ENABLED;
}

function normalizeTranscriptionModel(rawModel) {
  if (typeof rawModel !== 'string') {
    return DEFAULT_TRANSCRIPTION_MODEL;
  }
  const trimmed = rawModel.trim();
  if (!VALID_TRANSCRIPTION_MODELS.has(trimmed)) {
    return DEFAULT_TRANSCRIPTION_MODEL;
  }
  return trimmed;
}

function ensureTranscriptionState(session) {
  if (!session.transcription || typeof session.transcription !== 'object') {
    session.transcription = defaultTranscriptionState();
    return session.transcription;
  }

  const normalized = {
    ...defaultTranscriptionState(),
    ...session.transcription,
  };
  if (
    typeof normalized.model !== 'string' ||
    !VALID_TRANSCRIPTION_MODELS.has(normalized.model)
  ) {
    normalized.model = DEFAULT_TRANSCRIPTION_MODEL;
  }
  normalized.semanticSegmentationEnabled = normalizeSemanticSegmentationEnabled(
    normalized.semanticSegmentationEnabled,
  );
  normalized.dualChannelEnabled = normalizeDualChannelEnabled(
    normalized.dualChannelEnabled,
  );
  normalized.transcriptionContext = normalizeTranscriptionContextValue(
    normalized.transcriptionContext,
  );
  normalized.speakerRecognitionEnabled = normalizeSpeakerRecognitionEnabled(
    normalized.speakerRecognitionEnabled,
  );
  session.transcription = normalized;
  return session.transcription;
}

function getPublicTranscriptionState(session) {
  const state = ensureTranscriptionState(session);
  return {
    active: Boolean(state.active),
    status: state.status || 'idle',
    text: typeof state.text === 'string' ? state.text : '',
    isFinal: state.isFinal !== false,
    language:
      typeof state.language === 'string' && state.language.trim().length > 0
        ? state.language
        : null,
    model:
      typeof state.model === 'string' && state.model.trim().length > 0
        ? state.model
        : DEFAULT_TRANSCRIPTION_MODEL,
    transcriptionContext: normalizeTranscriptionContextValue(
      state.transcriptionContext,
    ),
    semanticSegmentationEnabled: state.semanticSegmentationEnabled !== false,
    dualChannelEnabled: state.dualChannelEnabled === true,
    speakerRecognitionEnabled: state.speakerRecognitionEnabled === true,
    error:
      typeof state.error === 'string' && state.error.trim().length > 0
        ? state.error
        : '',
    updatedAt:
      typeof state.updatedAt === 'number' && Number.isFinite(state.updatedAt)
        ? state.updatedAt
        : null,
  };
}

function updateTranscriptionState(sessionId, patch = {}) {
  const session = getSession(sessionId);
  if (!session) return;

  const state = ensureTranscriptionState(session);
  Object.assign(state, patch);
  state.updatedAt = Date.now();
}

function applyTranscriptionError(sessionId, message) {
  updateTranscriptionState(sessionId, {
    active: false,
    status: 'error',
    isFinal: true,
    error: message || '語音辨識發生錯誤',
  });
  broadcastTranscriptionState(sessionId);
  broadcastViewerState(sessionId);
}

function stopTranscriptionStream(sessionId, options = {}) {
  const stream = transcriptionStreams.get(sessionId);
  if (!stream) {
    const session = getSession(sessionId);
    if (!session) return;

    const state = ensureTranscriptionState(session);
    const shouldKeepText = options.keepText === true;
    state.active = false;
    state.status = options.errorMessage ? 'error' : 'idle';
    state.error = options.errorMessage || '';
    if (!shouldKeepText) {
      state.text = '';
      state.isFinal = true;
    }
    state.updatedAt = Date.now();
    broadcastTranscriptionState(sessionId);
    broadcastViewerState(sessionId);
    return;
  }

  transcriptionStreams.delete(sessionId);
  stream.closing = true;
  stream.ready = false;
  clearRealtimeForceCommitTimer(stream);
  resetRealtimePendingAudio(stream);
  resetRealtimeCommitState(stream);
  resetAccurateTranscriptionState(stream);
  if (stream.initTimeout) {
    clearTimeout(stream.initTimeout);
    stream.initTimeout = null;
  }
  if (Array.isArray(stream.pendingAudioChunks)) {
    stream.pendingAudioChunks.length = 0;
  }
  try {
    stream.rt.close({
      code: 1000,
      reason: options.reason || 'transcription stopped',
    });
  } catch (error) {
    console.warn('Failed to close realtime transcription socket:', error);
  }

  const session = getSession(sessionId);
  if (!session) return;

  const state = ensureTranscriptionState(session);
  const shouldKeepText = options.keepText === true;
  state.active = false;
  state.status = options.errorMessage ? 'error' : 'idle';
  state.error = options.errorMessage || '';
  if (!shouldKeepText) {
    state.text = '';
    state.isFinal = true;
  }
  state.updatedAt = Date.now();

  broadcastTranscriptionState(sessionId);
  broadcastViewerState(sessionId);
}

function normalizeCloseReason(reason) {
  if (!reason) return '';

  if (Buffer.isBuffer(reason)) {
    return sanitizeLineText(reason.toString('utf8'));
  }

  if (reason instanceof Uint8Array) {
    return sanitizeLineText(Buffer.from(reason).toString('utf8'));
  }

  if (typeof reason === 'string') {
    return sanitizeLineText(reason);
  }

  return '';
}

function normalizeChunkDurationMs(rawDurationMs) {
  const numeric = Number(rawDurationMs);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(numeric, 2000);
}

function normalizeAudioLevel(rawLevel) {
  const numeric = Number(rawLevel);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(Math.max(numeric, 0), 1);
}

function trackRealtimeInputLevel(stream, level = 0, durationMs = 0) {
  if (!stream) return;
  const normalizedDurationMs = normalizeChunkDurationMs(durationMs);
  const normalizedLevel = normalizeAudioLevel(level);
  stream.lastInputLevel = normalizedLevel;
  if (normalizedDurationMs <= 0) return;

  if (normalizedLevel <= TRANSCRIPTION_SILENCE_LEVEL_THRESHOLD) {
    stream.trailingSilenceMs += normalizedDurationMs;
    return;
  }

  stream.trailingSilenceMs = 0;
}

function createBoundaryMeta(stream, reason = 'semantic') {
  return {
    reason,
    pauseMs:
      Number.isFinite(stream?.trailingSilenceMs) && stream.trailingSilenceMs > 0
        ? stream.trailingSilenceMs
        : 0,
    forced: reason !== 'semantic',
    committedAt: Date.now(),
  };
}

function getPcmDurationMs(byteLength) {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 0;
  return (
    (byteLength / (AUDIO_PCM_SAMPLE_RATE * AUDIO_PCM_BYTES_PER_SAMPLE)) * 1000
  );
}

function createWavFromPcm16Mono(pcmBuffer) {
  if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) {
    return Buffer.alloc(0);
  }

  const dataSize = pcmBuffer.length;
  const wavBuffer = Buffer.alloc(44 + dataSize);
  const byteRate = AUDIO_PCM_SAMPLE_RATE * AUDIO_PCM_BYTES_PER_SAMPLE;

  wavBuffer.write('RIFF', 0);
  wavBuffer.writeUInt32LE(36 + dataSize, 4);
  wavBuffer.write('WAVE', 8);
  wavBuffer.write('fmt ', 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(1, 22);
  wavBuffer.writeUInt32LE(AUDIO_PCM_SAMPLE_RATE, 24);
  wavBuffer.writeUInt32LE(byteRate, 28);
  wavBuffer.writeUInt16LE(AUDIO_PCM_BYTES_PER_SAMPLE, 32);
  wavBuffer.writeUInt16LE(16, 34);
  wavBuffer.write('data', 36);
  wavBuffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wavBuffer, 44);

  return wavBuffer;
}

function isIgnorableRealtimeCommitError(message) {
  if (!message || typeof message !== 'string') return false;
  return (
    /committing input audio buffer/i.test(message) &&
    (/buffer too small/i.test(message) ||
      /buffer only has 0(?:\.0+)?ms of audio/i.test(message) ||
      /0\.00ms of audio/i.test(message))
  );
}

function clearRealtimeForceCommitTimer(stream) {
  if (!stream?.forceCommitTimer) return;
  clearInterval(stream.forceCommitTimer);
  stream.forceCommitTimer = null;
}

function resetRealtimePendingAudio(stream) {
  if (!stream) return;
  stream.pendingAppendCount = 0;
  stream.firstPendingAudioAt = null;
  stream.pendingAudioMs = 0;
}

function resetRealtimeCommitState(stream) {
  if (!stream) return;
  stream.commitInFlight = false;
  stream.lastCommitAt = 0;
  stream.pendingCommitBoundaryMeta = null;
}

function resetAccurateSegmentCapture(stream) {
  if (!stream) return;
  stream.currentSegmentChunks = [];
  stream.currentSegmentBytes = 0;
  stream.currentSegmentMs = 0;
}

function resetAccurateTranscriptionState(stream) {
  if (!stream) return;
  resetAccurateSegmentCapture(stream);
  stream.commitSegmentInFlight = null;
  stream.unboundCommittedSegments = [];
  stream.segmentByItemId = new Map();
  stream.nextSegmentId = 1;
  stream.boundaryMetaByItemId = new Map();
  stream.trailingSilenceMs = 0;
  stream.lastInputLevel = 0;
}

function captureAccurateSegmentChunk(stream, audio, durationMs = 0) {
  if (!stream || stream.dualChannelEnabled !== true) return;
  if (typeof audio !== 'string' || !audio) return;

  let pcmChunk = null;
  try {
    pcmChunk = Buffer.from(audio, 'base64');
  } catch (_error) {
    return;
  }

  if (!pcmChunk || pcmChunk.length === 0) return;

  stream.currentSegmentChunks.push(pcmChunk);
  stream.currentSegmentBytes += pcmChunk.length;
  stream.currentSegmentMs += normalizeChunkDurationMs(durationMs);

  const hardMaxBytes =
    Math.ceil(
      (TRANSCRIPTION_ACCURATE_MAX_SEGMENT_MS / 1000) * AUDIO_PCM_SAMPLE_RATE,
    ) * AUDIO_PCM_BYTES_PER_SAMPLE;

  if (stream.currentSegmentBytes <= hardMaxBytes) return;

  // Keep newest chunk when an unusually long segment slips through.
  stream.currentSegmentChunks = [pcmChunk];
  stream.currentSegmentBytes = pcmChunk.length;
  stream.currentSegmentMs =
    normalizeChunkDurationMs(durationMs) || getPcmDurationMs(pcmChunk.length);
}

function takeCapturedAccurateSegment(stream) {
  if (!stream || stream.currentSegmentBytes <= 0) return null;

  const pcm = Buffer.concat(stream.currentSegmentChunks, stream.currentSegmentBytes);
  const durationMs =
    stream.currentSegmentMs > 0
      ? stream.currentSegmentMs
      : getPcmDurationMs(stream.currentSegmentBytes);

  const segment = {
    id: stream.nextSegmentId,
    pcm,
    durationMs,
    createdAt: Date.now(),
  };
  stream.nextSegmentId += 1;
  resetAccurateSegmentCapture(stream);
  return segment;
}

function getSegmentDurationMs(segment) {
  if (!segment || !Buffer.isBuffer(segment.pcm) || segment.pcm.length === 0) {
    return 0;
  }
  if (Number.isFinite(segment.durationMs) && segment.durationMs > 0) {
    return segment.durationMs;
  }
  return getPcmDurationMs(segment.pcm.length);
}

function getSegmentEligibility(
  segment,
  { minDurationMs = 0, maxDurationMs = Infinity } = {},
) {
  if (!segment || !Buffer.isBuffer(segment.pcm) || segment.pcm.length === 0) {
    return {
      eligible: false,
      reason: 'missing-audio',
      durationMs: 0,
    };
  }
  const durationMs = getSegmentDurationMs(segment);
  if (durationMs < minDurationMs) {
    return {
      eligible: false,
      reason: 'too-short',
      durationMs,
    };
  }
  if (durationMs > maxDurationMs) {
    return {
      eligible: false,
      reason: 'too-long',
      durationMs,
    };
  }
  return {
    eligible: true,
    reason: 'ok',
    durationMs,
  };
}

function isAccurateSegmentEligible(segment) {
  return getSegmentEligibility(segment, {
    minDurationMs: TRANSCRIPTION_ACCURATE_MIN_SEGMENT_MS,
    maxDurationMs: TRANSCRIPTION_ACCURATE_MAX_SEGMENT_MS,
  }).eligible;
}

function getSpeakerRecognitionSegmentEligibility(segment) {
  return getSegmentEligibility(segment, {
    minDurationMs: TRANSCRIPTION_ACCURATE_MIN_SEGMENT_MS,
    maxDurationMs: TRANSCRIPTION_SPEAKER_WINDOW_MAX_MS,
  });
}

function logSpeakerRecognitionDiagnostic(stream, reason, details = {}) {
  if (!stream || typeof reason !== 'string' || !reason) return;

  const payload = Object.entries(details).reduce((accumulator, [key, value]) => {
    if (value === undefined || value === null || value === '') {
      return accumulator;
    }
    accumulator[key] = value;
    return accumulator;
  }, {});
  const signature = JSON.stringify({ reason, ...payload });
  if (stream.lastSpeakerRecognitionDiagnostic === signature) return;

  stream.lastSpeakerRecognitionDiagnostic = signature;
  console.info(`[speaker-recognition][${stream.sessionId}] ${reason}`, payload);
}

function clearSpeakerRecognitionDiagnostic(stream) {
  if (!stream) return;
  stream.lastSpeakerRecognitionDiagnostic = '';
}

function pushUnboundCommittedSegment(stream, segment) {
  if (!stream || !segment) return;
  stream.unboundCommittedSegments.push(segment);
  if (stream.unboundCommittedSegments.length <= TRANSCRIPTION_ACCURATE_MAX_PENDING_SEGMENTS) {
    return;
  }
  stream.unboundCommittedSegments.splice(
    0,
    stream.unboundCommittedSegments.length -
      TRANSCRIPTION_ACCURATE_MAX_PENDING_SEGMENTS,
  );
}

function prepareAccurateSegmentForCommit(stream) {
  if (!stream || stream.dualChannelEnabled !== true) return;
  const segment = takeCapturedAccurateSegment(stream);
  if (!segment) return;

  if (stream.commitSegmentInFlight) {
    pushUnboundCommittedSegment(stream, stream.commitSegmentInFlight);
  }
  stream.commitSegmentInFlight = segment;
}

function settleCommittedAccurateSegment(stream, itemId) {
  if (!stream || stream.dualChannelEnabled !== true) return;
  const segment = stream.commitSegmentInFlight || takeCapturedAccurateSegment(stream);
  stream.commitSegmentInFlight = null;
  if (!segment) return;

  if (typeof itemId === 'string' && itemId) {
    stream.segmentByItemId.set(itemId, segment);
    if (
      stream.segmentByItemId.size >
      TRANSCRIPTION_ACCURATE_MAX_PENDING_SEGMENTS * 3
    ) {
      const dropKey = stream.segmentByItemId.keys().next().value;
      if (dropKey) {
        stream.segmentByItemId.delete(dropKey);
      }
    }
    return;
  }

  pushUnboundCommittedSegment(stream, segment);
}

function takeAccurateSegmentForItem(stream, itemId) {
  if (!stream || stream.dualChannelEnabled !== true) return null;

  if (typeof itemId === 'string' && itemId) {
    const bound = stream.segmentByItemId.get(itemId) || null;
    if (bound) {
      stream.segmentByItemId.delete(itemId);
      return bound;
    }
  }

  return null;
}

function dropAccurateSegmentForItem(stream, itemId) {
  if (!stream || !itemId || !stream.segmentByItemId) return;
  stream.segmentByItemId.delete(itemId);
}

function markRealtimePendingAudio(stream, durationMs = 0) {
  if (!stream) return;
  if (stream.pendingAppendCount === 0) {
    stream.firstPendingAudioAt = Date.now();
  }
  stream.pendingAppendCount += 1;
  stream.pendingAudioMs += normalizeChunkDurationMs(durationMs);
}

function getRealtimePendingAudioMs(stream, now = Date.now()) {
  if (!stream?.pendingAppendCount) return 0;
  if (stream.pendingAudioMs > 0) return stream.pendingAudioMs;
  if (!stream.firstPendingAudioAt) return 0;
  return Math.max(0, now - stream.firstPendingAudioAt);
}

function commitRealtimeAudioBuffer(
  stream,
  { allowSemanticFallback = false } = {},
) {
  if (!stream || !stream.ready || stream.closing) return false;
  if (stream.semanticSegmentationEnabled && !allowSemanticFallback) return false;
  if (!stream.pendingAppendCount) return false;
  if (stream.commitInFlight) return false;
  const now = Date.now();
  const pendingAudioMs = getRealtimePendingAudioMs(stream, now);
  if (pendingAudioMs < MIN_COMMIT_AUDIO_MS) return false;
  if (now - stream.lastCommitAt < COMMIT_COOLDOWN_MS) {
    return false;
  }

  stream.commitInFlight = true;
  stream.lastCommitAt = now;
  stream.pendingCommitBoundaryMeta = createBoundaryMeta(
    stream,
    stream.semanticSegmentationEnabled ? 'fallback' : 'manual',
  );
  stream.rt.send({
    type: 'input_audio_buffer.commit',
  });
  prepareAccurateSegmentForCommit(stream);
  return true;
}

function ensureRealtimeForceCommitTimer(stream) {
  if (!stream || stream.forceCommitTimer) return;
  const commitThresholdMs = stream.semanticSegmentationEnabled
    ? TRANSCRIPTION_SEMANTIC_FALLBACK_COMMIT_MS
    : FORCE_COMMIT_INTERVAL_MS;
  if (commitThresholdMs <= 0) return;
  stream.forceCommitTimer = setInterval(() => {
    if (!stream.ready || stream.closing) return;
    if (!stream.pendingAppendCount || !stream.firstPendingAudioAt) return;
    if (Date.now() - stream.firstPendingAudioAt < commitThresholdMs) {
      return;
    }
    try {
      // Semantic VAD remains the primary segmentation strategy; this timer only
      // forces a commit when the stream has stayed open too long without a cut.
      const committed = commitRealtimeAudioBuffer(stream, {
        allowSemanticFallback: stream.semanticSegmentationEnabled === true,
      });
      if (committed) {
        resetRealtimePendingAudio(stream);
      }
    } catch (error) {
      stream.lastTransportError =
        sanitizeLineText(error?.message || '') || stream.lastTransportError;
    }
  }, 100);
}

function sendRealtimeAudioChunk(stream, audio, durationMs = 0, level = 0) {
  stream.rt.send({
    type: 'input_audio_buffer.append',
    audio,
  });
  markRealtimePendingAudio(stream, durationMs);
  trackRealtimeInputLevel(stream, level, durationMs);
  captureAccurateSegmentChunk(stream, audio, durationMs);
}

function buildRealtimeTranscriptionSessionUpdate({
  model,
  language,
  semanticSegmentationEnabled,
  transcriptionContext,
}) {
  const transcription = {
    model,
    ...(language ? { language } : {}),
  };
  const promptText = buildRealtimeTranscriptionPrompt({
    language,
    transcriptionContext,
  });
  if (promptText) {
    transcription.prompt = promptText;
  }

  const turnDetection =
    semanticSegmentationEnabled === true
      ? {
          type: 'semantic_vad',
          eagerness: TRANSCRIPTION_SEMANTIC_VAD_EAGERNESS,
        }
      : null;

  return {
    type: 'session.update',
    session: {
      type: DEFAULT_REALTIME_SESSION_TYPE,
      audio: {
        input: {
          format: {
            type: 'audio/pcm',
            rate: AUDIO_PCM_SAMPLE_RATE,
          },
          transcription,
          turn_detection: turnDetection,
        },
      },
    },
  };
}

function flushQueuedRealtimeAudio(stream) {
  if (!stream || !Array.isArray(stream.pendingAudioChunks)) return;
  if (stream.pendingAudioChunks.length === 0) return;

  const queued = stream.pendingAudioChunks.splice(0);
  queued.forEach((chunk) => {
    if (typeof chunk === 'string') {
      if (!chunk) return;
      sendRealtimeAudioChunk(stream, chunk);
      return;
    }

    if (!chunk || typeof chunk.audio !== 'string' || !chunk.audio) return;
    sendRealtimeAudioChunk(stream, chunk.audio, chunk.durationMs, chunk.level);
  });
}

function toPublicLine(line) {
  if (!line || typeof line !== 'object') return null;
  const text = sanitizeLineText(line.text || '');
  return {
    id:
      typeof line.id === 'string' && line.id.trim()
        ? line.id.trim()
        : generateId('line'),
    text,
    type:
      line.type === LINE_TYPES.DIRECTION
        ? LINE_TYPES.DIRECTION
        : LINE_TYPES.DIALOGUE,
    music: line.music === true,
    role: normalizeRoleName(line.role) || null,
    translations: normalizeTranslationsMap(
      line.translations,
      'primary',
      text,
    ),
  };
}

function getPublicProjectorStatus(session) {
  const normalized = ensureSessionStructure(session);
  const status = ensureProjectorStatus(normalized);
  const connectionCount = getProjectorConnectionCount(normalized.id);
  const lastSeenAt = getProjectorPresenceLastSeenAt(normalized.id);
  const realtimeConnected = connectionCount > 0;
  return {
    ...status,
    connected: realtimeConnected || isProjectorRecentlySeen(normalized.id),
    realtimeConnected,
    connectionCount,
    lastSeenAt,
  };
}

function getSessionSummary(session) {
  const normalized = ensureSessionStructure(session);
  return {
    id: normalized.id,
    title: normalized.title,
    viewerToken: normalized.viewerToken,
    viewerAlias: normalized.viewerAlias,
    projectorToken: normalized.projectorToken,
    status: normalized.status,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    endedAt: normalized.endedAt,
    selectedCellId: normalized.selectedCellId,
    roleColorEnabled: normalized.roleColorEnabled,
    musicEffectEnabled: normalized.musicEffectEnabled,
    viewerDefaultLanguageId: normalized.viewerDefaultLanguageId,
    projectorDefaultLanguageId: normalized.projectorDefaultLanguageId,
    projectorDisplayMode: normalized.projectorDisplayMode,
    projectorRevision: normalized.projectorRevision,
    projectorStatus: getPublicProjectorStatus(normalized),
    cells: normalized.cells.map((cell) => ({
      id: cell.id,
      name: cell.name,
      lineCount: Array.isArray(cell.lines) ? cell.lines.length : 0,
    })),
    languages: normalized.languages,
  };
}

function getControlPayload(session) {
  const normalized = ensureSessionStructure(session);
  const lines = ensureSessionLines(normalized).map((line) => toPublicLine(line));
  return {
    sessionId: normalized.id,
    session: getSessionSummary(normalized),
    lines,
    currentIndex: normalized.currentIndex,
    displayEnabled: normalized.displayEnabled,
    roleColorEnabled: normalized.roleColorEnabled,
    musicEffectEnabled: normalized.musicEffectEnabled,
    viewerDefaultLanguageId: normalized.viewerDefaultLanguageId,
    projectorDefaultLanguageId: normalized.projectorDefaultLanguageId,
    projector: {
      token: normalized.projectorToken,
      layout: normalized.projectorLayout,
      displayMode: normalized.projectorDisplayMode,
      revision: normalized.projectorRevision,
    },
    transcription: getPublicTranscriptionState(normalized),
    history: {
      canUndo: canUndoSession(normalized),
      canRedo: canRedoSession(normalized),
    },
  };
}

function getSessionDisplayState(session) {
  const normalized = ensureSessionStructure(session);
  const lines = ensureSessionLines(normalized);
  if (normalized.currentIndex >= lines.length) {
    normalized.currentIndex = Math.max(lines.length - 1, 0);
  }

  const transcription = ensureTranscriptionState(normalized);
  const liveText = sanitizeTranscriptionMultilineText(transcription.text);
  const hasLiveText = transcription.active && liveText.length > 0;
  const activeStream = transcriptionStreams.get(normalized.id);
  const liveEntries = hasLiveText
    ? buildTranscriptionDisplayEntries(activeStream)
        .map((entry) => ({
          text: sanitizeTranscriptionText(entry?.text || ''),
          speakerId: Number.isInteger(entry?.speakerId) ? entry.speakerId : null,
          isFinal: entry?.isFinal !== false,
        }))
        .filter((entry) => entry.text)
    : [];
  const liveLines = hasLiveText
    ? (liveEntries.length > 0
        ? liveEntries.map((entry) => entry.text)
        : liveText
            .split('\n')
            .map((line) => sanitizeTranscriptionText(line))
            .filter(Boolean))
    : [];
  const activeScriptLine =
    lines.length > 0 ? lines[normalized.currentIndex] || null : null;
  const musicActive =
    normalized.musicEffectEnabled !== false &&
    isLineMarkedMusic(activeScriptLine);
  const musicText = musicActive ? '此處有音樂' : '';

  return {
    normalized,
    activeScriptLine,
    liveEntries,
    liveLines,
    liveText,
    hasLiveText,
    musicActive,
    musicText,
    transcription: getPublicTranscriptionState(normalized),
  };
}

function getViewerPayload(session) {
  const {
    normalized,
    activeScriptLine,
    liveEntries,
    liveLines,
    liveText,
    hasLiveText,
    musicActive,
    musicText,
    transcription,
  } = getSessionDisplayState(session);

  if (!normalized.displayEnabled) {
    return {
      sessionId: normalized.id,
      viewerToken: normalized.viewerToken,
      status: normalized.status,
      languages: normalized.languages,
      defaultLanguageId: normalized.viewerDefaultLanguageId,
      line: null,
      text: '',
      liveEntries: [],
      liveLines: [],
      musicActive: false,
      musicText: '',
      displayEnabled: false,
      roleColorEnabled: normalized.roleColorEnabled,
      source: 'hidden',
      transcription,
    };
  }

  if (hasLiveText) {
    return {
      sessionId: normalized.id,
      viewerToken: normalized.viewerToken,
      status: normalized.status,
      languages: normalized.languages,
      defaultLanguageId: normalized.viewerDefaultLanguageId,
      line: {
        text: liveLines[liveLines.length - 1] || liveText,
        type: LINE_TYPES.DIALOGUE,
      },
      text: liveText,
      liveEntries,
      liveLines,
      musicActive,
      musicText,
      displayEnabled: true,
      roleColorEnabled: normalized.roleColorEnabled,
      source: 'transcription',
      transcription,
    };
  }

  return {
    sessionId: normalized.id,
    viewerToken: normalized.viewerToken,
    status: normalized.status,
    languages: normalized.languages,
    defaultLanguageId: normalized.viewerDefaultLanguageId,
    line: toPublicLine(activeScriptLine),
    text:
      activeScriptLine && activeScriptLine.type === LINE_TYPES.DIRECTION
        ? ''
        : activeScriptLine?.text || '',
    liveEntries: [],
    liveLines: [],
    musicActive,
    musicText,
    displayEnabled: true,
    roleColorEnabled: normalized.roleColorEnabled,
    source: 'script',
    transcription,
  };
}

function getProjectorPayload(session) {
  const {
    normalized,
    activeScriptLine,
    liveEntries,
    liveLines,
    liveText,
    hasLiveText,
    musicActive,
    musicText,
    transcription,
  } = getSessionDisplayState(session);
  const projectorDisplayMode = normalizeProjectorDisplayMode(
    normalized.projectorDisplayMode,
  );

  if (!normalized.displayEnabled) {
    return {
      sessionId: normalized.id,
      projectorToken: normalized.projectorToken,
      status: normalized.status,
      languages: normalized.languages,
      defaultLanguageId: normalized.projectorDefaultLanguageId,
      line: null,
      text: '',
      liveEntries: [],
      liveLines: [],
      musicActive: false,
      musicText: '',
      displayEnabled: false,
      roleColorEnabled: normalized.roleColorEnabled,
      source: 'hidden',
      layout: normalized.projectorLayout,
      displayMode: projectorDisplayMode,
      revision: normalized.projectorRevision,
      transcription,
    };
  }

  if (projectorDisplayMode === PROJECTOR_DISPLAY_MODES.TRANSCRIPTION) {
    if (hasLiveText) {
      return {
        sessionId: normalized.id,
        projectorToken: normalized.projectorToken,
        status: normalized.status,
        languages: normalized.languages,
        defaultLanguageId: normalized.projectorDefaultLanguageId,
        line: {
          text: liveLines[liveLines.length - 1] || liveText,
          type: LINE_TYPES.DIALOGUE,
        },
        text: liveText,
        liveEntries,
        liveLines,
        musicActive: false,
        musicText: '',
        displayEnabled: true,
        roleColorEnabled: normalized.roleColorEnabled,
        source: 'transcription',
        layout: normalized.projectorLayout,
        displayMode: projectorDisplayMode,
        revision: normalized.projectorRevision,
        transcription,
      };
    }
  }

  return {
    sessionId: normalized.id,
    projectorToken: normalized.projectorToken,
    status: normalized.status,
    languages: normalized.languages,
    defaultLanguageId: normalized.projectorDefaultLanguageId,
    line: toPublicLine(activeScriptLine),
    text:
      activeScriptLine && activeScriptLine.type === LINE_TYPES.DIRECTION
        ? ''
        : activeScriptLine?.text || '',
    liveEntries: [],
    liveLines: [],
    musicActive,
    musicText,
    displayEnabled: true,
    roleColorEnabled: normalized.roleColorEnabled,
    source: 'script',
    layout: normalized.projectorLayout,
    displayMode: projectorDisplayMode,
    revision: normalized.projectorRevision,
    transcription,
  };
}

function getProjectorLayoutPayload(session) {
  const normalized = ensureSessionStructure(session);
  return {
    sessionId: normalized.id,
    layout: normalized.projectorLayout,
    revision: normalized.projectorRevision,
  };
}

/**
 * Returns or creates a session state bucket.
 */
function ensureSession(sessionId, ownerUserId = '') {
  if (!sessions.has(sessionId)) {
    const session = createSessionRecord(ownerUserId);
    session.id = sessionId;
    session.ownerUserId = ownerUserId || session.ownerUserId;
    clearPublicSessionTombstones(session);
    sessions.set(sessionId, session);
  }

  const session = sessions.get(sessionId);
  return ensureSessionStructure(session);
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  return session ? ensureSessionStructure(session) : null;
}

function getSessionByViewerToken(viewerToken) {
  if (typeof viewerToken !== 'string' || !viewerToken.trim()) return null;
  return (
    Array.from(sessions.values()).find(
      (session) => session.viewerToken === viewerToken.trim(),
    ) || null
  );
}

function getSessionByViewerAlias(viewerAlias) {
  const normalizedAlias = normalizeViewerAlias(viewerAlias);
  if (!normalizedAlias) return null;
  return (
    Array.from(sessions.values()).find(
      (session) => session.viewerAlias === normalizedAlias,
    ) || null
  );
}

function getSessionByProjectorToken(projectorToken) {
  if (typeof projectorToken !== 'string' || !projectorToken.trim()) return null;
  return (
    Array.from(sessions.values()).find(
      (session) => session.projectorToken === projectorToken.trim(),
    ) || null
  );
}

function resolveViewerEntrySession(viewerEntry) {
  const rawViewerEntry =
    typeof viewerEntry === 'string' ? viewerEntry.trim() : '';
  if (!rawViewerEntry) return null;

  const viewerAliasSession = getSessionByViewerAlias(rawViewerEntry);
  if (viewerAliasSession) {
    return viewerAliasSession;
  }

  return getSessionByViewerToken(rawViewerEntry);
}

function getViewerEntryRedirectPath(session) {
  const normalized = ensureSessionStructure(session);
  return `/viewer/${encodeURIComponent(normalized.viewerToken)}`;
}

function getOwnedSession(sessionId, userId) {
  const session = getSession(sessionId);
  if (!session) return null;
  if (!userId) return null;
  if (userId !== SHARED_ACCESS_USER_ID && session.ownerUserId !== userId) {
    return null;
  }
  return session;
}

function touchSession(session) {
  if (!session) return;
  session.updatedAt = Date.now();
}

function persistSession(session) {
  if (!session) return;
  touchSession(session);
  clearPublicSessionTombstones(session);
  sessions.set(session.id, session);
  persistApplicationStore();
}

function broadcastControlState(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;
  io.to(`control:${sessionId}`).emit('control:update', getControlPayload(session));
}

function broadcastTranscriptionState(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;

  io.to(`control:${sessionId}`).emit('control:transcription', {
    transcription: getPublicTranscriptionState(session),
  });
}

function broadcastViewerState(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;

  io.to(`viewer:${sessionId}`).emit('viewer:update', getViewerPayload(session));
  io.to(`projector:${sessionId}`).emit(
    'projector:update',
    getProjectorPayload(session),
  );
}

function broadcastProjectorState(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;

  io.to(`projector:${sessionId}`).emit(
    'projector:update',
    getProjectorPayload(session),
  );
}

function broadcastProjectorLayoutState(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;

  io.to(`projector:${sessionId}`).emit(
    'projector:layout',
    getProjectorLayoutPayload(session),
  );
}

async function parseScriptWithOpenAI(rawText, apiKey, options = {}) {
  const languageCode =
    typeof options.languageCode === 'string' ? options.languageCode : '';
  const client = new OpenAI({ apiKey });
  const chunks = chunkScript(rawText, MAX_CHUNK_LENGTH, { languageCode });
  const combined = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunkText = chunks[index];

    try {
      const parsedLines = await parseChunk({
        client,
        chunkText,
        chunkIndex: index,
        totalChunks: chunks.length,
        languageCode,
      });
      combined.push(...parsedLines);
    } catch (error) {
      if (fallbackCodes.has(error?.code)) {
        console.warn(
          `Chunk ${index + 1}/${chunks.length} failed validation, using fallback.`,
          error,
        );
        const fallbackLines = enforceLineLengths(
          normalizeScriptLines(
            fallbackSegmentScript(chunkText, { languageCode }),
          ),
          { languageCode },
        );
        combined.push(...fallbackLines);
        continue;
      }

      throw error;
    }
  }

  if (combined.length === 0) {
    const error = new Error('OpenAI 未產生有效的字幕資料');
    error.code = 'EMPTY_OUTPUT';
    throw error;
  }

  return enforceLineLengths(combined, { languageCode, sampleText: rawText });
}

function getSecondaryAlignmentLineWeight(line) {
  const text = sanitizeLineText(line?.text || '');
  const baseWeight = measureSubtitleTextWidth(text);
  const type =
    line?.type === LINE_TYPES.DIRECTION
      ? LINE_TYPES.DIRECTION
      : LINE_TYPES.DIALOGUE;

  if (baseWeight > 0) {
    return type === LINE_TYPES.DIRECTION
      ? Math.max(0.7, baseWeight * 0.9)
      : Math.max(0.9, baseWeight);
  }

  return type === LINE_TYPES.DIRECTION ? 0.7 : 0.9;
}

function getSecondaryAlignmentUnitWeight(text) {
  const width = measureSubtitleTextWidth(sanitizeLineText(text || ''));
  return Math.max(width, 0.75);
}

function computeSecondaryAlignmentSegmentCost(
  line,
  expectedWeight,
  assignedWeight,
  isEmpty,
) {
  const type =
    line?.type === LINE_TYPES.DIRECTION
      ? LINE_TYPES.DIRECTION
      : LINE_TYPES.DIALOGUE;
  let cost = ((assignedWeight - expectedWeight) ** 2) / Math.max(1, expectedWeight);

  if (isEmpty) {
    cost += expectedWeight * (type === LINE_TYPES.DIRECTION ? 0.55 : 1.1);
    return cost;
  }

  if (assignedWeight < expectedWeight * 0.45) {
    cost +=
      (expectedWeight * 0.45 - assignedWeight) *
      (type === LINE_TYPES.DIRECTION ? 0.25 : 0.45);
  }

  if (assignedWeight > expectedWeight * 2.6) {
    cost += (assignedWeight - expectedWeight * 2.6) * 0.12;
  }

  return cost;
}

function buildGreedySecondaryAlignmentRanges(baseLines, unitTexts) {
  const targetCount = Array.isArray(baseLines) ? baseLines.length : 0;
  if (targetCount === 0) {
    return [];
  }

  if (!Array.isArray(unitTexts) || unitTexts.length === 0) {
    return Array.from({ length: targetCount }, () => ({
      startUnit: null,
      endUnit: null,
    }));
  }

  const lineWeights = baseLines.map((line) =>
    getSecondaryAlignmentLineWeight(line),
  );
  const unitWeights = unitTexts.map((text) =>
    getSecondaryAlignmentUnitWeight(text),
  );
  const totalLineWeight = lineWeights.reduce((sum, value) => sum + value, 0) || 1;
  const unitPrefix = new Float64Array(unitWeights.length + 1);
  const linePrefix = new Float64Array(lineWeights.length + 1);

  for (let index = 0; index < unitWeights.length; index += 1) {
    unitPrefix[index + 1] = unitPrefix[index] + unitWeights[index];
  }
  for (let index = 0; index < lineWeights.length; index += 1) {
    linePrefix[index + 1] = linePrefix[index] + lineWeights[index];
  }

  const totalUnitWeight = unitPrefix[unitWeights.length] || 1;
  const boundaries = new Int32Array(targetCount + 1);
  let previousBoundary = 0;

  for (let lineIndex = 1; lineIndex < targetCount; lineIndex += 1) {
    const targetWeight =
      (totalUnitWeight * linePrefix[lineIndex]) / totalLineWeight;
    let bestBoundary = previousBoundary;
    let bestScore = Number.POSITIVE_INFINITY;

    for (
      let candidateBoundary = previousBoundary;
      candidateBoundary <= unitWeights.length;
      candidateBoundary += 1
    ) {
      let score = Math.abs(unitPrefix[candidateBoundary] - targetWeight);
      if (candidateBoundary === previousBoundary) {
        score += lineWeights[lineIndex - 1] * 0.35;
      }
      if (score < bestScore) {
        bestScore = score;
        bestBoundary = candidateBoundary;
      }
    }

    boundaries[lineIndex] = bestBoundary;
    previousBoundary = bestBoundary;
  }

  boundaries[targetCount] = unitWeights.length;

  return Array.from({ length: targetCount }, (_value, index) => {
    const startUnit = boundaries[index];
    const endUnitExclusive = boundaries[index + 1];
    if (endUnitExclusive <= startUnit) {
      return { startUnit: null, endUnit: null };
    }
    return {
      startUnit,
      endUnit: endUnitExclusive - 1,
    };
  });
}

function buildHeuristicSecondaryAlignmentRanges(baseLines, unitTexts) {
  const targetCount = Array.isArray(baseLines) ? baseLines.length : 0;
  const unitCount = Array.isArray(unitTexts) ? unitTexts.length : 0;

  if (targetCount === 0) {
    return [];
  }

  if (unitCount === 0) {
    return Array.from({ length: targetCount }, () => ({
      startUnit: null,
      endUnit: null,
    }));
  }

  if (targetCount * unitCount > SECONDARY_ALIGNMENT_DP_MAX_COMPLEXITY) {
    return buildGreedySecondaryAlignmentRanges(baseLines, unitTexts);
  }

  const lineWeights = baseLines.map((line) =>
    getSecondaryAlignmentLineWeight(line),
  );
  const unitWeights = unitTexts.map((text) =>
    getSecondaryAlignmentUnitWeight(text),
  );
  const totalLineWeight = lineWeights.reduce((sum, value) => sum + value, 0) || 1;
  const unitPrefix = new Float64Array(unitCount + 1);

  for (let index = 0; index < unitCount; index += 1) {
    unitPrefix[index + 1] = unitPrefix[index] + unitWeights[index];
  }

  const totalUnitWeight = unitPrefix[unitCount] || 1;
  let previousCosts = new Float64Array(unitCount + 1);
  previousCosts.fill(Number.POSITIVE_INFINITY);
  previousCosts[0] = 0;
  const backtrack = Array.from(
    { length: targetCount + 1 },
    () => new Int32Array(unitCount + 1),
  );

  for (let lineIndex = 1; lineIndex <= targetCount; lineIndex += 1) {
    const currentCosts = new Float64Array(unitCount + 1);
    currentCosts.fill(Number.POSITIVE_INFINITY);
    const expectedWeight =
      (totalUnitWeight * lineWeights[lineIndex - 1]) / totalLineWeight;

    for (let unitIndex = 0; unitIndex <= unitCount; unitIndex += 1) {
      let bestCost = Number.POSITIVE_INFINITY;
      let bestStart = 0;

      for (
        let previousUnitIndex = 0;
        previousUnitIndex <= unitIndex;
        previousUnitIndex += 1
      ) {
        const previousCost = previousCosts[previousUnitIndex];
        if (!Number.isFinite(previousCost)) continue;

        const assignedWeight =
          unitPrefix[unitIndex] - unitPrefix[previousUnitIndex];
        const candidateCost =
          previousCost +
          computeSecondaryAlignmentSegmentCost(
            baseLines[lineIndex - 1],
            expectedWeight,
            assignedWeight,
            unitIndex === previousUnitIndex,
          );

        if (candidateCost < bestCost) {
          bestCost = candidateCost;
          bestStart = previousUnitIndex;
        }
      }

      currentCosts[unitIndex] = bestCost;
      backtrack[lineIndex][unitIndex] = bestStart;
    }

    previousCosts = currentCosts;
  }

  const boundaries = new Int32Array(targetCount + 1);
  boundaries[targetCount] = unitCount;
  let unitIndex = unitCount;

  for (let lineIndex = targetCount; lineIndex >= 1; lineIndex -= 1) {
    const previousUnitIndex = backtrack[lineIndex][unitIndex];
    boundaries[lineIndex - 1] = previousUnitIndex;
    unitIndex = previousUnitIndex;
  }

  return Array.from({ length: targetCount }, (_value, index) => {
    const startUnit = boundaries[index];
    const endUnitExclusive = boundaries[index + 1];
    if (endUnitExclusive <= startUnit) {
      return { startUnit: null, endUnit: null };
    }
    return {
      startUnit,
      endUnit: endUnitExclusive - 1,
    };
  });
}

function joinSecondaryAlignmentUnits(unitTexts, options = {}) {
  if (!Array.isArray(unitTexts) || unitTexts.length === 0) {
    return '';
  }

  const sanitizedUnits = unitTexts.map((unit) => sanitizeLineText(unit)).filter(Boolean);
  if (sanitizedUnits.length === 0) {
    return '';
  }

  const profile = resolveScriptSegmentationProfile(
    options.languageCode,
    sanitizedUnits.join(' '),
  );
  const separator = profile.family === 'latin' ? ' ' : '';
  return sanitizeLineText(sanitizedUnits.join(separator));
}

function parseAlignmentUnitIndex(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!/^-?\d+$/u.test(trimmed)) {
    return null;
  }

  return Number.parseInt(trimmed, 10);
}

function inferAlignmentUnitIndexBase(entries) {
  if (!Array.isArray(entries)) {
    return 1;
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    const rangeIndexes = [
      ...(Array.isArray(entry.unitIndexes) ? entry.unitIndexes : []),
      ...(Array.isArray(entry.lineIndexes) ? entry.lineIndexes : []),
    ];
    for (const value of rangeIndexes) {
      if (parseAlignmentUnitIndex(value) === 0) {
        return 0;
      }
    }

    const indexValues = [
      entry.existingRow,
      entry.baseRow,
      entry.timelineRow,
      entry.rowIndex,
      entry.row,
      entry.startUnit,
      entry.endUnit,
      entry.startLine,
      entry.endLine,
      entry.start,
      entry.end,
      entry.from,
      entry.to,
      entry.unitStart,
      entry.unitEnd,
      entry.lineStart,
      entry.lineEnd,
    ];
    for (const value of indexValues) {
      if (parseAlignmentUnitIndex(value) === 0) {
        return 0;
      }
    }
  }

  return 1;
}

function normalizeAlignmentRangeEntry(entry, indexBase, rowIndex) {
  if (entry == null) {
    return { startUnit: null, endUnit: null };
  }

  if (typeof entry !== 'object' || Array.isArray(entry)) {
    const error = new Error(`第 ${rowIndex + 1} 行對齊格式錯誤`);
    error.code = 'INVALID_ALIGNMENT_RANGE';
    throw error;
  }

  const rawUnitIndexes = [
    ...(Array.isArray(entry.unitIndexes) ? entry.unitIndexes : []),
    ...(Array.isArray(entry.lineIndexes) ? entry.lineIndexes : []),
  ];
  const unitIndexes = rawUnitIndexes
    .map((value) => parseAlignmentUnitIndex(value))
    .filter(Number.isInteger);

  let startUnitRaw = null;
  let endUnitRaw = null;

  if (rawUnitIndexes.length > 0) {
    if (unitIndexes.length !== rawUnitIndexes.length) {
      const error = new Error(`第 ${rowIndex + 1} 行索引格式錯誤`);
      error.code = 'INVALID_ALIGNMENT_RANGE';
      throw error;
    }

    for (let index = 1; index < unitIndexes.length; index += 1) {
      if (unitIndexes[index] !== unitIndexes[index - 1] + 1) {
        const error = new Error(`第 ${rowIndex + 1} 行索引必須連續`);
        error.code = 'INVALID_ALIGNMENT_RANGE';
        throw error;
      }
    }

    startUnitRaw = unitIndexes[0];
    endUnitRaw = unitIndexes[unitIndexes.length - 1];
  } else {
    startUnitRaw = parseAlignmentUnitIndex(
      entry.startUnit ??
        entry.startLine ??
        entry.start ??
        entry.from ??
        entry.unitStart ??
        entry.lineStart,
    );
    endUnitRaw = parseAlignmentUnitIndex(
      entry.endUnit ??
        entry.endLine ??
        entry.end ??
        entry.to ??
        entry.unitEnd ??
        entry.lineEnd,
    );
  }

  if (startUnitRaw == null && endUnitRaw == null) {
    return { startUnit: null, endUnit: null };
  }

  if (!Number.isInteger(startUnitRaw) || !Number.isInteger(endUnitRaw)) {
    const error = new Error(`第 ${rowIndex + 1} 行缺少有效的起訖範圍`);
    error.code = 'INVALID_ALIGNMENT_RANGE';
    throw error;
  }

  return {
    startUnit: startUnitRaw - indexBase,
    endUnit: endUnitRaw - indexBase,
  };
}

function validateSecondaryAlignmentRanges(ranges, unitCount, targetCount) {
  if (!Array.isArray(ranges)) {
    const error = new Error('對齊結果格式錯誤');
    error.code = 'INVALID_ALIGNMENT_RANGE';
    throw error;
  }

  if (ranges.length !== targetCount) {
    const error = new Error('對齊筆數與主字幕不一致');
    error.code = 'INVALID_ALIGNMENT_RANGE';
    throw error;
  }

  let nextExpectedUnit = 0;

  ranges.forEach((range, index) => {
    if (!range || typeof range !== 'object') {
      const error = new Error(`第 ${index + 1} 行對齊格式錯誤`);
      error.code = 'INVALID_ALIGNMENT_RANGE';
      throw error;
    }

    const isEmpty = range.startUnit == null && range.endUnit == null;
    if (isEmpty) {
      return;
    }

    if (
      !Number.isInteger(range.startUnit) ||
      !Number.isInteger(range.endUnit)
    ) {
      const error = new Error(`第 ${index + 1} 行缺少有效的對齊範圍`);
      error.code = 'INVALID_ALIGNMENT_RANGE';
      throw error;
    }

    if (range.startUnit < 0 || range.endUnit < range.startUnit) {
      const error = new Error(`第 ${index + 1} 行對齊範圍無效`);
      error.code = 'INVALID_ALIGNMENT_RANGE';
      throw error;
    }

    if (range.endUnit >= unitCount) {
      const error = new Error(`第 ${index + 1} 行對齊範圍超出上限`);
      error.code = 'INVALID_ALIGNMENT_RANGE';
      throw error;
    }

    if (range.startUnit !== nextExpectedUnit) {
      const error = new Error(
        `第 ${index + 1} 行未依序承接項目 ${nextExpectedUnit + 1}`,
      );
      error.code = 'INVALID_ALIGNMENT_ORDER';
      throw error;
    }

    nextExpectedUnit = range.endUnit + 1;
  });

  if (nextExpectedUnit !== unitCount) {
    const error = new Error('目標語言內容沒有被完整覆蓋');
    error.code = 'INVALID_ALIGNMENT_COVERAGE';
    throw error;
  }

  return ranges;
}

function buildAlignedTextsFromRanges(unitTexts, ranges, options = {}) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return [];
  }

  return ranges.map((range) => {
    if (
      !range ||
      range.startUnit == null ||
      range.endUnit == null
    ) {
      return '';
    }

    return joinSecondaryAlignmentUnits(
      unitTexts.slice(range.startUnit, range.endUnit + 1),
      options,
    );
  });
}

function normalizeLanguageAlignmentLines(lines) {
  if (!Array.isArray(lines)) {
    return [];
  }

  return lines
    .map((line) => ({
      text: sanitizeLineText(line?.text || ''),
      type:
        line?.type === LINE_TYPES.DIRECTION
          ? LINE_TYPES.DIRECTION
          : LINE_TYPES.DIALOGUE,
      role: normalizeRoleName(line?.role ?? line?.speaker ?? line?.character),
    }))
    .filter((line) => line.text);
}

function formatAlignmentContextPrefix(line) {
  const tags = [];
  const type =
    line?.type === LINE_TYPES.DIRECTION
      ? LINE_TYPES.DIRECTION
      : LINE_TYPES.DIALOGUE;

  if (type === LINE_TYPES.DIRECTION) {
    tags.push('舞台指示');
  } else {
    tags.push('台詞');
    const role = normalizeRoleName(line?.role);
    if (role) {
      tags.push(`角色：${role}`);
    }
  }

  return tags.map((tag) => `[${tag}]`).join('');
}

function formatLanguageAlignmentPromptLine(line, index) {
  const text = sanitizeLineText(line?.text || '');
  const prefix = formatAlignmentContextPrefix(line);
  return `${index + 1}. ${prefix}${prefix ? ' ' : ''}${text}`;
}

function formatTimelineAlignmentBaseLine(line, index) {
  const text = sanitizeLineText(line?.text || '') || '[空白列]';
  const prefix = formatAlignmentContextPrefix(line);
  return `${index + 1}. ${prefix}${prefix ? ' ' : ''}${text}`;
}

function buildLanguageAlignmentBaseLines(lines, targetLanguageId) {
  if (!Array.isArray(lines)) {
    return [];
  }

  return lines.flatMap((line, index) => {
    const primaryText = sanitizeLineText(line?.text || '');
    if (!primaryText) {
      return [];
    }

    const translations = normalizeTranslationsMap(
      line?.translations,
      'primary',
      primaryText,
    );
    translations.primary = primaryText;
    if (targetLanguageId) {
      translations[targetLanguageId] = '';
    }

    return [
      {
        ...createLineRecord(
          {
            ...line,
            text: primaryText,
            translations,
          },
          'primary',
        ),
        sourceIndex: index,
      },
    ];
  });
}

function buildPreservedSupplementalAlignmentBuckets(
  lines,
  targetLanguageId,
  baseLineCount,
) {
  const bucketCount = Math.max(
    Number.isInteger(baseLineCount) ? baseLineCount : 0,
    0,
  );
  const buckets = Array.from({ length: bucketCount + 1 }, () => []);
  if (!Array.isArray(lines)) {
    return buckets;
  }

  let seenPrimaryRows = 0;
  lines.forEach((line) => {
    const primaryText = sanitizeLineText(line?.text || '');
    if (primaryText) {
      seenPrimaryRows += 1;
      return;
    }

    const translations = normalizeTranslationsMap(
      line?.translations,
      'primary',
      '',
    );
    translations.primary = '';

    const shouldPreserve = Object.entries(translations).some(
      ([languageId, value]) =>
        languageId !== 'primary' &&
        languageId !== targetLanguageId &&
        sanitizeLineText(value),
    );
    if (!shouldPreserve) {
      return;
    }

    const bucketIndex = Math.min(seenPrimaryRows, buckets.length - 1);
    buckets[bucketIndex].push(
      createLineRecord(
        {
          ...line,
          text: '',
          translations,
        },
        'primary',
      ),
    );
  });

  return buckets;
}

function normalizeTimelineAlignmentPlanEntry(entry, indexBase, rowIndex) {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
    const error = new Error(`第 ${rowIndex + 1} 行對齊格式錯誤`);
    error.code = 'INVALID_ALIGNMENT_RANGE';
    throw error;
  }

  const existingRowRaw = parseAlignmentUnitIndex(
    entry.existingRow ??
      entry.baseRow ??
      entry.timelineRow ??
      entry.rowIndex ??
      entry.row,
  );
  const targetRange = normalizeAlignmentRangeEntry(entry, indexBase, rowIndex);
  const existingRow =
    existingRowRaw == null ? null : existingRowRaw - indexBase;

  if (existingRow == null && targetRange.startUnit == null && targetRange.endUnit == null) {
    const error = new Error(`第 ${rowIndex + 1} 行至少要對應一側內容`);
    error.code = 'INVALID_ALIGNMENT_RANGE';
    throw error;
  }

  return {
    existingRow,
    startLine: targetRange.startUnit,
    endLine: targetRange.endUnit,
  };
}

function validateTimelineAlignmentPlan(plan, existingCount, targetCount) {
  if (!Array.isArray(plan)) {
    const error = new Error('對齊結果格式錯誤');
    error.code = 'INVALID_ALIGNMENT_RANGE';
    throw error;
  }

  let nextExistingRow = 0;
  let nextTargetLine = 0;

  plan.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      const error = new Error(`第 ${index + 1} 行對齊格式錯誤`);
      error.code = 'INVALID_ALIGNMENT_RANGE';
      throw error;
    }

    const hasExistingRow = entry.existingRow != null;
    const hasTargetLines = entry.startLine != null && entry.endLine != null;

    if (!hasExistingRow && !hasTargetLines) {
      const error = new Error(`第 ${index + 1} 行至少要對應一側內容`);
      error.code = 'INVALID_ALIGNMENT_RANGE';
      throw error;
    }

    if (hasExistingRow) {
      if (!Number.isInteger(entry.existingRow)) {
        const error = new Error(`第 ${index + 1} 行既有列索引無效`);
        error.code = 'INVALID_ALIGNMENT_RANGE';
        throw error;
      }
      if (entry.existingRow < 0 || entry.existingRow >= existingCount) {
        const error = new Error(`第 ${index + 1} 行既有列索引超出上限`);
        error.code = 'INVALID_ALIGNMENT_RANGE';
        throw error;
      }
      if (entry.existingRow !== nextExistingRow) {
        const error = new Error(
          `第 ${index + 1} 行未依序承接既有列 ${nextExistingRow + 1}`,
        );
        error.code = 'INVALID_ALIGNMENT_ORDER';
        throw error;
      }
      nextExistingRow += 1;
    }

    if (hasTargetLines) {
      if (
        !Number.isInteger(entry.startLine) ||
        !Number.isInteger(entry.endLine)
      ) {
        const error = new Error(`第 ${index + 1} 行目標語言範圍無效`);
        error.code = 'INVALID_ALIGNMENT_RANGE';
        throw error;
      }
      if (entry.startLine < 0 || entry.endLine < entry.startLine) {
        const error = new Error(`第 ${index + 1} 行目標語言範圍無效`);
        error.code = 'INVALID_ALIGNMENT_RANGE';
        throw error;
      }
      if (entry.endLine >= targetCount) {
        const error = new Error(`第 ${index + 1} 行目標語言範圍超出上限`);
        error.code = 'INVALID_ALIGNMENT_RANGE';
        throw error;
      }
      if (entry.startLine !== nextTargetLine) {
        const error = new Error(
          `第 ${index + 1} 行未依序承接目標語言第 ${nextTargetLine + 1} 行`,
        );
        error.code = 'INVALID_ALIGNMENT_ORDER';
        throw error;
      }
      nextTargetLine = entry.endLine + 1;
    }
  });

  if (nextExistingRow !== existingCount) {
    const error = new Error('既有字幕列沒有被完整覆蓋');
    error.code = 'INVALID_ALIGNMENT_COVERAGE';
    throw error;
  }
  if (nextTargetLine !== targetCount) {
    const error = new Error('目標語言內容沒有被完整覆蓋');
    error.code = 'INVALID_ALIGNMENT_COVERAGE';
    throw error;
  }

  return plan;
}

function detectParsedLineRangeType(parsedLines, startLine, endLine) {
  if (
    !Array.isArray(parsedLines) ||
    startLine == null ||
    endLine == null ||
    startLine < 0 ||
    endLine < startLine
  ) {
    return LINE_TYPES.DIALOGUE;
  }

  const slice = parsedLines.slice(startLine, endLine + 1);
  if (
    slice.length > 0 &&
    slice.every((line) => line?.type === LINE_TYPES.DIRECTION)
  ) {
    return LINE_TYPES.DIRECTION;
  }

  return LINE_TYPES.DIALOGUE;
}

function detectParsedLineRangeRole(parsedLines, startLine, endLine) {
  if (
    !Array.isArray(parsedLines) ||
    startLine == null ||
    endLine == null ||
    startLine < 0 ||
    endLine < startLine
  ) {
    return null;
  }

  for (const line of parsedLines.slice(startLine, endLine + 1)) {
    const role = normalizeRoleName(line?.role);
    if (role) {
      return role;
    }
  }

  return null;
}

function buildTargetOnlyAlignmentPlan(parsedLines) {
  const normalizedParsedLines = normalizeLanguageAlignmentLines(parsedLines);
  return normalizedParsedLines.map((_line, index) => ({
    existingRow: null,
    startLine: index,
    endLine: index,
  }));
}

function buildAlignedLanguageTimelineFromPlan({
  session,
  baseLines,
  parsedLines,
  languageId,
  languageCode,
  plan,
  supplementalBuckets = [],
}) {
  const normalizedParsedLines = normalizeLanguageAlignmentLines(parsedLines);
  const mergedLines = [];
  const appendSupplementalBucket = (bucketIndex) => {
    const bucket = Array.isArray(supplementalBuckets[bucketIndex])
      ? supplementalBuckets[bucketIndex]
      : [];
    bucket.forEach((line) => {
      mergedLines.push(createLineRecord(line, 'primary'));
    });
  };

  appendSupplementalBucket(0);
  let emittedBaseRows = 0;

  plan.forEach((entry) => {
    const targetText =
      entry.startLine == null || entry.endLine == null
        ? ''
        : joinSecondaryAlignmentUnits(
            normalizedParsedLines
              .slice(entry.startLine, entry.endLine + 1)
              .map((line) => line.text),
            { languageCode },
          );

    if (entry.existingRow != null) {
      const existingLine = baseLines[entry.existingRow];
      const sourceLine =
        existingLine?.sourceLine && typeof existingLine.sourceLine === 'object'
          ? existingLine.sourceLine
          : existingLine;
      const translations = normalizeTranslationsMap(
        sourceLine?.translations,
        'primary',
        sourceLine?.text || existingLine?.text || '',
      );
      translations[languageId] = targetText;

      mergedLines.push(
        createLineRecord(
          {
            ...sourceLine,
            text: sanitizeLineText(sourceLine?.text || existingLine?.text || ''),
            translations,
          },
          'primary',
        ),
      );
      emittedBaseRows += 1;
      appendSupplementalBucket(emittedBaseRows);
      return;
    }

    const type = detectParsedLineRangeType(
      normalizedParsedLines,
      entry.startLine,
      entry.endLine,
    );
    const role =
      type === LINE_TYPES.DIALOGUE
        ? detectParsedLineRangeRole(
            normalizedParsedLines,
            entry.startLine,
            entry.endLine,
          )
        : null;

    mergedLines.push(
      createBlankSessionLine(session, {
        type,
        music: false,
        role,
        languageId,
        text: targetText,
      }),
    );
  });

  return mergedLines;
}

async function alignParsedLanguageLinesWithOpenAI({
  apiKey,
  baseLines,
  parsedLines,
  targetLanguageId,
  languageName,
  languageCode,
}) {
  const normalizedParsedLines = normalizeLanguageAlignmentLines(parsedLines);
  const existingCount = Array.isArray(baseLines) ? baseLines.length : 0;
  const targetCount = normalizedParsedLines.length;

  if (existingCount === 0) {
    return buildTargetOnlyAlignmentPlan(normalizedParsedLines);
  }

  if (targetCount === 0) {
    return Array.from({ length: existingCount }, (_value, index) => ({
      existingRow: index,
      startLine: null,
      endLine: null,
    }));
  }

  const client = new OpenAI({ apiKey });
  const prompt = [
    {
      role: 'system',
      content:
        'You semantically align a target-language script sequence to an edited primary-language subtitle timeline by producing a merged ordered plan.',
    },
    {
      role: 'user',
      content: `
請把以下目標語言「已切好的語意單位」，依照語意對齊到既有第一語言字幕時間線。

重要背景：
1. 既有第一語言字幕可能已被人工刪改、濃縮、合併，不等於原文逐句翻譯。
2. 目標語言可能保留原文完整內容，所以有些片段可能完全無法對齊到第一語言任何一列。
3. 遇到無法對齊的目標片段，寧可建立 existingRow = null 的 target-only row，也不要硬塞到相鄰列。

重要原則：
1. 對齊必須以語意、事件順序、上下文承接、句意完成度、舞台指示對應為主。
2. 不可只依照行數、字數、長度相近、標點位置或平均切分來對齊。
3. 若目標語言某一句被切成多行，可以把多個連續目標行對齊到同一個既有字幕列。
4. 若某個既有字幕列在目標語言中沒有直接對應，可以保留該列並讓目標語言為 null。
5. 若某個目標語言片段沒有對應的既有字幕列，可以新增一列 target-only row，讓 existingRow 為 null。
6. 不可改寫、翻譯、摘要或重述內容，只做對齊。
7. 對齊時請優先參考舞台指示、角色、事件順序、情緒轉折、因果承接與場景切換。
8. 若信心不足，優先保留 null 或 target-only row，不要勉強配對。

輸出規則：
1. 一定要輸出 JSON array。
2. 每筆格式為 { "existingRow": 1, "startLine": 1, "endLine": 3 }。
3. existingRow 使用 1-based；若該列是只屬於目標語言的新列，existingRow 請輸出 null。
4. startLine / endLine 使用 1-based 且含頭含尾；若該既有列在目標語言中沒有直接對應，請輸出 null。
5. 每個既有字幕列都必須剛好出現一次，而且必須依照既有順序往下。
6. 所有目標語言 line 都必須剛好使用一次，而且必須依照原順序往下，不可重排、不可重疊、不可跳號。
7. 只有在語意上真的沒有對應既有列時，才可以建立 existingRow = null 的 target-only row。
8. 不可以把語意不對的內容硬塞到長度接近的列裡。

輸出範例：
[
  { "existingRow": 1, "startLine": 1, "endLine": 1 },
  { "existingRow": null, "startLine": 2, "endLine": 2 },
  { "existingRow": 2, "startLine": null, "endLine": null },
  { "existingRow": 3, "startLine": 3, "endLine": 4 }
]

既有第一語言字幕時間線如下：
${baseLines.map((line, index) => formatTimelineAlignmentBaseLine(line, index)).join('\n')}

目標語言名稱：${sanitizeLineText(languageName || '目標語言')}

目標語言已切好的字幕行如下：
${normalizedParsedLines
  .map((line, index) => formatLanguageAlignmentPromptLine(line, index))
  .join('\n')}
      `.trim(),
    },
  ];

  const response = await client.responses.create({
    model: SECONDARY_ALIGNMENT_MODEL,
    input: prompt,
    temperature: 0.1,
    max_output_tokens: 5000,
  });

  const output = response.output_text?.trim();
  if (!output) {
    throw new Error('未能取得語意對齊結果');
  }

  const sanitized = output
    .replace(/^```json/i, '')
    .replace(/^```/i, '')
    .replace(/```$/i, '')
    .trim();
  const parsed = parseJsonArrayLoose(sanitized);
  if (!Array.isArray(parsed)) {
    throw new Error('對齊結果格式錯誤');
  }

  const indexBase = inferAlignmentUnitIndexBase(parsed);
  const plan = parsed.map((entry, index) =>
    normalizeTimelineAlignmentPlanEntry(entry, indexBase, index),
  );
  validateTimelineAlignmentPlan(plan, existingCount, targetCount);
  return plan;
}

async function alignSecondaryLanguageWithOpenAI({
  session,
  rawText,
  apiKey,
  timelineLines,
  languageId,
  languageName,
  languageCode,
}) {
  const warningMessages = [];
  const baseLines = buildLanguageAlignmentBaseLines(timelineLines, languageId);
  const supplementalBuckets = buildPreservedSupplementalAlignmentBuckets(
    timelineLines,
    languageId,
    baseLines.length,
  );
  let parsedLines;

  try {
    parsedLines = await parseAlignmentScriptWithOpenAI(rawText, apiKey, {
      languageCode,
    });
  } catch (error) {
    console.error('Failed to parse target language script:', error);
    if (!fallbackCodes.has(error?.code)) {
      throw error;
    }

    const fallbackNormalized = normalizeScriptLines(
      fallbackSegmentScript(rawText, { languageCode }),
    );
    parsedLines = fallbackNormalized;
    warningMessages.push(
      error?.message
        ? `OpenAI 對齊分段失敗（${error.message}），已改用原稿語意分段`
        : 'OpenAI 對齊分段失敗，已改用原稿語意分段',
    );
  }

  const alignmentPlan = await alignParsedLanguageLinesWithOpenAI({
    apiKey,
    baseLines,
    parsedLines,
    targetLanguageId: languageId,
    languageName,
    languageCode,
  });
  const mergedLines = buildAlignedLanguageTimelineFromPlan({
    session,
    baseLines,
    parsedLines,
    languageId,
    languageCode,
    plan: alignmentPlan,
    supplementalBuckets,
  });

  return {
    lines: mergedLines,
    warning: warningMessages.join('；'),
  };
}

function getOwnedSessionFromRequest(req, res) {
  if (!canManageSessions(req.authUser)) {
    res.status(403).json({ error: '目前權限無法管理控制端場次' });
    return null;
  }
  const { sessionId } = req.params;
  const userId = req.authUser?.id;
  const session = getOwnedSession(sessionId, userId);
  if (!session) {
    res.status(404).json({ error: '找不到場次' });
    return null;
  }
  return session;
}

const registerRateLimit = createRateLimitMiddleware({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: '註冊嘗試過多，請稍後再試',
  keyPrefix: 'auth:register',
});

const loginRateLimit = createRateLimitMiddleware({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: '登入嘗試過多，請稍後再試',
  keyPrefix: 'auth:login',
  keyGenerator: (req) =>
    `${getRequestIp(req)}:${normalizeUsername(req.body?.username) || '*'}`,
});

const forgotPasswordRateLimit = createRateLimitMiddleware({
  windowMs: 30 * 60 * 1000,
  max: 5,
  message: '忘記密碼申請過多，請稍後再試',
  keyPrefix: 'auth:forgot',
  keyGenerator: (req) =>
    `${getRequestIp(req)}:${normalizeUsername(req.body?.username) || '*'}`,
});

const changePasswordRateLimit = createRateLimitMiddleware({
  windowMs: 30 * 60 * 1000,
  max: 8,
  message: '修改密碼操作過多，請稍後再試',
  keyPrefix: 'auth:change-password',
  keyGenerator: (req) => `${getRequestIp(req)}:${req.authUser?.id || 'guest'}`,
});

const accessUnlockRateLimit = createRateLimitMiddleware({
  windowMs: 15 * 60 * 1000,
  max: 12,
  message: '密碼嘗試過多，請稍後再試',
  keyPrefix: 'access:unlock',
});

app.post('/api/access/unlock', accessUnlockRateLimit, (req, res) => {
  const password = normalizePassword(req.body?.password);

  if (!safeTokenEquals(password, SHARED_ACCESS_PASSWORD)) {
    return res.status(401).json({ error: '密碼錯誤' });
  }

  setAccessCookie(res);
  res.json({ user: serializeUser(createSharedAccessUser()) });
});

app.post('/api/auth/register', registerRateLimit, (req, res) => {
  const username = normalizeDisplayName(req.body?.username);
  const usernameNormalized = normalizeUsername(req.body?.username);
  const password = normalizePassword(req.body?.password);

  if (username.length < 3) {
    return res.status(400).json({ error: '帳號至少需要 3 個字' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密碼至少需要 6 個字' });
  }
  if (findUserByNormalizedUsername(usernameNormalized)) {
    return res.status(409).json({ error: '此帳號已存在' });
  }

  const role = countAdminUsers() === 0 ? USER_ROLES.ADMIN : USER_ROLES.OPERATOR;
  const user = createUserRecord({
    username,
    usernameNormalized,
    password,
    role,
  });
  users.set(user.id, user);

  const { token, record } = createAuthTokenRecord(user.id);
  authSessions.set(record.tokenHash, record);
  persistApplicationStore();
  setAuthCookie(res, token);
  res.json({ user: serializeUser(user) });
});

app.post('/api/auth/login', loginRateLimit, (req, res) => {
  const usernameNormalized = normalizeUsername(req.body?.username);
  const password = normalizePassword(req.body?.password);
  const user = findUserByNormalizedUsername(usernameNormalized);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }
  if (isUserDisabled(user)) {
    return res.status(403).json({ error: '此帳號已停用' });
  }

  const { token, record } = createAuthTokenRecord(user.id);
  authSessions.set(record.tokenHash, record);
  persistApplicationStore();
  setAuthCookie(res, token);
  res.json({ user: serializeUser(user) });
});

app.post(
  '/api/auth/change-password',
  requireAuth,
  changePasswordRateLimit,
  (req, res) => {
  const currentPassword = normalizePassword(req.body?.currentPassword);
  const nextPassword = normalizePassword(req.body?.newPassword);

  if (!verifyPassword(currentPassword, req.authUser.passwordHash)) {
    return res.status(401).json({ error: '目前密碼錯誤' });
  }
  if (nextPassword.length < 6) {
    return res.status(400).json({ error: '新密碼至少需要 6 個字' });
  }

  req.authUser.passwordHash = createPasswordHash(nextPassword);
  clearPasswordResetCode(req.authUser);
  revokeUserAuthSessions(req.authUser.id);

  const { token, record } = createAuthTokenRecord(req.authUser.id);
  authSessions.set(record.tokenHash, record);
  persistApplicationStore();
  setAuthCookie(res, token);
  res.json({ user: serializeUser(req.authUser) });
},
);

app.post('/api/auth/forgot-password/request', forgotPasswordRateLimit, (req, res) => {
  const usernameNormalized = normalizeUsername(req.body?.username);
  const user = findUserByNormalizedUsername(usernameNormalized);

  if (!user || isUserDisabled(user)) {
    return res.json({
      ok: true,
      message: '如果帳號存在，系統已收到重設申請，請聯絡管理員協助',
    });
  }

  requestPasswordReset(user);
  persistApplicationStore();
  return res.json({
    ok: true,
    message: '如果帳號存在，系統已收到重設申請，請聯絡管理員協助',
    expiresAt: user.passwordReset?.expiresAt || null,
  });
});

app.post('/api/auth/forgot-password/reset', (req, res) => {
  res.status(410).json({
    error: '此部署已停用前端重設碼流程，請聯絡管理員於後台重設密碼',
  });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.authSession?.tokenHash) {
    authSessions.delete(req.authSession.tokenHash);
    persistApplicationStore();
  }
  clearAuthCookie(res);
  clearAccessCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: serializeUser(req.authUser) });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const adminUsers = Array.from(users.values())
    .map((user) => getAdminUserPayload(user))
    .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));

  res.json({ users: adminUsers });
});

app.patch('/api/admin/users/:userId', requireAdmin, (req, res) => {
  const targetUser = users.get(req.params.userId);
  if (!targetUser) {
    return res.status(404).json({ error: '找不到帳號' });
  }

  const hasRoleChange = Object.prototype.hasOwnProperty.call(req.body || {}, 'role');
  const hasDisableChange = Object.prototype.hasOwnProperty.call(
    req.body || {},
    'disabled',
  );
  const hasPasswordChange = Object.prototype.hasOwnProperty.call(
    req.body || {},
    'newPassword',
  );
  const hasResetClear = req.body?.clearPasswordReset === true;
  const requestedRole = normalizeUserRole(req.body?.role, targetUser.role);
  const requestedDisabled =
    typeof req.body?.disabled === 'boolean'
      ? req.body.disabled
      : isUserDisabled(targetUser);
  const nextPassword = normalizePassword(req.body?.newPassword);

  if (
    req.authUser.id === targetUser.id &&
    ((hasRoleChange && requestedRole !== targetUser.role) ||
      (hasDisableChange && requestedDisabled))
  ) {
    return res.status(400).json({ error: '不能在管理後台停用自己或變更自己的權限' });
  }
  if (req.authUser.id === targetUser.id && hasPasswordChange) {
    return res.status(400).json({ error: '請到首頁的帳號設定修改自己的密碼' });
  }

  const adminTransitionError = ensureUserCanTransitionFromAdmin(
    targetUser,
    requestedRole,
    requestedDisabled,
  );
  if (adminTransitionError) {
    return res.status(400).json({ error: adminTransitionError });
  }

  if (hasRoleChange) {
    targetUser.role = requestedRole;
  }
  if (hasDisableChange) {
    targetUser.disabledAt = requestedDisabled ? Date.now() : null;
    if (requestedDisabled) {
      revokeUserAuthSessions(targetUser.id);
    }
  }
  if (hasPasswordChange) {
    if (nextPassword.length < 6) {
      return res.status(400).json({ error: '新密碼至少需要 6 個字' });
    }
    targetUser.passwordHash = createPasswordHash(nextPassword);
    clearPasswordResetCode(targetUser);
    revokeUserAuthSessions(targetUser.id);
  }
  if (hasResetClear) {
    clearPasswordResetCode(targetUser);
  }

  persistApplicationStore();
  res.json({ user: getAdminUserPayload(targetUser) });
});

app.delete('/api/admin/users/:userId', requireAdmin, (req, res) => {
  const targetUser = users.get(req.params.userId);
  if (!targetUser) {
    return res.status(404).json({ error: '找不到帳號' });
  }
  if (req.authUser.id === targetUser.id) {
    return res.status(400).json({ error: '不能刪除目前登入中的管理員帳號' });
  }

  const adminTransitionError = ensureUserCanTransitionFromAdmin(
    targetUser,
    USER_ROLES.VIEWER,
    true,
  );
  if (adminTransitionError) {
    return res.status(400).json({ error: adminTransitionError });
  }

  revokeUserAuthSessions(targetUser.id);
  clearPasswordResetCode(targetUser);
  const removedSessionCount = deleteOwnedSessionsForUser(
    targetUser.id,
    'owner account deleted',
  );
  users.delete(targetUser.id);
  persistApplicationStore();

  res.json({
    ok: true,
    removedSessionCount,
  });
});

app.get('/api/sessions', requireAuth, (req, res) => {
  const visibleSessions = Array.from(sessions.values())
    .filter((session) =>
      isSharedAccessUser(req.authUser)
        ? true
        : session.ownerUserId === req.authUser.id,
    )
    .map((session) => getSessionSummary(session))
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));

  res.json({ sessions: visibleSessions });
});

app.post('/api/session', requireSessionManager, (req, res) => {
  const session = createSessionRecord(req.authUser.id);
  const requestedTitle = sanitizeLineText(req.body?.title || '');
  if (requestedTitle) {
    session.title = requestedTitle.slice(0, 60);
  }
  sessions.set(session.id, session);
  persistSession(session);
  res.json(getControlPayload(session));
});

app.post('/api/session/import', requireSessionManager, (req, res) => {
  try {
    const session = createImportedSessionFromBackup(req.body, req.authUser);
    validateImportedSessionConflict(session);
    sessions.set(session.id, session);
    persistSession(session);
    res.status(201).json(getControlPayload(session));
  } catch (error) {
    res.status(400).json({
      error: error?.message || '匯入場次備份失敗',
    });
  }
});

app.get('/api/session/:sessionId', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;
  res.json(getControlPayload(session));
});

app.get('/api/session/:sessionId/backup', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;
  res.json(buildSessionBackupPayload(session));
});

app.get('/api/session/:sessionId/viewer', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;
  res.json(getViewerPayload(session));
});

app.get('/api/viewer-entry/:viewerAlias', (req, res) => {
  const viewerAlias =
    typeof req.params.viewerAlias === 'string' ? req.params.viewerAlias.trim() : '';
  const session = resolveViewerEntrySession(viewerAlias);
  if (!session) {
    return res.status(410).json({
      reason: 'missing',
      message: '找不到檢視端入口',
      error: '找不到檢視端入口',
    });
  }

  res.json({
    viewerAlias: session.viewerAlias || '',
    viewerToken: session.viewerToken,
    redirectPath: getViewerEntryRedirectPath(session),
  });
});

app.get('/api/viewer/:viewerToken', (req, res) => {
  const viewerToken =
    typeof req.params.viewerToken === 'string' ? req.params.viewerToken.trim() : '';
  const session = getSessionByViewerToken(viewerToken);
  if (!session) {
    return res
      .status(410)
      .json(getPublicSessionUnavailablePayload('viewer', { session, token: viewerToken }));
  }
  res.json(getViewerPayload(session));
});

app.get('/api/projector/:projectorToken', (req, res) => {
  const projectorToken =
    typeof req.params.projectorToken === 'string'
      ? req.params.projectorToken.trim()
      : '';
  const session = getSessionByProjectorToken(projectorToken);
  if (!session) {
    return res.status(410).json(
      getPublicSessionUnavailablePayload('projector', {
        session,
        token: projectorToken,
      }),
    );
  }
  const projectorPresenceUpdate = markProjectorPresence(session.id);
  if (projectorPresenceUpdate.becameAvailable) {
    broadcastControlState(session.id);
  }
  res.json(getProjectorPayload(session));
});

app.put('/api/session/:sessionId/viewer-alias', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;

  const rawViewerAlias =
    typeof req.body?.viewerAlias === 'string' ? req.body.viewerAlias : '';
  const nextViewerAlias = normalizeViewerAlias(rawViewerAlias);

  if (rawViewerAlias.trim() && !nextViewerAlias) {
    return res.status(400).json({
      error: '檢視端入口只能使用中文、英文、數字、-、_',
    });
  }

  const aliasOwner = getSessionByViewerAlias(nextViewerAlias);
  if (aliasOwner && aliasOwner.id !== session.id) {
    return res.status(409).json({
      error: '此檢視端入口名稱已被其他場次使用',
    });
  }

  if (session.viewerAlias === nextViewerAlias) {
    return res.json(getControlPayload(session));
  }

  session.viewerAlias = nextViewerAlias;
  persistSession(session);
  broadcastControlState(session.id);
  res.json(getControlPayload(session));
});

app.post('/api/session/:sessionId/end', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;

  session.status = 'ended';
  session.endedAt = Date.now();
  session.displayEnabled = false;
  persistSession(session);

  stopTranscriptionStream(session.id, {
    keepText: false,
    reason: 'session ended',
  });
  broadcastControlState(session.id);
  broadcastViewerState(session.id);

  res.json(getControlPayload(session));
});

app.post('/api/session/:sessionId/undo', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;
  if (!undoSessionHistory(session)) {
    return res.status(400).json({ error: '目前沒有可復原的操作' });
  }
  persistSession(session);
  broadcastControlState(session.id);
  broadcastViewerState(session.id);
  res.json(getControlPayload(session));
});

app.post('/api/session/:sessionId/redo', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;
  if (!redoSessionHistory(session)) {
    return res.status(400).json({ error: '目前沒有可還原的操作' });
  }
  persistSession(session);
  broadcastControlState(session.id);
  broadcastViewerState(session.id);
  res.json(getControlPayload(session));
});

app.post('/api/session/:sessionId/cells', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;
  pushSessionHistory(session);
  const cell = createCellDefinition(
    { name: req.body?.name || `儲存格 ${session.cells.length + 1}` },
    session.cells.length,
    getPrimaryLanguageId(session),
  );
  session.cells.push(cell);
  session.selectedCellId = cell.id;
  session.currentIndex = 0;
  syncSelectedCellLines(session);
  persistSession(session);
  broadcastControlState(session.id);
  broadcastViewerState(session.id);
  res.json(getControlPayload(session));
});

app.put('/api/session/:sessionId/cells/:cellId', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;
  const cell = session.cells.find((entry) => entry.id === req.params.cellId);
  if (!cell) {
    return res.status(404).json({ error: '找不到儲存格' });
  }
  const nextName = sanitizeLineText(req.body?.name || '').slice(0, 48);
  if (!nextName) {
    return res.status(400).json({ error: '請輸入儲存格名稱' });
  }
  pushSessionHistory(session);
  cell.name = nextName;
  persistSession(session);
  broadcastControlState(session.id);
  res.json(getControlPayload(session));
});

app.post('/api/session/:sessionId/cells/:cellId/select', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;
  const cell = session.cells.find((entry) => entry.id === req.params.cellId);
  if (!cell) {
    return res.status(404).json({ error: '找不到儲存格' });
  }
  session.selectedCellId = cell.id;
  session.currentIndex = Math.min(session.currentIndex, Math.max(cell.lines.length - 1, 0));
  syncSelectedCellLines(session);
  persistSession(session);
  broadcastControlState(session.id);
  broadcastViewerState(session.id);
  res.json(getControlPayload(session));
});

app.delete('/api/session/:sessionId/cells/:cellId', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;
  if (session.cells.length <= 1) {
    return res.status(400).json({ error: '至少要保留一個儲存格' });
  }
  const targetIndex = session.cells.findIndex((entry) => entry.id === req.params.cellId);
  if (targetIndex === -1) {
    return res.status(404).json({ error: '找不到儲存格' });
  }
  pushSessionHistory(session);
  session.cells.splice(targetIndex, 1);
  if (session.selectedCellId === req.params.cellId) {
    session.selectedCellId = session.cells[Math.max(targetIndex - 1, 0)].id;
    session.currentIndex = 0;
  }
  syncSelectedCellLines(session);
  persistSession(session);
  broadcastControlState(session.id);
  broadcastViewerState(session.id);
  res.json(getControlPayload(session));
});

app.post('/api/session/:sessionId/languages', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;
  const name = sanitizeLineText(req.body?.name || '').slice(0, 40);
  if (!name) {
    return res.status(400).json({ error: '請輸入語言名稱' });
  }
  pushSessionHistory(session);
  session.languages.push(
    createLanguageDefinition(
      {
        id: generateId('lang'),
        name,
        code: sanitizeLineText(req.body?.code || '') || `lang-${session.languages.length + 1}`,
      },
      session.languages.length,
    ),
  );
  ensureSessionLanguages(session);
  persistSession(session);
  broadcastControlState(session.id);
  broadcastViewerState(session.id);
  res.json(getControlPayload(session));
});

app.put('/api/session/:sessionId/languages/:languageId', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;

  const languageIndex = session.languages.findIndex(
    (entry) => entry.id === req.params.languageId,
  );
  if (languageIndex === -1) {
    return res.status(404).json({ error: '找不到語言' });
  }

  const name = sanitizeLineText(req.body?.name || '').slice(0, 40);
  if (!name) {
    return res.status(400).json({ error: '請輸入語言名稱' });
  }

  pushSessionHistory(session);
  session.languages[languageIndex] = createLanguageDefinition(
    {
      ...session.languages[languageIndex],
      name,
    },
    languageIndex,
  );
  ensureSessionLanguages(session);
  persistSession(session);
  broadcastControlState(session.id);
  broadcastViewerState(session.id);
  res.json(getControlPayload(session));
});

app.delete('/api/session/:sessionId/languages/:languageId', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;
  const { languageId } = req.params;
  if (languageId === 'primary') {
    return res.status(400).json({ error: '第一語言不可刪除' });
  }
  const languageIndex = session.languages.findIndex((entry) => entry.id === languageId);
  if (languageIndex === -1) {
    return res.status(404).json({ error: '找不到語言' });
  }
  pushSessionHistory(session);
  session.languages.splice(languageIndex, 1);
  session.cells = session.cells.map((cell) => ({
    ...cell,
    lines: cell.lines
      .map((line) => {
        const translations = { ...(line.translations || {}) };
        delete translations[languageId];
        return createLineRecord(
          {
            ...line,
            translations,
          },
          'primary',
        );
      })
      .filter((line) => lineHasAnyLanguageText(line)),
  }));
  syncSelectedCellLines(session);
  persistSession(session);
  broadcastControlState(session.id);
  broadcastViewerState(session.id);
  res.json(getControlPayload(session));
});

app.post(
  '/api/session/:sessionId/cells/:cellId/languages/:languageId/parse',
  requireAuth,
  async (req, res) => {
    const session = getOwnedSessionFromRequest(req, res);
    if (!session) return;

    const cell = session.cells.find((entry) => entry.id === req.params.cellId);
    if (!cell) {
      return res.status(404).json({ error: '找不到儲存格' });
    }

    const language = session.languages.find(
      (entry) => entry.id === req.params.languageId,
    );
    if (!language) {
      return res.status(404).json({ error: '找不到語言' });
    }
    if (language.id === 'primary') {
      return res.status(400).json({ error: '第一語言請使用劇本解析功能' });
    }

    if (!cell.lines.length) {
      return res.status(400).json({ error: '請先建立第一語言字幕' });
    }

    const apiKey = sanitizeLineText(req.body?.apiKey || '');
    const rawScriptText =
      typeof req.body?.scriptText === 'string' ? req.body.scriptText : '';

    if (!apiKey) {
      return res.status(400).json({ error: '缺少 OpenAI API Key' });
    }
    if (!rawScriptText.trim()) {
      return res.status(400).json({ error: '缺少目標語言文字內容' });
    }

    const normalizedRawText = normalizeSecondaryAlignmentText(
      rawScriptText,
      language.code,
    );

    try {
      const alignmentResult = await alignSecondaryLanguageWithOpenAI({
        session,
        rawText: normalizedRawText,
        apiKey,
        timelineLines: cell.lines,
        languageId: language.id,
        languageName: language.name,
        languageCode: language.code,
      });
      const nextLines = alignmentResult.lines;
      const warning = alignmentResult.warning || '';

      pushSessionHistory(session);
      cell.lines = normalizeScriptLines(nextLines, {
        keepEmpty: true,
        primaryLanguageId: 'primary',
      });
      session.selectedCellId = cell.id;
      syncSelectedCellLines(session);
      persistSession(session);
      broadcastControlState(session.id);
      broadcastViewerState(session.id);

      res.json({
        ...getControlPayload(session),
        ...(warning ? { warning } : {}),
      });
    } catch (error) {
      res.status(500).json({
        error: '解析多語字幕失敗',
        details: error.message,
      });
    }
  },
);

app.post(
  '/api/session/:sessionId/script/parse',
  requireAuth,
  async (req, res) => {
    const session = getOwnedSessionFromRequest(req, res);
    if (!session) return;

    const apiKey = sanitizeLineText(req.body?.apiKey || '');
    const rawScriptText =
      typeof req.body?.scriptText === 'string' ? req.body.scriptText : '';
    const cellId =
      typeof req.body?.cellId === 'string' ? req.body.cellId : session.selectedCellId;

    if (!apiKey) {
      return res.status(400).json({ error: '缺少 OpenAI API Key' });
    }
    if (!rawScriptText.trim()) {
      return res.status(400).json({ error: '缺少劇本文字內容' });
    }

    const cell = session.cells.find((entry) => entry.id === cellId);
    if (!cell) {
      return res.status(404).json({ error: '找不到儲存格' });
    }

    const primaryLanguageCode = session.languages?.[0]?.code || '';
    const rawText = normalizeScriptPromptText(rawScriptText, primaryLanguageCode);

    try {
      let lines;
      let warning = '';
      try {
        lines = await parseScriptWithOpenAI(rawText, apiKey, {
          languageCode: primaryLanguageCode,
        });
      } catch (error) {
        console.error('Failed to parse script:', error);
        if (!fallbackCodes.has(error?.code)) {
          throw error;
        }

        const fallbackNormalized = normalizeScriptLines(
          fallbackSegmentScript(rawText, { languageCode: primaryLanguageCode }),
        );
        lines = enforceLineLengths(fallbackNormalized, {
          languageCode: primaryLanguageCode,
        });
        warning = error?.message
          ? `OpenAI 拆解失敗（${error.message}），已改用原稿分段結果`
          : 'OpenAI 拆解失敗，已改用原稿分段結果';
      }

      const normalizedLines = normalizeScriptLines(lines, {
        primaryLanguageId: 'primary',
      });
      if (normalizedLines.length === 0) {
        const emptyLinesError = new Error('解析完成但沒有產生可用字幕');
        emptyLinesError.code = 'EMPTY_PARSED_LINES';
        throw emptyLinesError;
      }

      pushSessionHistory(session);
      cell.lines = normalizedLines;
      session.selectedCellId = cell.id;
      session.currentIndex = 0;
      session.displayEnabled = true;
      syncSelectedCellLines(session);
      persistSession(session);
      broadcastControlState(session.id);
      broadcastViewerState(session.id);

      res.json({
        ...getControlPayload(session),
        parsedLineCount: normalizedLines.length,
        ...(warning ? { warning } : {}),
      });
    } catch (error) {
      res.status(500).json({
        error: '解析劇本失敗，請確認貼上的內容或稍後再試',
        details: error.message,
        code: error.code || 'UNKNOWN',
      });
    }
  },
);

app.put('/api/session/:sessionId/lines', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;

  const { lines } = req.body;
  const cellId =
    typeof req.body?.cellId === 'string' ? req.body.cellId : session.selectedCellId;
  if (!Array.isArray(lines)) {
    return res.status(400).json({ error: 'lines 必須是陣列' });
  }

  const cell = session.cells.find((entry) => entry.id === cellId);
  if (!cell) {
    return res.status(404).json({ error: '找不到儲存格' });
  }

  pushSessionHistory(session);
  cell.lines = normalizeScriptLines(lines, {
    keepEmpty: true,
    primaryLanguageId: 'primary',
  });
  session.selectedCellId = cell.id;
  syncSelectedCellLines(session);
  persistSession(session);
  broadcastControlState(session.id);
  broadcastViewerState(session.id);
  res.json(getControlPayload(session));
});

app.post('/api/session/:sessionId/current', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;

  const nextIndex = Number.isInteger(req.body?.index)
    ? req.body.index
    : session.currentIndex;

  if (nextIndex < 0 || nextIndex >= session.lines.length) {
    return res.status(400).json({ error: '索引超出範圍' });
  }

  session.currentIndex = nextIndex;
  persistSession(session);
  broadcastControlState(session.id);
  broadcastViewerState(session.id);
  res.json(getControlPayload(session));
});

app.post('/api/session/:sessionId/display', requireAuth, (req, res) => {
  const session = getOwnedSessionFromRequest(req, res);
  if (!session) return;
  session.displayEnabled = Boolean(req.body?.displayEnabled);
  persistSession(session);
  broadcastControlState(session.id);
  broadcastViewerState(session.id);
  res.json(getControlPayload(session));
});

function startRealtimeTranscription({
  sessionId,
  socketId,
  apiKey,
  model,
  language,
  semanticSegmentationEnabled,
  dualChannelEnabled,
  speakerRecognitionEnabled,
  transcriptionContext,
}) {
  const selectedModel = normalizeTranscriptionModel(model);
  const selectedLanguage = normalizeLanguageCode(language);
  const selectedSemanticSegmentationEnabled =
    normalizeSemanticSegmentationEnabled(semanticSegmentationEnabled);
  const selectedDualChannelEnabled =
    normalizeDualChannelEnabled(dualChannelEnabled);
  const selectedSpeakerRecognitionEnabled =
    normalizeSpeakerRecognitionEnabled(speakerRecognitionEnabled);
  const selectedTranscriptionContext = normalizeTranscriptionContextValue(
    transcriptionContext,
  );
  const realtimePromptText = buildRealtimeTranscriptionPrompt({
    language: selectedLanguage,
    transcriptionContext: selectedTranscriptionContext,
  });
  const client = new OpenAI({ apiKey });
  const rt = new OpenAIRealtimeWS({ model: DEFAULT_REALTIME_WS_MODEL }, client);

  const stream = {
    sessionId,
    socketId,
    rt,
    wsModel: DEFAULT_REALTIME_WS_MODEL,
    sessionType: DEFAULT_REALTIME_SESSION_TYPE,
    model: selectedModel,
    language: selectedLanguage,
    transcriptionContext: selectedTranscriptionContext,
    realtimePromptText,
    semanticSegmentationEnabled: selectedSemanticSegmentationEnabled,
    dualChannelEnabled: selectedDualChannelEnabled,
    speakerRecognitionEnabled: selectedSpeakerRecognitionEnabled,
    draftByItemId: new Map(),
    activeDraftItemId: null,
    completedFragments: [],
    fragmentByItemId: new Map(),
    finalizedLines: [],
    finalizedLineByItemId: new Map(),
    mergedLineOverrides: new Map(),
    mergedLineCorrectionKeys: new Set(),
    correctionChain: Promise.resolve(),
    speakerRecognitionChain: Promise.resolve(),
    pendingSpeakerWindowKeys: new Set(),
    pendingAudioChunks: [],
    unboundCommittedSegments: [],
    segmentByItemId: new Map(),
    boundaryMetaByItemId: new Map(),
    pendingCommitBoundaryMeta: null,
    commitSegmentInFlight: null,
    currentSegmentChunks: [],
    currentSegmentBytes: 0,
    currentSegmentMs: 0,
    nextSegmentId: 1,
    nextSpeakerId: 1,
    lastTransportError: '',
    lastSpeakerRecognitionDiagnostic: '',
    lastInputLevel: 0,
    trailingSilenceMs: 0,
    ready: false,
    initTimeout: null,
    forceCommitTimer: null,
    pendingAppendCount: 0,
    firstPendingAudioAt: null,
    pendingAudioMs: 0,
    commitInFlight: false,
    lastCommitAt: 0,
    closing: false,
  };
  transcriptionStreams.set(sessionId, stream);

  const isCurrent = () => transcriptionStreams.get(sessionId) === stream;

  rt.socket.on('open', () => {
    if (!isCurrent()) return;

    updateTranscriptionState(sessionId, {
      active: false,
      status: 'connecting',
      text: '',
      isFinal: true,
      language: selectedLanguage,
      model: selectedModel,
      transcriptionContext: selectedTranscriptionContext,
      semanticSegmentationEnabled: selectedSemanticSegmentationEnabled,
      dualChannelEnabled: selectedDualChannelEnabled,
      speakerRecognitionEnabled: selectedSpeakerRecognitionEnabled,
      error: '',
    });
    broadcastTranscriptionState(sessionId);
    broadcastViewerState(sessionId);

    try {
      rt.send(
        buildRealtimeTranscriptionSessionUpdate({
          model: selectedModel,
          language: selectedLanguage,
          semanticSegmentationEnabled: selectedSemanticSegmentationEnabled,
          transcriptionContext: selectedTranscriptionContext,
        }),
      );
      if (stream.initTimeout) {
        clearTimeout(stream.initTimeout);
      }
      stream.initTimeout = setTimeout(() => {
        if (!isCurrent() || stream.ready || stream.closing) return;
        stopTranscriptionStream(sessionId, {
          keepText: true,
          reason: 'transcription init timeout',
          errorMessage: '語音辨識初始化逾時，請重試',
        });
      }, 8000);
      ensureRealtimeForceCommitTimer(stream);
    } catch (error) {
      const message =
        sanitizeLineText(error?.message || '') || '初始化語音辨識串流失敗';
      stopTranscriptionStream(sessionId, {
        keepText: true,
        reason: 'transcription init failed',
        errorMessage: message,
      });
    }
  });

  rt.on('session.updated', (event) => {
    if (!isCurrent()) return;
    if (stream.ready) return;

    stream.sessionType =
      (typeof event?.session?.type === 'string' && event.session.type) ||
      stream.sessionType;
    stream.ready = true;
    if (stream.initTimeout) {
      clearTimeout(stream.initTimeout);
      stream.initTimeout = null;
    }

    updateTranscriptionState(sessionId, {
      active: true,
      status: 'running',
      text: '',
      isFinal: true,
      language: selectedLanguage,
      model: selectedModel,
      transcriptionContext: selectedTranscriptionContext,
      semanticSegmentationEnabled: selectedSemanticSegmentationEnabled,
      dualChannelEnabled: selectedDualChannelEnabled,
      speakerRecognitionEnabled: selectedSpeakerRecognitionEnabled,
      error: '',
    });
    broadcastTranscriptionState(sessionId);
    broadcastViewerState(sessionId);
    flushQueuedRealtimeAudio(stream);
  });

  rt.on('input_audio_buffer.committed', (event) => {
    if (!isCurrent()) return;
    stream.commitInFlight = false;
    resetRealtimePendingAudio(stream);
    settleCommittedAccurateSegment(stream, event?.item_id);

    const boundaryMeta =
      stream.pendingCommitBoundaryMeta || createBoundaryMeta(stream, 'semantic');
    stream.pendingCommitBoundaryMeta = null;
    if (event?.item_id) {
      stream.boundaryMetaByItemId.set(event.item_id, boundaryMeta);
    }

    if (
      event?.item_id &&
      stream.fragmentByItemId.has(event.item_id)
    ) {
      const lateAccurateSegment = takeAccurateSegmentForItem(
        stream,
        event.item_id,
      );
      if (lateAccurateSegment) {
        queueTranscriptionCorrection({
          stream,
          isCurrent,
          client,
          sessionId,
          itemId: event.item_id,
          language: selectedLanguage,
          accurateSegment: lateAccurateSegment,
        });
      }
    }
  });

  rt.on('input_audio_buffer.cleared', () => {
    if (!isCurrent()) return;
    stream.commitInFlight = false;
    resetRealtimePendingAudio(stream);
    stream.pendingCommitBoundaryMeta = null;
    stream.commitSegmentInFlight = null;
    resetAccurateSegmentCapture(stream);
  });

  rt.on('conversation.item.input_audio_transcription.delta', (event) => {
    if (!isCurrent()) return;
    if (!event.item_id || typeof event.delta !== 'string') return;

    const previous = stream.draftByItemId.get(event.item_id) || '';
    const merged = normalizeTranscriptionOutputText(
      `${previous}${event.delta}`,
      selectedLanguage,
      stream.realtimePromptText,
    );
    setDraftLine(stream, event.item_id, merged);
    syncTranscriptionStateFromStream(sessionId, stream);
  });

  rt.on('conversation.item.input_audio_transcription.completed', (event) => {
    if (!isCurrent()) return;
    if (!event.item_id) return;

    const fallback = takeDraftLine(stream, event.item_id);
    const transcript = normalizeTranscriptionOutputText(
      event.transcript || fallback,
      selectedLanguage,
      stream.realtimePromptText,
    );
    const accurateSegment = takeAccurateSegmentForItem(stream, event.item_id);
    const boundaryMeta = stream.boundaryMetaByItemId.get(event.item_id) || null;
    stream.boundaryMetaByItemId.delete(event.item_id);
    upsertCompletedFragment(stream, {
      itemId: event.item_id,
      text: transcript,
      accurateSegment,
      boundaryMeta,
    });
    syncTranscriptionStateFromStream(sessionId, stream);
    queueTranscriptionCorrection({
      stream,
      isCurrent,
      client,
      sessionId,
      itemId: event.item_id,
      language: selectedLanguage,
      accurateSegment,
    });

    const mergedLine = stream.finalizedLineByItemId.get(event.item_id) || null;
    if (mergedLine?.itemIds?.length > 1) {
      queueMergedLineCorrection({
        stream,
        isCurrent,
        client,
        sessionId,
        line: mergedLine,
        language: selectedLanguage,
      });
    }

    queueSpeakerRecognition({
      stream,
      isCurrent,
      client,
      sessionId,
      language: selectedLanguage,
    });
  });

  rt.on('conversation.item.input_audio_transcription.failed', (event) => {
    if (!isCurrent()) return;

    const message =
      sanitizeLineText(event?.error?.message || '') || '語音片段辨識失敗';
    takeDraftLine(stream, event?.item_id);
    stream.boundaryMetaByItemId.delete(event?.item_id);
    dropAccurateSegmentForItem(stream, event?.item_id);
    syncTranscriptionStateFromStream(sessionId, stream, {
      error: message,
    });
  });

  rt.on('error', (error) => {
    if (!isCurrent()) return;

    const message =
      sanitizeLineText(error?.error?.message || error?.message || '') ||
      '語音辨識連線發生錯誤';
    stream.lastTransportError = message;

    if (isIgnorableRealtimeCommitError(message)) {
      stream.commitInFlight = false;
      stream.lastCommitAt = Date.now();
      stream.pendingCommitBoundaryMeta = null;
      stream.commitSegmentInFlight = null;
      return;
    }

    if (!stream.ready && /could not send data/i.test(message)) {
      // If websocket is being closed during initialization, close handler usually
      // carries the more specific upstream reason.
      return;
    }

    stopTranscriptionStream(sessionId, {
      keepText: true,
      reason: 'transcription error',
      errorMessage: message,
    });
  });

  rt.socket.on('close', (code, reason) => {
    if (!isCurrent()) return;

    transcriptionStreams.delete(sessionId);
    clearRealtimeForceCommitTimer(stream);
    resetRealtimePendingAudio(stream);
    resetRealtimeCommitState(stream);
    resetAccurateTranscriptionState(stream);
    if (stream.closing) {
      return;
    }

    const closeReason = normalizeCloseReason(reason);
    const message =
      closeReason ||
      sanitizeLineText(stream.lastTransportError || '') ||
      (code === 1008
        ? 'OpenAI 驗證失敗，請確認 API Key 權限'
        : '語音辨識連線已中斷');

    applyTranscriptionError(sessionId, message);
  });

  return stream;
}

io.on('connection', (socket) => {
  const socketAuth = resolveAuthFromCookieHeader(socket.handshake.headers.cookie);
  const socketUser = socketAuth.user;

  const getOwnedSocketSession = (sessionId) => {
    if (!socketUser || !canManageSessions(socketUser)) return null;
    return getOwnedSession(sessionId, socketUser.id);
  };

  socket.on('join', ({ sessionId, role, viewerToken, projectorToken }) => {
    if (role === 'viewer') {
      const viewerSession = viewerToken
        ? getSessionByViewerToken(viewerToken)
        : getSession(sessionId);
      if (!viewerSession) {
        socket.emit(
          'viewer:expired',
          getPublicSessionUnavailablePayload('viewer', {
            session: viewerSession,
            token: viewerToken,
          }),
        );
        return;
      }
      socket.join(`viewer:${viewerSession.id}`);
      socket.data.publicRole = 'viewer';
      socket.data.viewerSessionId = viewerSession.id;
      broadcastViewerState(viewerSession.id);
      return;
    }

    if (role === 'projector') {
      const projectorSession = projectorToken
        ? getSessionByProjectorToken(projectorToken)
        : getSession(sessionId);
      if (!projectorSession) {
        socket.emit(
          'projector:expired',
          getPublicSessionUnavailablePayload('projector', {
            session: projectorSession,
            token: projectorToken,
          }),
        );
        return;
      }
      socket.join(`projector:${projectorSession.id}`);
      socket.data.publicRole = 'projector';
      socket.data.projectorSessionId = projectorSession.id;
      addProjectorConnection(projectorSession.id, socket.id);
      markProjectorPresence(projectorSession.id);
      setProjectorStatus(projectorSession, {
        level: PROJECTOR_STATUS_LEVELS.INFO,
        code: 'connected',
        message: '投影端已連線',
      });
      persistSession(projectorSession);
      broadcastControlState(projectorSession.id);
      broadcastProjectorState(projectorSession.id);
      return;
    }

    if (!sessionId) return;
    const session = getOwnedSocketSession(sessionId);
    if (!session) {
      socket.emit('transcription:error', {
        message: '無法存取此場次',
      });
      return;
    }

    socket.join(`control:${session.id}`);
    socket.data.publicRole = 'control';
    socket.data.controlSessionId = session.id;
    broadcastControlState(session.id);
  });

  socket.on('projector:status', (payload) => {
    const sessionId =
      typeof socket.data?.projectorSessionId === 'string'
        ? socket.data.projectorSessionId
        : '';
    if (!sessionId) return;

    const session = getSession(sessionId);
    if (!session) return;

    const level =
      payload?.level === PROJECTOR_STATUS_LEVELS.WARNING ||
      payload?.level === PROJECTOR_STATUS_LEVELS.ERROR
        ? payload.level
        : PROJECTOR_STATUS_LEVELS.INFO;
    const code = sanitizeLineText(payload?.code || '').slice(0, 48);
    const message = sanitizeLineText(payload?.message || '').slice(0, 240);

    if (!code && !message) return;

    markProjectorPresence(
      session.id,
      typeof payload?.occurredAt === 'number' && Number.isFinite(payload.occurredAt)
        ? payload.occurredAt
        : Date.now(),
    );
    setProjectorStatus(session, {
      level,
      code,
      message,
      occurredAt:
        typeof payload?.occurredAt === 'number' && Number.isFinite(payload.occurredAt)
          ? payload.occurredAt
          : Date.now(),
    });
    persistSession(session);
    broadcastControlState(session.id);
  });

  socket.on(
    'transcription:start',
    ({
      sessionId,
      apiKey,
      language,
      model,
      semanticSegmentationEnabled,
      dualChannelEnabled,
      speakerRecognitionEnabled,
      transcriptionContext,
    }) => {
      if (!sessionId) return;

      const session = getOwnedSocketSession(sessionId);
      if (!session) return;

      const trimmedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
      if (!trimmedApiKey) {
        applyTranscriptionError(sessionId, '缺少 OpenAI API Key，無法啟動語音辨識');
        return;
      }

      const active = transcriptionStreams.get(sessionId);
      if (active && active.socketId !== socket.id) {
        socket.emit('transcription:error', {
          message: '此場次已有其他控制端在進行語音辨識',
        });
        return;
      }

      if (active && active.socketId === socket.id) {
        stopTranscriptionStream(sessionId, {
          keepText: false,
          reason: 'restart transcription',
        });
      }

      updateTranscriptionState(sessionId, {
        active: false,
        status: 'connecting',
        text: '',
        isFinal: true,
        language: normalizeLanguageCode(language),
        model: normalizeTranscriptionModel(model),
        transcriptionContext: normalizeTranscriptionContextValue(
          transcriptionContext,
        ),
        semanticSegmentationEnabled: normalizeSemanticSegmentationEnabled(
          semanticSegmentationEnabled,
        ),
        dualChannelEnabled: normalizeDualChannelEnabled(dualChannelEnabled),
        speakerRecognitionEnabled: normalizeSpeakerRecognitionEnabled(
          speakerRecognitionEnabled,
        ),
        error: '',
      });
      broadcastTranscriptionState(sessionId);
      broadcastViewerState(sessionId);

      try {
        startRealtimeTranscription({
          sessionId,
          socketId: socket.id,
          apiKey: trimmedApiKey,
          language,
          model,
          semanticSegmentationEnabled,
          dualChannelEnabled,
          speakerRecognitionEnabled,
          transcriptionContext,
        });
      } catch (error) {
        const message =
          sanitizeLineText(error?.message || '') || '啟動語音辨識失敗';
        applyTranscriptionError(sessionId, message);
      }
    },
  );

  socket.on('transcription:audio', ({ sessionId, audio, durationMs, level }) => {
    if (!sessionId) return;
    if (typeof audio !== 'string' || !audio) return;
    const normalizedDurationMs = normalizeChunkDurationMs(durationMs);
    const normalizedLevel = normalizeAudioLevel(level);

    const stream = transcriptionStreams.get(sessionId);
    if (!stream || stream.socketId !== socket.id || stream.closing) {
      return;
    }

    if (!stream.ready) {
      stream.pendingAudioChunks.push({
        audio,
        durationMs: normalizedDurationMs,
        level: normalizedLevel,
      });
      if (stream.pendingAudioChunks.length > MAX_PENDING_AUDIO_CHUNKS) {
        stream.pendingAudioChunks.splice(
          0,
          stream.pendingAudioChunks.length - MAX_PENDING_AUDIO_CHUNKS,
        );
      }
      return;
    }

    try {
      sendRealtimeAudioChunk(stream, audio, normalizedDurationMs, normalizedLevel);
    } catch (error) {
      const message =
        sanitizeLineText(error?.message || '') ||
        '傳送語音資料到辨識服務失敗';
      stopTranscriptionStream(sessionId, {
        keepText: true,
        reason: 'send audio failed',
        errorMessage: message,
      });
    }
  });

  socket.on('transcription:stop', ({ sessionId }) => {
    if (!sessionId) return;

    const stream = transcriptionStreams.get(sessionId);
    if (!stream || stream.socketId !== socket.id) {
      return;
    }

    stopTranscriptionStream(sessionId, {
      keepText: false,
      reason: 'client requested stop',
    });
  });

  socket.on('setCurrentIndex', ({ sessionId, index }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    if (
      Number.isInteger(index) &&
      index >= 0 &&
      index < session.lines.length
    ) {
      session.currentIndex = index;
      persistSession(session);
      broadcastControlState(sessionId);
      broadcastViewerState(sessionId);
    }
  });

  socket.on('shiftIndex', ({ sessionId, delta }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    const nextIndex = Math.min(
      Math.max(session.currentIndex + (delta || 0), 0),
      Math.max(session.lines.length - 1, 0),
    );

    if (nextIndex !== session.currentIndex) {
      session.currentIndex = nextIndex;
      persistSession(session);
      broadcastControlState(sessionId);
      broadcastViewerState(sessionId);
    }
  });

  socket.on('setDisplay', ({ sessionId, displayEnabled }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    session.displayEnabled = Boolean(displayEnabled);
    persistSession(session);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('setRoleColorEnabled', ({ sessionId, roleColorEnabled }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    session.roleColorEnabled = roleColorEnabled !== false;
    persistSession(session);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('setMusicEffectEnabled', ({ sessionId, musicEffectEnabled }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    session.musicEffectEnabled = musicEffectEnabled !== false;
    persistSession(session);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('setViewerDefaultLanguage', ({ sessionId, languageId }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    const nextLanguageId = resolveSessionLanguageId(session, languageId);
    if (session.viewerDefaultLanguageId === nextLanguageId) {
      return;
    }

    pushSessionHistory(session);
    session.viewerDefaultLanguageId = nextLanguageId;
    persistSession(session);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('setProjectorDefaultLanguage', ({ sessionId, languageId }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    const nextLanguageId = resolveSessionLanguageId(session, languageId);
    if (session.projectorDefaultLanguageId === nextLanguageId) {
      return;
    }

    pushSessionHistory(session);
    session.projectorDefaultLanguageId = nextLanguageId;
    persistSession(session);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('setProjectorDisplayMode', ({ sessionId, displayMode }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    const nextDisplayMode = normalizeProjectorDisplayMode(displayMode);
    if (session.projectorDisplayMode === nextDisplayMode) {
      return;
    }

    pushSessionHistory(session);
    session.projectorDisplayMode = nextDisplayMode;
    session.projectorRevision = normalizeProjectorRevision(
      session.projectorRevision + 1,
    );
    persistSession(session);
    broadcastControlState(sessionId);
    broadcastProjectorState(sessionId);
  });

  socket.on('updateProjectorLayout', ({ sessionId, layout }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    const previousLayout = normalizeProjectorLayout(session.projectorLayout);
    const nextLayout = normalizeProjectorLayout({
      ...previousLayout,
      ...(layout && typeof layout === 'object' ? layout : {}),
    });
    if (projectorLayoutsEqual(previousLayout, nextLayout)) {
      return;
    }
    session.projectorLayout = nextLayout;
    session.projectorRevision = normalizeProjectorRevision(
      session.projectorRevision + 1,
    );
    persistSession(session);
    broadcastControlState(sessionId);
    broadcastProjectorLayoutState(sessionId);
  });

  socket.on('updateLine', ({ sessionId, index, text, type, music, languageId }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    if (
      Number.isInteger(index) &&
      index >= 0 &&
      index < session.lines.length &&
      typeof text === 'string'
    ) {
      pushSessionHistory(session);
      const existingRaw = session.lines[index];
      const sanitized = sanitizeLineText(text);
      const explicitType = clampLineType(type);
      const targetLanguageId =
        typeof languageId === 'string' && languageId.trim()
          ? languageId.trim()
          : 'primary';
      const previousType =
        existingRaw &&
        typeof existingRaw === 'object' &&
        typeof existingRaw.type === 'string'
          ? clampLineType(existingRaw.type)
          : null;
      const nextType = explicitType ?? previousType ?? LINE_TYPES.DIALOGUE;
      const existingTranslations = normalizeTranslationsMap(
        existingRaw?.translations,
        'primary',
        existingRaw?.text || '',
      );
      existingTranslations[targetLanguageId] = sanitized;
      const primaryText =
        targetLanguageId === 'primary'
          ? sanitized
          : sanitizeLineText(existingRaw?.text || '');

      const nextLine = createLineRecord(
        existingRaw && typeof existingRaw === 'object'
          ? {
              ...existingRaw,
              text: primaryText,
              type: nextType,
              music:
                typeof music === 'boolean'
                  ? normalizeLineMusic(music)
                  : existingRaw.music === true,
              translations: existingTranslations,
            }
          : {
              text: primaryText,
              type: nextType,
              music: normalizeLineMusic(music),
              translations: existingTranslations,
            },
        'primary',
      );
      if (lineHasAnyLanguageText(nextLine)) {
        session.lines[index] = nextLine;
      } else {
        session.lines.splice(index, 1);
        if (session.currentIndex >= session.lines.length) {
          session.currentIndex = Math.max(session.lines.length - 1, 0);
        } else if (session.currentIndex > index) {
          session.currentIndex -= 1;
        } else if (session.currentIndex === index) {
          session.currentIndex = Math.max(index - 1, 0);
        }
      }

      persistSession(session);
      broadcastControlState(sessionId);
      broadcastViewerState(sessionId);
    }
  });

  socket.on('setLineType', ({ sessionId, index, type }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    const normalizedType = clampLineType(type);
    if (
      !normalizedType ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= session.lines.length
    ) {
      return;
    }

    const existing = session.lines[index];
    if (!existing) return;
    pushSessionHistory(session);

    const text = sanitizeLineText(
      typeof existing === 'string' ? existing : existing.text,
    );

    session.lines[index] = createLineRecord(
      {
        ...existing,
        text,
        type: normalizedType,
        music: isLineMarkedMusic(existing),
        translations: existing.translations,
        role: existing.role,
      },
      'primary',
    );

    persistSession(session);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('setLineRole', ({ sessionId, index, role }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    if (!Number.isInteger(index) || index < 0 || index >= session.lines.length) {
      return;
    }

    const existing = session.lines[index];
    if (!existing) return;

    const normalizedType =
      clampLineType(existing?.type) || LINE_TYPES.DIALOGUE;
    if (normalizedType === LINE_TYPES.DIRECTION) {
      return;
    }

    const nextRole = normalizeRoleName(role);
    const previousRole = normalizeRoleName(existing?.role);
    if (nextRole === previousRole) {
      return;
    }

    pushSessionHistory(session);
    session.lines[index] = createLineRecord(
      {
        ...existing,
        text: sanitizeLineText(existing?.text || ''),
        type: normalizedType,
        music: isLineMarkedMusic(existing),
        translations: existing?.translations,
        role: nextRole,
      },
      'primary',
    );

    persistSession(session);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('setLineMusic', ({ sessionId, index, music }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= session.lines.length ||
      typeof music !== 'boolean'
    ) {
      return;
    }

    const existing = session.lines[index];
    if (!existing) return;
    pushSessionHistory(session);

    const text = sanitizeLineText(
      typeof existing === 'string' ? existing : existing.text,
    );
    const type =
      existing && typeof existing === 'object'
        ? clampLineType(existing.type) || LINE_TYPES.DIALOGUE
        : LINE_TYPES.DIALOGUE;

    session.lines[index] = createLineRecord(
      {
        ...existing,
        text,
        type,
        music: normalizeLineMusic(music),
        translations: existing.translations,
        role: existing.role,
      },
      'primary',
    );

    persistSession(session);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('setLineMusicRange', ({ sessionId, startIndex, endIndex, music }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    if (
      !Number.isInteger(startIndex) ||
      !Number.isInteger(endIndex) ||
      startIndex < 0 ||
      endIndex < 0 ||
      startIndex >= session.lines.length ||
      endIndex >= session.lines.length ||
      typeof music !== 'boolean'
    ) {
      return;
    }

    const rangeStart = Math.min(startIndex, endIndex);
    const rangeEnd = Math.max(startIndex, endIndex);
    const nextMusic = normalizeLineMusic(music);
    pushSessionHistory(session);

    for (let index = rangeStart; index <= rangeEnd; index += 1) {
      const existing = session.lines[index];
      if (!existing) continue;

      const text = sanitizeLineText(
        typeof existing === 'string' ? existing : existing.text,
      );
      const type =
        existing && typeof existing === 'object'
          ? clampLineType(existing.type) || LINE_TYPES.DIALOGUE
          : LINE_TYPES.DIALOGUE;

      session.lines[index] = createLineRecord(
        {
          ...existing,
          text,
          type,
          music: nextMusic,
          translations: existing.translations,
          role: existing.role,
        },
        'primary',
      );
    }

    persistSession(session);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on(
    'moveLanguageSuffixToNextLine',
    ({ sessionId, index, beforeText, afterText, languageId }) => {
      const session = getOwnedSocketSession(sessionId);
      if (!session) return;

      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= session.lines.length ||
        typeof beforeText !== 'string' ||
        typeof afterText !== 'string'
      ) {
        return;
      }

      const before = sanitizeLineText(beforeText);
      const after = sanitizeLineText(afterText);
      if (!before || !after) return;

      const targetLanguageId = resolveSessionLanguageId(session, languageId);
      if (targetLanguageId === 'primary') return;

      const existing = session.lines[index];
      if (!existing) return;

      pushSessionHistory(session);
      session.lines[index] = updateSessionLineLanguageText(
        existing,
        targetLanguageId,
        before,
      );

      if (index + 1 < session.lines.length) {
        const nextLine = session.lines[index + 1];
        session.lines[index + 1] = updateSessionLineLanguageText(
          nextLine,
          targetLanguageId,
          joinTranscriptionTexts(
            after,
            getLineLanguageText(nextLine, targetLanguageId),
          ),
        );
      } else {
        session.lines.push(
          createBlankSessionLineLike(session, existing, targetLanguageId, after),
        );
      }

      persistSession(session);
      broadcastControlState(sessionId);
      broadcastViewerState(sessionId);
    },
  );

  socket.on('shiftLanguageDown', ({ sessionId, index, languageId }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    if (!Number.isInteger(index) || index < 0 || index >= session.lines.length) {
      return;
    }

    const targetLanguageId = resolveSessionLanguageId(session, languageId);
    if (targetLanguageId === 'primary') return;

    const currentLine = session.lines[index];
    const tailSource = session.lines[session.lines.length - 1] || currentLine;
    if (!currentLine) return;

    pushSessionHistory(session);
    session.lines.push(
      createBlankSessionLineLike(session, tailSource, targetLanguageId, ''),
    );

    for (
      let lineIndex = session.lines.length - 1;
      lineIndex > index + 1;
      lineIndex -= 1
    ) {
      session.lines[lineIndex] = updateSessionLineLanguageText(
        session.lines[lineIndex],
        targetLanguageId,
        getLineLanguageText(session.lines[lineIndex - 1], targetLanguageId),
      );
    }

    session.lines[index + 1] = updateSessionLineLanguageText(
      session.lines[index + 1],
      targetLanguageId,
      '',
    );

    persistSession(session);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('splitLine', ({ sessionId, index, beforeText, afterText, languageId }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= session.lines.length ||
      typeof beforeText !== 'string' ||
      typeof afterText !== 'string'
    ) {
      return;
    }

    const before = sanitizeLineText(beforeText);
    const after = sanitizeLineText(afterText);
    if (!before || !after) return;
    const targetLanguageId = resolveSessionLanguageId(session, languageId);

    const existing = session.lines[index];
    const existingTranslations = normalizeTranslationsMap(
      existing?.translations,
      'primary',
      existing?.text || '',
    );

    if (targetLanguageId !== 'primary') {
      pushSessionHistory(session);
      existingTranslations[targetLanguageId] = before;

      session.lines[index] = createLineRecord(
        {
          ...existing,
          translations: existingTranslations,
        },
        'primary',
      );
      session.lines.splice(
        index + 1,
        0,
        createBlankSessionLine(session, {
          type:
            existing?.type === LINE_TYPES.DIRECTION
              ? LINE_TYPES.DIRECTION
              : LINE_TYPES.DIALOGUE,
          music: isLineMarkedMusic(existing),
          role: existing?.role || null,
          languageId: targetLanguageId,
          text: after,
        }),
      );

      if (session.currentIndex > index) {
        session.currentIndex += 1;
      }

      persistSession(session);
      broadcastControlState(sessionId);
      broadcastViewerState(sessionId);
      return;
    }

    pushSessionHistory(session);
    const type =
      existing && typeof existing === 'object'
        ? clampLineType(existing.type) || LINE_TYPES.DIALOGUE
        : LINE_TYPES.DIALOGUE;

    const firstLine = {
      text: before,
      type,
      music: isLineMarkedMusic(existing),
      role: existing?.role || null,
      translations: {
        ...buildBlankTranslationsForSession(session),
        primary: before,
        ...Object.fromEntries(
          Object.entries(existing?.translations || {}).filter(
            ([languageId]) => languageId !== 'primary',
          ),
        ),
      },
    };
    const secondLine = {
      text: after,
      type,
      music: isLineMarkedMusic(existing),
      role: existing?.role || null,
      translations: {
        ...buildBlankTranslationsForSession(session),
        primary: after,
      },
    };

    session.lines.splice(
      index,
      1,
      createLineRecord(firstLine, 'primary'),
      createLineRecord(secondLine, 'primary'),
    );

    if (session.currentIndex > index) {
      session.currentIndex += 1;
    }

    persistSession(session);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('insertLineAfter', ({ sessionId, index, type, languageId }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    if (!Number.isInteger(index) || index < 0 || index >= session.lines.length) {
      return;
    }

    const targetLanguageId = resolveSessionLanguageId(session, languageId);
    const existing = session.lines[index];
    const baseType =
      clampLineType(type) ||
      (existing && typeof existing === 'object'
        ? clampLineType(existing.type)
        : null) ||
      LINE_TYPES.DIALOGUE;
    pushSessionHistory(session);

    session.lines.splice(
      index + 1,
      0,
      createBlankSessionLine(session, {
        type: baseType,
        music: isLineMarkedMusic(existing),
        role: existing?.role || null,
        languageId: targetLanguageId,
        text: '',
      }),
    );

    if (session.currentIndex > index) {
      session.currentIndex += 1;
    }

    persistSession(session);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('mergeLineIntoPrevious', ({ sessionId, index, currentText, languageId }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    if (
      !Number.isInteger(index) ||
      index <= 0 ||
      index >= session.lines.length
    ) {
      return;
    }

    const previous = session.lines[index - 1];
    const current = session.lines[index];
    if (!previous || !current) return;
    const targetLanguageId = resolveSessionLanguageId(session, languageId);
    pushSessionHistory(session);

    const previousText = sanitizeLineText(
      typeof previous === 'string' ? previous : previous.text,
    );
    const nextCurrentText = sanitizeLineText(
      typeof currentText === 'string'
        ? currentText
        : typeof current === 'string'
          ? current
          : current.text,
    );
    const previousType =
      previous && typeof previous === 'object'
        ? clampLineType(previous.type) || LINE_TYPES.DIALOGUE
        : LINE_TYPES.DIALOGUE;
    const blankTranslations = buildBlankTranslationsForSession(session);
    const previousTranslations = normalizeTranslationsMap(
      previous?.translations,
      'primary',
      previousText,
    );
    const currentTranslations = normalizeTranslationsMap(
      current?.translations,
      'primary',
      nextCurrentText,
    );

    if (targetLanguageId !== 'primary') {
      previousTranslations[targetLanguageId] = joinTranscriptionTexts(
        previousTranslations[targetLanguageId] || '',
        currentTranslations[targetLanguageId] || nextCurrentText,
      );
      currentTranslations[targetLanguageId] = '';

      session.lines[index - 1] = createLineRecord(
        {
          ...previous,
          translations: previousTranslations,
        },
        'primary',
      );
      const nextCurrentLine = createLineRecord(
        {
          ...current,
          translations: currentTranslations,
        },
        'primary',
      );
      if (lineHasAnyLanguageText(nextCurrentLine)) {
        session.lines[index] = nextCurrentLine;
      } else {
        session.lines.splice(index, 1);
      }

      if (session.currentIndex > index) {
        session.currentIndex -= 1;
      } else if (session.currentIndex === index) {
        session.currentIndex = index - 1;
      }

      persistSession(session);
      broadcastControlState(sessionId);
      broadcastViewerState(sessionId);
      return;
    }

    const mergedTranslationIds = new Set([
      ...Object.keys(blankTranslations),
      ...Object.keys(previousTranslations),
      ...Object.keys(currentTranslations),
    ]);
    const mergedTranslations = {};

    mergedTranslationIds.forEach((languageId) => {
      mergedTranslations[languageId] = joinTranscriptionTexts(
        previousTranslations[languageId] || '',
        currentTranslations[languageId] || '',
      );
    });

    const mergedText = joinTranscriptionTexts(previousText, nextCurrentText);
    mergedTranslations.primary = mergedText;

    session.lines.splice(
      index - 1,
      2,
      createLineRecord(
        {
          ...previous,
          text: mergedText,
          type: previousType,
          music: isLineMarkedMusic(previous) || isLineMarkedMusic(current),
          role: previous?.role || current?.role || null,
          translations: mergedTranslations,
        },
        'primary',
      ),
    );

    if (session.currentIndex > index) {
      session.currentIndex -= 1;
    } else if (session.currentIndex === index) {
      session.currentIndex = index - 1;
    }

    persistSession(session);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('deleteLine', ({ sessionId, index }) => {
    const session = getOwnedSocketSession(sessionId);
    if (!session) return;

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= session.lines.length
    ) {
      return;
    }

    pushSessionHistory(session);
    session.lines.splice(index, 1);

    if (session.currentIndex >= session.lines.length) {
      session.currentIndex = Math.max(session.lines.length - 1, 0);
    } else if (session.currentIndex > index) {
      session.currentIndex -= 1;
    }

    persistSession(session);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('disconnect', () => {
    const projectorSessionId =
      typeof socket.data?.projectorSessionId === 'string'
        ? socket.data.projectorSessionId
        : '';
    if (projectorSessionId) {
      const remainingConnections = removeProjectorConnection(projectorSessionId, socket.id);
      const projectorSession = getSession(projectorSessionId);
      if (projectorSession) {
        if (remainingConnections > 0) {
          setProjectorStatus(projectorSession, {
            level: PROJECTOR_STATUS_LEVELS.INFO,
            code: 'connected',
            message: `投影端仍有 ${remainingConnections} 個連線`,
          });
          persistSession(projectorSession);
        } else if (!isProjectorRecentlySeen(projectorSessionId)) {
          setProjectorStatus(projectorSession, {
            level: PROJECTOR_STATUS_LEVELS.WARNING,
            code: 'disconnected',
            message: '投影端已斷線',
          });
          persistSession(projectorSession);
        }
        broadcastControlState(projectorSessionId);
      }
    }

    const ownedSessions = [];
    transcriptionStreams.forEach((stream, sessionId) => {
      if (stream.socketId === socket.id) {
        ownedSessions.push(sessionId);
      }
    });

    ownedSessions.forEach((sessionId) => {
      stopTranscriptionStream(sessionId, {
        keepText: false,
        reason: 'control socket disconnected',
      });
    });
  });
});

app.get('/v/:viewerAlias', (req, res) => {
  const viewerAlias =
    typeof req.params.viewerAlias === 'string' ? req.params.viewerAlias.trim() : '';
  const session = resolveViewerEntrySession(viewerAlias);
  const redirectTarget = session
    ? getViewerEntryRedirectPath(session)
    : viewerAlias
      ? `/viewer/${encodeURIComponent(viewerAlias)}`
      : '/viewer';
  res.redirect(302, redirectTarget);
});

const clientDistPath = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDistPath)) {
  app.use(
    express.static(clientDistPath, {
      index: false,
    }),
  );

  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) {
      return next();
    }

    const indexFile = path.join(clientDistPath, 'index.html');
    res.sendFile(indexFile, (err) => {
      if (err) {
        next(err);
      }
    });
  });
}

async function startServer() {
  try {
    await initializeApplicationStore();
    if (!projectorPresenceSweepTimer) {
      projectorPresenceSweepTimer = setInterval(
        sweepProjectorPresence,
        PROJECTOR_PRESENCE_SWEEP_INTERVAL_MS,
      );
    }
    server.listen(PORT, () => {
      console.log(
        `Server listening on http://localhost:${PORT} using ${PERSISTENCE_BACKEND} persistence`,
      );
    });
  } catch (error) {
    console.error('Failed to initialize application store:', error);
    process.exit(1);
  }
}

startServer();
