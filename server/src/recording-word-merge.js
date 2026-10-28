const {normalizeText} = require('./auto-follow');
const {toAnalysis} = require('./recording-timing');
const CHUNK_SECONDS = 300;
const middle = word => (word.start + word.end) / 2;
const round = value => Math.round(value * 1000000) / 1000000;
const requestIdFor = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : undefined;

function wordIssuesFor(value = [], maximum = 20000) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('辨識異常詞紀錄格式錯誤');
  return value.map(issue => {
    if (!issue || !Number.isSafeInteger(issue.wordIndex) || issue.wordIndex < 0 || issue.wordIndex >= 20000 ||
      typeof issue.word !== 'string' || issue.word.length > 512 ||
      ![issue.start, issue.end].every(time => time === null || Number.isFinite(time)) ||
      !['previous', 'core', 'next'].includes(issue.zone) || typeof issue.reason !== 'string' || issue.reason.length > 100)
      throw new Error('辨識異常詞紀錄格式錯誤');
    return {wordIndex: issue.wordIndex, word: issue.word, start: issue.start, end: issue.end, reason: issue.reason, zone: issue.zone};
  });
}

// Align equal tokens one-to-one in the shared four-second window. Time and
// sequence constraints preserve legitimate repeated words within either batch.
function overlapPairs(left, right) {
  if (left.length > 256 || right.length > 256) {
    for (const entry of [...left, ...right]) entry.word.timingUncertain = true;
    return [];
  }
  const width = right.length + 1, scores = new Float64Array((left.length + 1) * width);
  const weight = (a, b) => {
    const delta = Math.abs(middle(a.word) - middle(b.word));
    if (!a.text || a.text !== b.text || delta > 2 ||
      (Math.min(a.word.end, b.word.end) < Math.max(a.word.start, b.word.start) - .05 && delta > .4)) return 0;
    return 2 + Math.min(8, a.text.length) - delta * .4;
  };
  for (let i = 1; i <= left.length; i++) for (let j = 1; j <= right.length; j++) {
    const match = weight(left[i - 1], right[j - 1]);
    scores[i * width + j] = Math.max(scores[(i - 1) * width + j], scores[i * width + j - 1],
      match ? scores[(i - 1) * width + j - 1] + match : 0);
  }
  const pairs = [];
  for (let i = left.length, j = right.length; i && j;) {
    const match = weight(left[i - 1], right[j - 1]);
    if (match && Math.abs(scores[i * width + j] - scores[(i - 1) * width + j - 1] - match) < 1e-8) {
      pairs.push([left[--i].id, right[--j].id]);
    } else if (scores[(i - 1) * width + j] >= scores[i * width + j - 1]) i--;
    else j--;
  }
  return pairs;
}

function issueWindow(issue, duration) {
  const from = Math.max(0, issue.chunkIndex * CHUNK_SECONDS - 2);
  const coreStart = issue.chunkIndex * CHUNK_SECONDS, coreEnd = Math.min(duration, coreStart + CHUNK_SECONDS);
  if (Number.isFinite(issue.start) && from + issue.start >= 0 && from + issue.start <= duration) {
    const start = from + issue.start;
    const end = Number.isFinite(issue.end) && issue.end >= issue.start ? Math.min(duration, from + issue.end) : start;
    return {start: Math.max(0, start - .5), end: Math.min(duration, Math.max(start + 2, Math.min(start + 10, end)) + .5)};
  }
  if (issue.zone !== 'core') {
    const edge = issue.zone === 'next' ? coreEnd : coreStart;
    return {start: Math.max(0, edge - 2), end: Math.min(duration, edge + 4)};
  }
  return {start: coreStart, end: coreEnd};
}

function resolveWordIssues(issues, entries, duration) {
  const ends = new Float64Array(entries.length);
  for (let i = 0; i < entries.length; i++) ends[i] = Math.max(i ? ends[i - 1] : 0, entries[i].word.end);
  const lowerBound = (target, getter) => {
    let low = 0, high = entries.length;
    while (low < high) { const mid = (low + high) >>> 1; if (getter(mid) < target) low = mid + 1; else high = mid; }
    return low;
  };
  return issues.map(issue => {
    const window = issueWindow(issue, duration), text = normalizeText(issue.word);
    const low = lowerBound(window.start, index => ends[index]);
    const high = lowerBound(window.end + 1e-6, index => entries[index].word.start);
    const nearby = high - low <= 256 ? entries.slice(low, high) : [];
    const expectedStart = Number.isFinite(issue.start) ? Math.max(0, issue.chunkIndex * CHUNK_SECONDS - 2) + issue.start : null;
    let recoveredBy;
    if (text) for (let first = 0; first < nearby.length && !recoveredBy; first++) {
      if (expectedStart !== null && Math.abs(nearby[first].word.start - expectedStart) > 1) continue;
      let heard = '';
      for (let last = first; last < Math.min(nearby.length, first + 16); last++) {
        heard += nearby[last].text;
        if (heard.length > text.length) break;
        const sources = nearby.slice(first, last + 1).flatMap(entry => entry.sources);
        if (heard === text && sources.every(index => issue.zone === 'next' ? index === issue.chunkIndex + 1
          : issue.zone === 'previous' ? index === issue.chunkIndex - 1 : Math.abs(index - issue.chunkIndex) === 1)) {
          recoveredBy = [...new Set(sources)]; break;
        }
      }
    }
    return {...issue, status: recoveredBy ? 'recovered' : 'review', reviewStart: round(window.start), reviewEnd: round(window.end),
      ...(recoveredBy ? {recoveredBy} : {})};
  });
}

function mergeChunkWords(chunks, duration) {
  const entries = [], byChunk = new Map(), issues = [];
  for (const chunk of chunks) {
    const local = chunk.analysis.words.map(word => {
      const entry = {id: entries.length, chunkIndex: chunk.index, word: {...word}, text: normalizeText(word.word)};
      entries.push(entry); return entry;
    }).sort((a, b) => a.word.start - b.word.start || a.id - b.id);
    byChunk.set(chunk.index, local);
    for (const issue of wordIssuesFor(chunk.analysis.wordIssues)) issues.push({...issue, chunkIndex: chunk.index,
      ...(requestIdFor(chunk.analysis.requestId) ? {requestId: chunk.analysis.requestId} : {})});
  }
  const parents = entries.map(entry => entry.id);
  const root = id => { while (parents[id] !== id) { parents[id] = parents[parents[id]]; id = parents[id]; } return id; };
  for (let index = 1; index < chunks.length; index++) {
    const boundary = chunks[index].index * CHUNK_SECONDS;
    const inOverlap = entry => entry.word.end >= boundary - 2 && entry.word.start <= boundary + 2;
    const left = (byChunk.get(chunks[index].index - 1) || []).filter(inOverlap);
    const right = (byChunk.get(chunks[index].index) || []).filter(inOverlap);
    for (const [a, b] of overlapPairs(left, right)) parents[root(b)] = root(a);
  }
  const groups = new Map();
  for (const entry of entries) { const id = root(entry.id); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(entry); }
  const owner = entry => Math.min(Math.ceil(duration / CHUNK_SECONDS) - 1, Math.floor(middle(entry.word) / CHUNK_SECONDS));
  const score = entry => (entry.word.timingUncertain || entry.word.start === entry.word.end ? 0 : 100) +
    (owner(entry) === entry.chunkIndex ? 10 : 0) + (entry.word.confidence || 0);
  const selected = [...groups.values()].map(group => {
    group.sort((a, b) => score(b) - score(a) || a.id - b.id);
    const chosen = group[0], word = {...chosen.word};
    if (owner(chosen) !== chosen.chunkIndex) word.timingUncertain = true;
    return {...chosen, word, sources: [...new Set(group.map(entry => entry.chunkIndex))]};
  }).sort((a, b) => a.word.start - b.word.start || a.id - b.id);
  for (let i = 1; i < selected.length; i++) {
    const a = selected[i - 1], b = selected[i];
    if (a.chunkIndex !== b.chunkIndex && a.text !== b.text && a.word.end - b.word.start > .08) {
      a.word.timingUncertain = true; b.word.timingUncertain = true;
    }
  }
  return {words: selected.map(entry => ({...entry.word, sourceChunk: entry.chunkIndex})), wordIssues: resolveWordIssues(issues, selected, duration)};
}

function restoreWordIssues(value = [], words, duration) {
  if (!Array.isArray(value) || value.length > 1000000) throw new Error('備份異常詞紀錄格式錯誤');
  const issues = value.map(issue => {
    if (!Number.isInteger(issue?.chunkIndex) || issue.chunkIndex < 0 || issue.chunkIndex >= Math.ceil(duration / CHUNK_SECONDS))
      throw new Error('備份異常詞批次錯誤');
    return {...wordIssuesFor([issue])[0], chunkIndex: issue.chunkIndex,
      ...(requestIdFor(issue.requestId) ? {requestId: issue.requestId} : {})};
  });
  const ordered = words.map(word => ({word, text: normalizeText(word.word),
    sources: [Number.isInteger(word.sourceChunk) ? word.sourceChunk
      : Math.min(Math.ceil(duration / CHUNK_SECONDS) - 1, Math.floor(middle(word) / CHUNK_SECONDS))]}))
    .sort((a, b) => a.word.start - b.word.start);
  return resolveWordIssues(issues, ordered, duration);
}

function reviewWordIssues(segments, issues = [], correction) {
  const pending = issues.filter(issue => issue.status !== 'recovered');
  if (!pending.length) return segments;
  return segments.map(segment => {
    if (!['auto', 'review'].includes(segment.status) || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)) return segment;
    const start = toAnalysis(segment.start, correction), end = toAnalysis(segment.end, correction);
    if (!pending.some(issue => end >= issue.reviewStart && start <= issue.reviewEnd)) return segment;
    const reason = '附近有尚未補回的辨識詞時間，請試聽核對';
    return {...segment, status: 'review', reviewReason: [...new Set([segment.reviewReason, reason].filter(Boolean))].join('；')};
  });
}
module.exports = {wordIssuesFor, mergeChunkWords, restoreWordIssues, reviewWordIssues, requestIdFor};
