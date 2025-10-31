const express = require('express');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { OpenAI } = require('openai');
const iconv = require('iconv-lite');

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

const upload = multer({
  limits: {
    fileSize: MAX_SCRIPT_SIZE,
    files: 1,
  },
});

const sessions = new Map();

const placeholderRegex = /^[第]?[零〇一二三四五六七八九十百千\d]+[句行條話]$/i;

const LINE_TYPES = {
  DIALOGUE: 'dialogue',
  DIRECTION: 'direction',
};

const MAX_LINE_LENGTH = 20;
const DEFAULT_SESSION_ID = 'default';
const MAX_CHUNK_LENGTH = 2500;
const punctuationOnlyRegex = /^[\p{P}\p{S}\s]+$/u;

const fallbackCodes = new Set([
  'INVALID_LLM_OUTPUT',
  'PLACEHOLDER_OUTPUT',
  'INVALID_JSON',
  'MISSING_OUTPUT',
  'EMPTY_OUTPUT',
]);

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
      createdAt: Date.now(),
    });
  }

  return sessions.get(sessionId);
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function broadcastControlState(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;

  const lines = ensureSessionLines(session);
  if (session.currentIndex >= lines.length) {
    session.currentIndex = Math.max(lines.length - 1, 0);
  }

  io.to(`control:${sessionId}`).emit('control:update', {
    lines,
    currentIndex: session.currentIndex,
    displayEnabled: session.displayEnabled,
  });
}

function broadcastViewerState(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;

  const lines = ensureSessionLines(session);
  if (session.currentIndex >= lines.length) {
    session.currentIndex = Math.max(lines.length - 1, 0);
  }

  const activeLine =
    session.displayEnabled && lines.length > 0
      ? lines[session.currentIndex] || null
      : null;

  io.to(`viewer:${sessionId}`).emit('viewer:update', {
    line: session.displayEnabled ? activeLine : null,
    text:
      session.displayEnabled && activeLine
        ? activeLine.type === LINE_TYPES.DIRECTION
          ? ''
          : activeLine.text
        : '',
    displayEnabled: session.displayEnabled,
  });
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
  });
});

app.get('/api/session/:sessionId/viewer', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const lines = ensureSessionLines(session);
  if (session.currentIndex >= lines.length) {
    session.currentIndex = Math.max(lines.length - 1, 0);
  }

  const activeLine =
    session.displayEnabled && lines.length > 0
      ? lines[session.currentIndex] || null
      : null;

  res.json({
    line: session.displayEnabled ? activeLine : null,
    text:
      session.displayEnabled && activeLine
        ? activeLine.type === LINE_TYPES.DIRECTION
          ? ''
          : activeLine.text
        : '',
    displayEnabled: session.displayEnabled,
  });
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
  });
});

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
