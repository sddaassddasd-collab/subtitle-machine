const express = require('express');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { OpenAI } = require('openai');
const { OpenAIRealtimeWS } = require('openai/realtime/ws');
const { toFile } = require('openai/uploads');
const iconv = require('iconv-lite');
const OpenCC = require('opencc-js');

const PORT = process.env.PORT || 3000;
const MAX_SCRIPT_SIZE = 512 * 1024; // 512 KB limit for uploads

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT'],
  },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});

const upload = multer({
  limits: {
    fileSize: MAX_SCRIPT_SIZE,
    files: 1,
  },
});

const sessions = new Map();
const transcriptionStreams = new Map();

const defaultTranscriptionState = () => ({
  active: false,
  status: 'idle',
  text: '',
  isFinal: true,
  language: null,
  model: DEFAULT_TRANSCRIPTION_MODEL,
  semanticSegmentationEnabled:
    DEFAULT_TRANSCRIPTION_SEMANTIC_SEGMENTATION_ENABLED,
  dualChannelEnabled: DEFAULT_TRANSCRIPTION_DUAL_CHANNEL_ENABLED,
  error: '',
  updatedAt: null,
});

const placeholderRegex = /^[第]?[零〇一二三四五六七八九十百千\d]+[句行條話]$/i;

const LINE_TYPES = {
  DIALOGUE: 'dialogue',
  DIRECTION: 'direction',
};

const MAX_LINE_LENGTH = 20;
const DEFAULT_SESSION_ID = 'default';
const MAX_CHUNK_LENGTH = 2500;
const MAX_PENDING_AUDIO_CHUNKS = 400;
const MAX_TRANSCRIPTION_DISPLAY_LINES = 8;
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
const TRANSCRIPTION_CORRECTION_ENABLED =
  process.env.TRANSCRIPTION_CORRECTION_ENABLED !== 'false';
const DEFAULT_TRANSCRIPTION_SEMANTIC_SEGMENTATION_ENABLED =
  process.env.TRANSCRIPTION_SEMANTIC_SEGMENTATION_ENABLED !== 'false';
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
  process.env.TRANSCRIPTION_DUAL_CHANNEL_ENABLED === 'true';
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
const avoidBoundarySuffixRegex =
  /(的|了|著|过|過|在|跟|和|與|及|而且|但是|如果|因為|所以|就是|然後|還有|對|把|被|給|讓|嗎|呢|吧)$/u;
const avoidBoundaryPrefixRegex =
  /^(的|了|著|过|過|在|跟|和|與|及|而且|但是|如果|因為|所以|就是|然後|還有|對|把|被|給|讓|嗎|呢|吧)/u;
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

function stripBom(text) {
  if (!text) return '';
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectBomEncoding(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf8';
  }
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      if (buffer.length >= 4 && buffer[2] === 0x00 && buffer[3] === 0x00) {
        return 'utf32le';
      }
      return 'utf16le';
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return 'utf16be';
    }
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x00 &&
    buffer[1] === 0x00 &&
    buffer[2] === 0xfe &&
    buffer[3] === 0xff
  ) {
    return 'utf32be';
  }
  return null;
}

function analyzeTextStats(text) {
  let hanCount = 0;
  let asciiCount = 0;
  let latinSupplementCount = 0;
  let replacementCount = 0;

  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === 0xfffd) {
      replacementCount += 1;
      continue;
    }
    if (code >= 0x4e00 && code <= 0x9fff) {
      hanCount += 1;
    } else if (code >= 0x3400 && code <= 0x4dbf) {
      hanCount += 1;
    } else if (code >= 0x20000 && code <= 0x2a6df) {
      hanCount += 1;
    } else if (code >= 0x2a700 && code <= 0x2b73f) {
      hanCount += 1;
    } else if (code >= 0x2b740 && code <= 0x2b81f) {
      hanCount += 1;
    } else if (code >= 0x2b820 && code <= 0x2ceaf) {
      hanCount += 1;
    } else if (code >= 0x2ceb0 && code <= 0x2ebef) {
      hanCount += 1;
    } else if (code >= 0x2f800 && code <= 0x2fa1f) {
      hanCount += 1;
    } else if (code >= 0x20 && code <= 0x7e) {
      asciiCount += 1;
    } else if (code >= 0x80 && code <= 0xff) {
      latinSupplementCount += 1;
    }
  }

  return {
    hanCount,
    asciiCount,
    latinSupplementCount,
    replacementCount,
    length: text.length,
  };
}

function scoreDecodedText(stats, encoding) {
  if (stats.length === 0) return -Infinity;

  const { hanCount, asciiCount, latinSupplementCount, replacementCount } = stats;
  let score = 0;

  score += hanCount * 6;
  score += asciiCount * 2;
  score -= latinSupplementCount * 3;
  score -= replacementCount * 20;

  // Slight bonus for UTF encodings to avoid over-penalizing English scripts.
  if (encoding === 'utf8' || encoding === 'utf-8') {
    score += 5;
  }

  return score;
}

function decodeWithEncoding(buffer, encoding) {
  try {
    switch (encoding) {
      case 'utf8':
      case 'utf-8':
        return stripBom(buffer.toString('utf8'));
      case 'utf16le':
      case 'utf-16le':
        return stripBom(buffer.toString('utf16le'));
      case 'utf16be':
      case 'utf-16be':
        return stripBom(iconv.decode(buffer, 'utf16-be'));
      case 'utf32le':
      case 'utf-32le':
        return stripBom(iconv.decode(buffer, 'utf32le'));
      case 'utf32be':
      case 'utf-32be':
        return stripBom(iconv.decode(buffer, 'utf32be'));
      default:
        return stripBom(iconv.decode(buffer, encoding));
    }
  } catch (error) {
    return null;
  }
}

function decodeScriptBuffer(buffer) {
  if (!buffer || buffer.length === 0) return '';

  const detected = detectBomEncoding(buffer);
  const candidateOrder = [
    ...(detected ? [detected] : []),
    'utf8',
    'utf16le',
    'utf16be',
    'gb18030',
    'big5',
    'latin1',
  ];

  let bestText = null;
  let bestScore = -Infinity;

  for (const encoding of candidateOrder) {
    const decoded = decodeWithEncoding(buffer, encoding);
    if (typeof decoded !== 'string' || decoded.length === 0) {
      continue;
    }

    const stats = analyzeTextStats(decoded);
    const score = scoreDecodedText(stats, encoding);

    if (score > bestScore) {
      bestScore = score;
      bestText = decoded;
    }
  }

  if (bestText && bestScore > -Infinity) {
    return bestText;
  }

  // Fallback to default UTF-8 decoding as a last resort.
  return stripBom(buffer.toString('utf8'));
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

function normalizePunctuation(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/[.,，。、]/g, ' ');
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

function chunkScript(rawText, limit = MAX_CHUNK_LENGTH) {
  const units = [];

  rawText
    .split(/\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .forEach((paragraph) => {
      const sentences =
        paragraph.match(/[^。！？!?]+[。！？!?]?/gu) || [paragraph];
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

function normalizeLineEntry(entry, keepEmpty = false) {
  if (entry == null) return null;

  if (typeof entry === 'string') {
    const text = sanitizeLineText(entry);
    if (!text) {
      if (keepEmpty) {
        return {
          text: '',
          type: LINE_TYPES.DIALOGUE,
        };
      }
      return null;
    }
    return {
      text,
      type: isLikelyDirection(text) ? LINE_TYPES.DIRECTION : LINE_TYPES.DIALOGUE,
    };
  }

  if (typeof entry === 'object') {
    const text = sanitizeLineText(
      entry.text ?? entry.line ?? entry.caption ?? '',
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

    return { text, type };
  }

  return null;
}

function normalizeScriptLines(entries, options = {}) {
  const keepEmpty = Boolean(options.keepEmpty);
  if (!Array.isArray(entries)) {
    return [];
  }

  const normalized = [];

  entries.forEach((entry) => {
    const base = normalizeLineEntry(entry, keepEmpty);
    if (!base) return;

    if (!base.text) {
      if (keepEmpty) {
        normalized.push({
          text: '',
          type:
            base.type === LINE_TYPES.DIRECTION
              ? LINE_TYPES.DIRECTION
              : LINE_TYPES.DIALOGUE,
        });
      }
      return;
    }

    const expanded = expandStageDirectionSegments(base);
    expanded.forEach((item) => {
      const text = sanitizeLineText(item.text);
      if (!text) {
        if (keepEmpty) {
          normalized.push({
            text: '',
            type:
              item.type === LINE_TYPES.DIRECTION
                ? LINE_TYPES.DIRECTION
                : LINE_TYPES.DIALOGUE,
          });
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
      normalized.push({
        text: cleanedText,
        type:
          item.type === LINE_TYPES.DIRECTION
            ? LINE_TYPES.DIRECTION
            : LINE_TYPES.DIALOGUE,
      });
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
        text: sanitized,
        type,
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

function enforceLineLengths(entries, limit = MAX_LINE_LENGTH) {
  const result = [];

  entries.forEach((entry) => {
    if (!entry || !entry.text) return;

    if (
      entry.type === LINE_TYPES.DIRECTION ||
      entry.text.length <= limit
    ) {
      result.push(entry);
      return;
    }

    const chunks = chunkDialogueText(entry.text, limit);
    chunks.forEach((chunk) => {
      const text = sanitizeLineText(chunk);
      if (!text) return;
      result.push({
        text,
        type: LINE_TYPES.DIALOGUE,
      });
    });
  });

  return result;
}

function chunkDialogueText(text, limit = MAX_LINE_LENGTH) {
  const sentences =
    text.match(/[^。！？!?；;，,、]+[。！？!?；;，,、]?/gu) || [text];
  const chunks = [];

  sentences.forEach((sentence) => {
    let remaining = sanitizeLineText(sentence);
    if (!remaining) return;

    while (remaining.length > limit) {
      const cut = findBreakPosition(remaining, limit);
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

function findBreakPosition(text, limit) {
  if (text.length <= limit) {
    return text.length;
  }

  for (let i = Math.min(limit, text.length - 1); i >= 1; i -= 1) {
    if (/[ \u3000]/.test(text[i - 1])) {
      return i;
    }
  }

  for (let i = limit; i > Math.max(limit - 5, 1); i -= 1) {
    if (/[，,、；;…]/.test(text[i - 1])) {
      return i;
    }
  }

  return text.length;
}

function ensureSessionLines(session) {
  if (!session) return [];
  const normalized = normalizeScriptLines(session.lines || [], {
    keepEmpty: true,
  });
  session.lines = normalized;
  return session.lines;
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

function fallbackSegmentScript(rawText) {
  const lines = [];
  const paragraphs = rawText
    .split(/\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  paragraphs.forEach((paragraph) => {
    const matches = paragraph.match(/[^。！？!?]+[。！？!?]?/gu);
    const units =
      matches && matches.length > 0
        ? matches.map((sentence) => sentence.trim()).filter(Boolean)
        : [paragraph];

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

function sanitizeModelLines(parsed, sourceText) {
  const normalized = normalizeScriptLines(parsed);
  const cleaned = enforceLineLengths(normalized);

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
}) {
  const prompt = [
    {
      role: 'system',
      content:
        'You split theater scripts into concise subtitle lines for live performances.',
    },
    {
      role: 'user',
      content: `
你正在拆解第 ${chunkIndex + 1} 段（共 ${totalChunks} 段）的劇本內容，請輸出 JSON array，元素格式為：
{ "type": "dialogue" | "direction", "text": "原文內容" }

請保持原始順序與文字，不新增或刪除任何內容，也不要重複前面處理過的段落。
若文字過長，請以保留語意為優先，盡量在空格處切開，確保每段不超過 20 個中文字。
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

  return sanitizeModelLines(parsed, chunkText);
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

function stripTranscriptionPromptLeak(text) {
  const sanitized = sanitizeTranscriptionText(text);
  if (!sanitized) return '';
  if (!TRANSCRIPTION_TRADITIONAL_OUTPUT_PROMPT) return sanitized;

  const promptText = sanitizeTranscriptionText(
    TRANSCRIPTION_TRADITIONAL_OUTPUT_PROMPT,
  );
  if (!promptText) return sanitized;

  if (sanitized === promptText) {
    return '';
  }

  if (!sanitized.startsWith(promptText)) {
    return sanitized;
  }

  return sanitized
    .slice(promptText.length)
    .replace(/^[，,。.!?！？；;：:\-\s]+/u, '')
    .trim();
}

function normalizeTranscriptionOutputText(text, language) {
  const sanitized = stripTranscriptionPromptLeak(text);
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

function getTranscriptionTextLength(text) {
  return Array.from(sanitizeTranscriptionText(text)).filter((char) => !/\s/u.test(char))
    .length;
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
    clearMergedLineOverridesForItem(stream, itemId);
    return existing;
  }

  const fragment = {
    itemId,
    text: sanitized,
    corrected: false,
    accurateSegment: accurateSegment || null,
    boundaryMeta: boundaryMeta || null,
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

  if (avoidBoundarySuffixRegex.test(left)) {
    score -= 2;
  }
  if (avoidBoundaryPrefixRegex.test(right)) {
    score -= 2;
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

function getTranscriptionDisplayParts(stream) {
  if (!stream) {
    return { historyLines: [], draftText: '' };
  }

  const historyLines = refreshGroupedTranscriptionLines(stream)
    .map((line) => sanitizeTranscriptionText(line?.text || ''))
    .filter(Boolean);

  const draftItemId = stream.activeDraftItemId;
  const fallbackDraftId = getLastDraftItemId(stream);
  const selectedDraftId = draftItemId || fallbackDraftId;
  const draftText = selectedDraftId
    ? sanitizeTranscriptionText(stream.draftByItemId.get(selectedDraftId) || '')
    : '';

  if (!draftText || historyLines.length === 0) {
    return { historyLines, draftText };
  }

  const lastFragment =
    Array.isArray(stream.completedFragments) && stream.completedFragments.length > 0
      ? stream.completedFragments[stream.completedFragments.length - 1]
      : null;
  const currentLineText = historyLines[historyLines.length - 1] || '';
  const shouldStartNewLine = shouldBreakBetweenFragments({
    currentText: currentLineText,
    previousFragment: lastFragment,
    nextFragment: { text: draftText },
  });

  if (shouldStartNewLine) {
    return { historyLines, draftText };
  }

  const mergedHistory = historyLines.slice(0, -1);
  mergedHistory.push(joinTranscriptionTexts(currentLineText, draftText));
  return { historyLines: mergedHistory, draftText: '' };
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

async function correctTranscriptionLine({ client, text, language }) {
  const original = normalizeTranscriptionOutputText(text, language);
  if (!original) return '';

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

  const response = await client.audio.transcriptions.create({
    file: audioFile,
    model: TRANSCRIPTION_ACCURATE_MODEL,
    ...(language ? { language } : {}),
    ...(TRANSCRIPTION_ACCURATE_PROMPT
      ? { prompt: TRANSCRIPTION_ACCURATE_PROMPT }
      : {}),
  });

  const rawText =
    typeof response === 'string' ? response : response?.text || '';
  return normalizeTranscriptionOutputText(rawText, language);
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
    semanticSegmentationEnabled: state.semanticSegmentationEnabled !== false,
    dualChannelEnabled: state.dualChannelEnabled === true,
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

function isAccurateSegmentEligible(segment) {
  if (!segment || !Buffer.isBuffer(segment.pcm) || segment.pcm.length === 0) {
    return false;
  }
  const durationMs =
    Number.isFinite(segment.durationMs) && segment.durationMs > 0
      ? segment.durationMs
      : getPcmDurationMs(segment.pcm.length);
  if (durationMs < TRANSCRIPTION_ACCURATE_MIN_SEGMENT_MS) return false;
  if (durationMs > TRANSCRIPTION_ACCURATE_MAX_SEGMENT_MS) return false;
  return true;
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
}) {
  const transcription = {
    model,
    ...(language ? { language } : {}),
  };
  if (
    shouldPreferTraditionalChinese(language) &&
    TRANSCRIPTION_TRADITIONAL_OUTPUT_PROMPT
  ) {
    transcription.prompt = TRANSCRIPTION_TRADITIONAL_OUTPUT_PROMPT;
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

function getViewerPayload(session) {
  const lines = ensureSessionLines(session);
  if (session.currentIndex >= lines.length) {
    session.currentIndex = Math.max(lines.length - 1, 0);
  }

  const transcription = ensureTranscriptionState(session);
  const liveText = sanitizeTranscriptionMultilineText(transcription.text);
  const hasLiveText = transcription.active && liveText.length > 0;

  if (!session.displayEnabled) {
    return {
      line: null,
      text: '',
      displayEnabled: false,
      source: 'hidden',
      transcription: getPublicTranscriptionState(session),
    };
  }

  if (hasLiveText) {
    return {
      line: {
        text: liveText,
        type: LINE_TYPES.DIALOGUE,
      },
      text: liveText,
      displayEnabled: true,
      source: 'transcription',
      transcription: getPublicTranscriptionState(session),
    };
  }

  const activeLine = lines.length > 0 ? lines[session.currentIndex] || null : null;
  return {
    line: activeLine,
    text:
      activeLine && activeLine.type === LINE_TYPES.DIRECTION
        ? ''
        : activeLine?.text || '',
    displayEnabled: true,
    source: 'script',
    transcription: getPublicTranscriptionState(session),
  };
}

/**
 * Returns or creates a session state bucket.
 */
function ensureSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      lines: [],
      currentIndex: 0,
      displayEnabled: true,
      transcription: defaultTranscriptionState(),
      createdAt: Date.now(),
    });
  }

  const session = sessions.get(sessionId);
  ensureTranscriptionState(session);
  return session;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function broadcastControlState(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;

  const lines = ensureSessionLines(session);
  const transcription = getPublicTranscriptionState(session);
  if (session.currentIndex >= lines.length) {
    session.currentIndex = Math.max(lines.length - 1, 0);
  }

  io.to(`control:${sessionId}`).emit('control:update', {
    lines,
    currentIndex: session.currentIndex,
    displayEnabled: session.displayEnabled,
    transcription,
  });
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

  const payload = getViewerPayload(session);
  io.to(`viewer:${sessionId}`).emit('viewer:update', payload);
}

async function parseScriptWithOpenAI(rawText, apiKey) {
  const client = new OpenAI({ apiKey });
  const chunks = chunkScript(rawText, MAX_CHUNK_LENGTH);
  const combined = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunkText = chunks[index];

    try {
      const parsedLines = await parseChunk({
        client,
        chunkText,
        chunkIndex: index,
        totalChunks: chunks.length,
      });
      combined.push(...parsedLines);
    } catch (error) {
      if (fallbackCodes.has(error?.code)) {
        console.warn(
          `Chunk ${index + 1}/${chunks.length} failed validation, using fallback.`,
          error,
        );
        const fallbackLines = enforceLineLengths(
          normalizeScriptLines(fallbackSegmentScript(chunkText)),
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

  return enforceLineLengths(combined);
}

app.post('/api/session', (_req, res) => {
  const sessionId = DEFAULT_SESSION_ID;
  ensureSession(sessionId);
  res.json({
    sessionId,
    viewerPath: `/viewer`,
    controlPath: `/control`,
  });
});

app.get('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const lines = ensureSessionLines(session);
  res.json({
    sessionId,
    lines,
    currentIndex: session.currentIndex,
    displayEnabled: session.displayEnabled,
    transcription: getPublicTranscriptionState(session),
  });
});

app.get('/api/session/:sessionId/viewer', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const payload = getViewerPayload(session);
  res.json(payload);
});

app.post(
  '/api/session/:sessionId/script/upload',
  upload.single('script'),
  async (req, res) => {
    const { sessionId } = req.params;
    const apiKey = req.body.apiKey?.trim();
    const file = req.file;

    if (!apiKey) {
      return res.status(400).json({ error: '缺少 OpenAI API Key' });
    }

    if (!file) {
      return res.status(400).json({ error: '未上傳劇本檔案' });
    }

    const session = ensureSession(sessionId);
    const rawText = normalizePunctuation(decodeScriptBuffer(file.buffer));

    try {
      const lines = await parseScriptWithOpenAI(rawText, apiKey);

      session.lines = lines;
      session.currentIndex = 0;
      session.displayEnabled = true;

      broadcastControlState(sessionId);
      broadcastViewerState(sessionId);

      const normalizedLines = ensureSessionLines(session);
      res.json({
        lines: normalizedLines,
        currentIndex: session.currentIndex,
        displayEnabled: session.displayEnabled,
        transcription: getPublicTranscriptionState(session),
      });
    } catch (error) {
      console.error('Failed to parse script:', error);

      const shouldFallback = fallbackCodes.has(error?.code);

      if (shouldFallback) {
        const fallbackNormalized = normalizeScriptLines(
          fallbackSegmentScript(rawText),
        );
        const fallbackLines = enforceLineLengths(fallbackNormalized);
        if (fallbackLines.length > 0) {
          console.warn(
            'Falling back to basic script segmentation due to invalid or missing model output.',
          );
          session.lines = fallbackLines;
          session.currentIndex = 0;
          session.displayEnabled = true;

          broadcastControlState(sessionId);
          broadcastViewerState(sessionId);

          const normalizedLines = ensureSessionLines(session);
          const warningMessage = error?.message
            ? `OpenAI 拆解失敗（${error.message}），已改用原稿分段結果`
            : 'OpenAI 拆解失敗，已改用原稿分段結果';

          return res.json({
            lines: normalizedLines,
            currentIndex: session.currentIndex,
            displayEnabled: session.displayEnabled,
            transcription: getPublicTranscriptionState(session),
            warning: warningMessage,
          });
        }
      }

      res.status(500).json({
        error: '解析劇本失敗，請確認檔案內容或稍後再試',
        details: error.message,
        code: error.code || 'UNKNOWN',
      });
    }
  },
);

app.put('/api/session/:sessionId/lines', (req, res) => {
  const { sessionId } = req.params;
  const { lines } = req.body;

  if (!Array.isArray(lines)) {
    return res.status(400).json({ error: 'lines 必須是陣列' });
  }

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  session.lines = normalizeScriptLines(lines, { keepEmpty: true });

  if (session.currentIndex >= session.lines.length) {
    session.currentIndex = Math.max(session.lines.length - 1, 0);
  }

  broadcastControlState(sessionId);
  broadcastViewerState(sessionId);

  res.json({
    lines: session.lines,
    currentIndex: session.currentIndex,
    displayEnabled: session.displayEnabled,
    transcription: getPublicTranscriptionState(session),
  });
});

app.post('/api/session/:sessionId/current', (req, res) => {
  const { sessionId } = req.params;
  const { index } = req.body;

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const nextIndex = Number.isInteger(index)
    ? index
    : session.currentIndex;

  if (nextIndex < 0 || nextIndex >= session.lines.length) {
    return res.status(400).json({ error: '索引超出範圍' });
  }

  session.currentIndex = nextIndex;

  broadcastControlState(sessionId);
  broadcastViewerState(sessionId);

  res.json({
    currentIndex: session.currentIndex,
    transcription: getPublicTranscriptionState(session),
  });
});

app.post('/api/session/:sessionId/display', (req, res) => {
  const { sessionId } = req.params;
  const { displayEnabled } = req.body;

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  session.displayEnabled = Boolean(displayEnabled);

  broadcastControlState(sessionId);
  broadcastViewerState(sessionId);

  res.json({
    displayEnabled: session.displayEnabled,
    transcription: getPublicTranscriptionState(session),
  });
});

function startRealtimeTranscription({
  sessionId,
  socketId,
  apiKey,
  model,
  language,
  semanticSegmentationEnabled,
  dualChannelEnabled,
}) {
  const selectedModel = normalizeTranscriptionModel(model);
  const selectedLanguage = normalizeLanguageCode(language);
  const selectedSemanticSegmentationEnabled =
    normalizeSemanticSegmentationEnabled(semanticSegmentationEnabled);
  const selectedDualChannelEnabled =
    normalizeDualChannelEnabled(dualChannelEnabled);
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
    semanticSegmentationEnabled: selectedSemanticSegmentationEnabled,
    dualChannelEnabled: selectedDualChannelEnabled,
    draftByItemId: new Map(),
    activeDraftItemId: null,
    completedFragments: [],
    fragmentByItemId: new Map(),
    finalizedLines: [],
    finalizedLineByItemId: new Map(),
    mergedLineOverrides: new Map(),
    mergedLineCorrectionKeys: new Set(),
    correctionChain: Promise.resolve(),
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
    lastTransportError: '',
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
      semanticSegmentationEnabled: selectedSemanticSegmentationEnabled,
      dualChannelEnabled: selectedDualChannelEnabled,
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
      semanticSegmentationEnabled: selectedSemanticSegmentationEnabled,
      dualChannelEnabled: selectedDualChannelEnabled,
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
  socket.on('join', ({ sessionId, role }) => {
    if (!sessionId) return;

    ensureSession(sessionId);
    socket.join(sessionId);

    if (role === 'viewer') {
      socket.join(`viewer:${sessionId}`);
      broadcastViewerState(sessionId);
    } else {
      socket.join(`control:${sessionId}`);
      broadcastControlState(sessionId);
    }
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
    }) => {
      if (!sessionId) return;

      const session = getSession(sessionId);
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
        semanticSegmentationEnabled: normalizeSemanticSegmentationEnabled(
          semanticSegmentationEnabled,
        ),
        dualChannelEnabled: normalizeDualChannelEnabled(dualChannelEnabled),
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
    const session = getSession(sessionId);
    if (!session) return;

    if (
      Number.isInteger(index) &&
      index >= 0 &&
      index < session.lines.length
    ) {
      session.currentIndex = index;
      broadcastControlState(sessionId);
      broadcastViewerState(sessionId);
    }
  });

  socket.on('shiftIndex', ({ sessionId, delta }) => {
    const session = getSession(sessionId);
    if (!session) return;

    const nextIndex = Math.min(
      Math.max(session.currentIndex + (delta || 0), 0),
      Math.max(session.lines.length - 1, 0),
    );

    if (nextIndex !== session.currentIndex) {
      session.currentIndex = nextIndex;
      broadcastControlState(sessionId);
      broadcastViewerState(sessionId);
    }
  });

  socket.on('setDisplay', ({ sessionId, displayEnabled }) => {
    const session = getSession(sessionId);
    if (!session) return;

    session.displayEnabled = Boolean(displayEnabled);
    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('updateLine', ({ sessionId, index, text, type }) => {
    const session = getSession(sessionId);
    if (!session) return;

    if (
      Number.isInteger(index) &&
      index >= 0 &&
      index < session.lines.length &&
      typeof text === 'string'
    ) {
      const existingRaw = session.lines[index];
      const sanitized = sanitizeLineText(text);
      const explicitType = clampLineType(type);
      const previousType =
        existingRaw &&
        typeof existingRaw === 'object' &&
        typeof existingRaw.type === 'string'
          ? clampLineType(existingRaw.type)
          : null;
      const nextType = explicitType ?? previousType ?? LINE_TYPES.DIALOGUE;

      session.lines[index] =
        existingRaw && typeof existingRaw === 'object'
          ? { ...existingRaw, text: sanitized, type: nextType }
          : { text: sanitized, type: nextType };

      broadcastControlState(sessionId);
      broadcastViewerState(sessionId);
    }
  });

  socket.on('setLineType', ({ sessionId, index, type }) => {
    const session = getSession(sessionId);
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

    const text = sanitizeLineText(
      typeof existing === 'string' ? existing : existing.text,
    );

    session.lines[index] = {
      text,
      type: normalizedType,
    };

    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('splitLine', ({ sessionId, index, beforeText, afterText }) => {
    const session = getSession(sessionId);
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

    const existing = session.lines[index];
    const type =
      existing && typeof existing === 'object'
        ? clampLineType(existing.type) || LINE_TYPES.DIALOGUE
        : LINE_TYPES.DIALOGUE;

    const firstLine = {
      text: before,
      type,
    };
    const secondLine = {
      text: after,
      type,
    };

    session.lines.splice(index, 1, firstLine, secondLine);

    if (session.currentIndex > index) {
      session.currentIndex += 1;
    }

    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('insertLineAfter', ({ sessionId, index, type }) => {
    const session = getSession(sessionId);
    if (!session) return;

    if (!Number.isInteger(index) || index < 0 || index >= session.lines.length) {
      return;
    }

    const existing = session.lines[index];
    const baseType =
      clampLineType(type) ||
      (existing && typeof existing === 'object'
        ? clampLineType(existing.type)
        : null) ||
      LINE_TYPES.DIALOGUE;

    session.lines.splice(index + 1, 0, {
      text: '',
      type: baseType,
    });

    if (session.currentIndex > index) {
      session.currentIndex += 1;
    }

    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('deleteLine', ({ sessionId, index }) => {
    const session = getSession(sessionId);
    if (!session) return;

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= session.lines.length
    ) {
      return;
    }

    session.lines.splice(index, 1);

    if (session.currentIndex >= session.lines.length) {
      session.currentIndex = Math.max(session.lines.length - 1, 0);
    } else if (session.currentIndex > index) {
      session.currentIndex -= 1;
    }

    broadcastControlState(sessionId);
    broadcastViewerState(sessionId);
  });

  socket.on('disconnect', () => {
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

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
