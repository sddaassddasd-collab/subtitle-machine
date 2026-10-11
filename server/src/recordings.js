const crypto = require('node:crypto');
const { normalizeText } = require('./auto-follow');
const {FRAME_MS, DIMENSIONS, decodeFeatures} = require('./acoustic-follow');
const MAX_DURATION = 3600;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RECORDINGS = 5;
const hashText = line => crypto.createHash('sha256').update(`${line?.type || 'dialogue'}\n${line?.text || ''}`).digest('hex').slice(0, 24);
const isUsableSegment = (segment, line) => Boolean(line && line.type !== 'direction' &&
  ['auto', 'manual'].includes(segment.status) && segment.textHash === hashText(line) &&
  Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start);

function normalizeRecordings(session) {
  if (!Array.isArray(session.recordings)) session.recordings = [];
  session.recordings = session.recordings.filter(recording => recording && typeof recording.id === 'string')
    .slice(0, MAX_RECORDINGS).map(recording => {
      recording.name = String(recording.name || recording.originalName || '參考錄音').slice(0, 120);
      recording.segments = Array.isArray(recording.segments) ? recording.segments.filter(s => s && typeof s.lineId === 'string') : [];
      recording.revision = Number.isSafeInteger(recording.revision) ? recording.revision : 1;
      return recording;
    });
  if (!session.recordings.some(r => r.id === session.activeRecordingId)) session.activeRecordingId = null;
  return session.recordings;
}

function recordingLines(session, recording) {
  if (recording.cellId === session.selectedCellId) return session.lines || [];
  return session.cells?.find(cell => cell.id === recording.cellId)?.lines || [];
}

function refreshMappings(session) {
  for (const recording of normalizeRecordings(session)) {
    const lines = new Map(recordingLines(session, recording).map(line => [line.id, line]));
    let changed = false;
    for (const segment of recording.segments) {
      const line = lines.get(segment.lineId);
      if (['auto', 'manual'].includes(segment.status) && (!line || segment.textHash !== hashText(line))) {
        segment.sourceStatus = segment.status; segment.status = 'stale'; changed = true;
      } else if (line && segment.status === 'stale' && ['auto','manual'].includes(segment.sourceStatus) &&
        segment.textHash === hashText(line)) {
        segment.status = segment.sourceStatus; delete segment.sourceStatus; changed = true;
      }
    }
    if (changed) recording.revision++;
  }
}

function validSegments(session, recording) {
  const byId = new Map(recording.segments.map(segment => [segment.lineId, segment]));
  return session.lines.flatMap((line, index) => {
    const segment = byId.get(line.id);
    return segment && isUsableSegment(segment, line) ? [{...segment, index}] : [];
  });
}

function publicRecording(recording, {details = false} = {}) {
  const {id, name, originalName, duration, byteLength, mime, cellId, status, progress, error, createdAt, revision} = recording;
  return {id, name, originalName, duration, byteLength, mime, cellId, status, progress, error, createdAt, revision,
    mappedCount: recording.segments.filter(s => ['auto','manual'].includes(s.status)).length,
    reviewCount: recording.segments.filter(s => ['review','unmatched','stale'].includes(s.status)).length,
    ...(details ? {segments: recording.segments} : {}),
  };
}

function wordTimeline(words, duration) {
  const chars = [], times = [];
  let lastStart = -1;
  for (const word of words || []) {
    const text = Array.from(normalizeText(word.word || word.text || ''));
    if (!text.length || !Number.isFinite(word.start) || !Number.isFinite(word.end) ||
      word.start < lastStart || word.start < 0 || word.end <= word.start || word.end > duration + 0.1) continue;
    lastStart = word.start;
    text.forEach((char, i) => {
      chars.push(char);
      times.push({start: word.start + i / text.length * (word.end - word.start),
        end: word.start + (i + 1) / text.length * (word.end - word.start),
        confidence: Number.isFinite(word.confidence) ? word.confidence : 0.8});
    });
  }
  return {text: chars.join(''), times};
}

function editDistance(a, b) {
  let previous = Uint16Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = new Uint16Array(b.length + 1); row[0] = i;
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1,
      previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length];
}

// Find candidate spans, then select the best monotonically ordered chain over
// the entire script. This avoids greedily assigning repeated phrases to a take.
function alignSegments(lines, words, duration, featureBuffer) {
  const timeline = wordTimeline(words, duration);
  const records = [], counts = new Map();
  lines.forEach(line => { const text = normalizeText(line.text); if (text) counts.set(text, (counts.get(text) || 0) + 1); });
  const tree = new Array(timeline.text.length + 2).fill(null);
  const query = position => {
    let best = null;
    for (let i = position + 1; i > 0; i -= i & -i) if (tree[i] && (!best || tree[i].score > best.score)) best = tree[i];
    return best;
  };
  const update = (position, node) => {
    for (let i = position + 1; i < tree.length; i += i & -i) if (!tree[i] || node.score > tree[i].score) tree[i] = node;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], text = normalizeText(line.text);
    const candidates = [];
    if (line.type !== 'direction' && text && text.length <= 512) {
      for (let from = 0, n = 0; n < 32; n++) {
        const start = timeline.text.indexOf(text, from);
        if (start < 0) break;
        candidates.push({start, end: start + text.length, similarity: 1}); from = start + 1;
      }
      if (!candidates.length && text.length >= 6) {
        const starts = new Set();
        for (const offset of [0, Math.floor(text.length / 2), Math.max(0, text.length - 4)]) {
          const seed = text.slice(offset, offset + 3);
          for (let from = 0, n = 0; n < 16; n++) {
            const found = timeline.text.indexOf(seed, from);
            if (found < 0) break;
            starts.add(Math.max(0, found - offset)); from = found + 1;
          }
        }
        for (const start of starts) {
          let best = null;
          const slack = Math.min(8, Math.ceil(text.length * 0.2));
          for (let length = Math.max(1, text.length - slack); length <= text.length + slack && start + length <= timeline.text.length; length++) {
            const similarity = 1 - editDistance(text, timeline.text.slice(start, start + length)) / Math.max(length, text.length);
            if (similarity >= 0.72 && (!best || similarity > best.similarity)) best = {start, end: start + length, similarity};
          }
          if (best) candidates.push(best);
        }
      }
    }
    const nodes = candidates.map(candidate => {
      const previous = query(candidate.start);
      return {...candidate, index, previous, score: (previous?.score || 0) + text.length * candidate.similarity ** 2};
    });
    nodes.forEach(node => update(node.end, node));
    records.push({lineId: line.id, textHash: hashText(line), start: null, end: null, confidence: 0,
      status: line.type === 'direction' ? 'direction' : 'unmatched'});
  }
  let selected = query(timeline.text.length), chain = [];
  while (selected) { chain.push(selected); selected = selected.previous; }
  chain.reverse();
  const reference = featureBuffer ? decodeFeatures(featureBuffer) : null;
  chain.forEach((node, n) => {
    const first = timeline.times[node.start], last = timeline.times[node.end - 1];
    if (!first || !last) return;
    const text = normalizeText(lines[node.index].text);
    let confidence = node.similarity * Math.min(1, timeline.times.slice(node.start, node.end)
      .reduce((sum, word) => sum + word.confidence, 0) / (node.end - node.start) + 0.1);
    const contextual = (chain[n - 1] && node.index - chain[n - 1].index <= 3) ||
      (chain[n + 1] && chain[n + 1].index - node.index <= 3);
    if (counts.get(text) > 1 && !contextual) confidence = Math.min(confidence, 0.65);
    let start = first.start, end = last.end;
    if (reference) {
      const rmsAt = seconds => reference.matrix[Math.max(0, Math.min(reference.count - 1, Math.floor(seconds * 1000 / FRAME_MS))) * (DIMENSIONS + 1) + DIMENSIONS] || 0;
      // Expand only into nearby voiced material. Do not assume every cue has a pause.
      while (start > Math.max(0, first.start - 0.12) && rmsAt(start - 0.04) > 0.001) start -= 0.04;
      while (end < Math.min(duration, last.end + 0.12) && rmsAt(end + 0.04) > 0.001) end += 0.04;
    }
    records[node.index] = {...records[node.index], start: Math.max(0, Math.round(start * 1000) / 1000),
      end: Math.min(duration, Math.round(end * 1000) / 1000), confidence: Math.round(confidence * 1000) / 1000,
      status: confidence >= 0.86 && node.similarity === 1 ? 'auto' : 'review'};
  });
  return records;
}

function validateSegmentEdit(recording, line, body) {
  const start = Number(body.start), end = Number(body.end);
  if (!line) throw new Error('這格字幕已不存在');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > recording.duration || end - start < 0.12)
    throw new Error('片段須至少 0.12 秒，起點與終點必須位於錄音範圍內');
  return {lineId: line.id, textHash: hashText(line), start, end, confidence: 1,
    status: line.type === 'direction' ? 'direction' : 'manual'};
}

module.exports = {MAX_DURATION, MAX_FILE_BYTES, MAX_RECORDINGS, hashText, isUsableSegment,
  normalizeRecordings, recordingLines, refreshMappings, validSegments, publicRecording, alignSegments, validateSegmentEdit};
