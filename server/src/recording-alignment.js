const crypto = require('node:crypto');
const {normalizeText} = require('./auto-follow');
const {decodeFeatures, FRAME_MS, DIMENSIONS} = require('./acoustic-follow');
const {timedWords, toAnalysis} = require('./recording-timing');
const hashText = line => crypto.createHash('sha256').update(`${line?.type || 'dialogue'}\n${line?.text || ''}`).digest('hex').slice(0, 24);
const round = value => Math.round(value * 1000) / 1000;

function wordTimeline(words, duration, correction) {
  const units = [], records = timedWords(words, duration, correction);
  for (const word of records) {
    // String search and model character offsets both use UTF-16 indices.
    const text = normalizeText(word.word).split('');
    for (let char = 0; char < text.length; char++) units.push({char: text[char], wordId: word.id, offset: char,
      start: word.start + char / text.length * (word.end - word.start),
      end: word.start + (char + 1) / text.length * (word.end - word.start),
      rawStart: word.rawStart + char / text.length * (word.rawEnd - word.rawStart),
      rawEnd: word.rawStart + (char + 1) / text.length * (word.rawEnd - word.rawStart), confidence: word.confidence,
      timingUncertain: word.timingUncertain === true});
  }
  return {text: units.map(unit => unit.char).join(''), units, words: records};
}
function lowerBound(values, target, field = 'start') {
  let low = 0, high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (values[middle][field] < target) low = middle + 1; else high = middle; }
  return low;
}
function editDistance(a, b, limit = Math.max(a.length, b.length)) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Uint16Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = new Uint16Array(b.length + 1).fill(limit + 1); row[0] = i;
    let minimum = limit + 1;
    for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      minimum = Math.min(minimum, row[j]);
    }
    if (minimum > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length];
}
function samplePositions(positions, maximum) {
  if (positions.length <= maximum) return positions;
  return Array.from({length: maximum}, (_, i) => positions[Math.round(i * (positions.length - 1) / (maximum - 1))]);
}
function spanCandidate(timeline, start, end, similarity) {
  const first = timeline.units[start], last = timeline.units[end - 1];
  if (!first || !last || last.end <= first.start || last.end - first.start > Math.max(20, (end - start) * 1.3)) return null;
  let gap = 0, confidence = 0;
  for (let i = start; i < end; i++) {
    confidence += timeline.units[i].confidence;
    if (i > start) gap = Math.max(gap, timeline.units[i].start - timeline.units[i - 1].end);
  }
  return {start, end, similarity, gap, confidence: confidence / (end - start),
    seconds: first.start, endSeconds: last.end};
}
function exactCandidates(timeline, text, low = 0, high = timeline.text.length) {
  const positions = [];
  for (let from = low; from < high;) {
    const found = timeline.text.indexOf(text, from);
    if (found < 0 || found + text.length > high) break;
    positions.push(found); from = found + 1;
  }
  return samplePositions(positions, 64).map(start => spanCandidate(timeline, start, start + text.length, 1)).filter(Boolean);
}
function createSeeds(text) {
  const map = new Map();
  for (let i = 0; i < text.length; i++) for (const size of [1, 2]) {
    if (i + size > text.length) continue;
    const key = text.slice(i, i + size);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(i);
  }
  return map;
}
function fuzzyCandidates(timeline, text, seeds, low, high) {
  if (text.length < 2 || high <= low) return [];
  const minimum = text.length <= 4 ? 0.5 : text.length <= 8 ? 0.6 : 0.7;
  const slack = Math.min(8, Math.max(2, Math.ceil(text.length * 0.2)));
  const terms = [];
  const seedSize = text.length <= 4 ? 1 : 2;
  for (let offset = 0; offset <= text.length - seedSize; offset++) {
    const all = seeds.get(text.slice(offset, offset + seedSize)) || [];
    const positions = all.filter(position => position >= low && position < high);
    if (positions.length) terms.push({offset, positions});
  }
  terms.sort((a, b) => a.positions.length - b.positions.length);
  const starts = new Map();
  for (const term of terms.slice(0, 5)) for (const found of samplePositions(term.positions, 96)) {
    for (let shift = -Math.min(slack, 2); shift <= Math.min(slack, 2); shift++) {
      const start = found - term.offset + shift;
      if (start >= low && start < high) starts.set(start, (starts.get(start) || 0) + (shift ? 0.5 : 1));
    }
  }
  const selected = [...starts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 180);
  const candidates = [];
  for (const [start] of selected) {
    let best = null;
    for (let length = Math.max(1, text.length - slack); length <= text.length + slack && start + length <= high; length++) {
      const limit = Math.floor((1 - minimum) * Math.max(length, text.length) + 1e-7);
      const distance = editDistance(text, timeline.text.slice(start, start + length), limit);
      const similarity = 1 - distance / Math.max(length, text.length);
      if (similarity < minimum || (best && (similarity < best.similarity ||
        (similarity === best.similarity && Math.abs(length - text.length) >= Math.abs(best.end - best.start - text.length))))) continue;
      const span = spanCandidate(timeline, start, start + length, similarity);
      if (span) best = span;
    }
    if (best) candidates.push(best);
  }
  return candidates;
}
function bestChain(entries, forced = new Map()) {
  let beam = [{score: 0, end: 0, index: -1, node: null}];
  for (let index = 0; index < entries.length; index++) {
    const candidates = forced.has(index) ? [forced.get(index)] : entries[index];
    const next = forced.has(index) ? [] : [...beam];
    for (const candidate of candidates) {
      let best = null;
      for (const previous of beam) {
        if (previous.end > candidate.start) continue;
        const skippedChars = Math.max(0, candidate.start - previous.end - 80);
        const skippedSeconds = previous.node ? Math.max(0, candidate.seconds - previous.node.endSeconds - 12) : 0;
        const penalty = previous.node ? Math.min(candidate.weight * 0.35, 6, skippedChars * 0.006 + skippedSeconds * 0.015) : 0;
        const score = previous.score + candidate.weight * candidate.similarity ** 2 - penalty;
        if (!best || score > best.score) best = {score, end: candidate.end, index,
          node: {...candidate, index, previous: previous.node}};
      }
      if (best) next.push(best);
    }
    const byEnd = new Map();
    for (const value of next) if (!byEnd.has(value.end) || value.score > byEnd.get(value.end).score) byEnd.set(value.end, value);
    beam = [...byEnd.values()].sort((a, b) => b.score - a.score || a.end - b.end).slice(0, 64);
    if (!beam.length) beam = [{score: 0, end: 0, index: -1, node: null}];
  }
  const result = new Map();
  for (let node = beam[0]?.node; node; node = node.previous) result.set(node.index, node);
  return result;
}
function segmentFromCandidate(line, candidate, timeline, {reference, correction, refine = true, duration, previousEnd = 0, nextStart = duration} = {}) {
  const first = timeline.units[candidate.start], last = timeline.units[candidate.end - 1];
  let start = first.start, end = last.end;
  if (reference && refine) {
    const rms = seconds => reference.matrix[Math.max(0, Math.min(reference.count - 1,
      Math.floor(toAnalysis(seconds, correction) * 1000 / FRAME_MS))) * (DIMENSIONS + 1) + DIMENSIONS] || 0;
    for (let step = 1; step <= 3; step++) {
      const value = first.start - step * 0.04;
      if (value < Math.max(previousEnd, 0) || rms(value) <= 0.001) break;
      start = value;
    }
    for (let step = 1; step <= 3; step++) {
      const value = last.end + step * 0.04;
      if (value > Math.min(nextStart, duration) || rms(value) <= 0.001) break;
      end = value;
    }
  }
  const reasons = [];
  if (candidate.similarity < 1) reasons.push('辨識與台詞有字詞差異，請核對整句');
  if (candidate.gap > 3) reasons.push('片段中有長停頓，請確認沒有跨過其他台詞');
  if (candidate.ambiguous) reasons.push('錄音中有相似或重複台詞，需要確認採用的位置');
  if (candidate.confidence < 0.76) reasons.push('語音辨識信心偏低');
  if (timeline.units.slice(candidate.start, candidate.end).some(unit => unit.timingUncertain))
    reasons.push('部分辨識詞缺少可靠的時間範圍，請試聽確認切點');
  if (first.offset || (last.offset + 1 < normalizeText(timeline.words.find(word => word.id === last.wordId)?.word || '').length))
    reasons.push('切點位於辨識詞內，逐字時間為估計值');
  const confidence = Math.min(candidate.ambiguous ? 0.65 : 1, candidate.similarity * Math.min(1, candidate.confidence + 0.1));
  return {lineId: line.id, textHash: hashText(line), start: round(Math.max(0, start)), end: round(Math.min(duration, end)),
    rawStart: first.rawStart, rawEnd: last.rawEnd, wordStart: first.wordId, wordEnd: last.wordId,
    startChar: first.offset, endChar: last.offset + 1, matchedText: timeline.text.slice(candidate.start, candidate.end),
    similarity: round(candidate.similarity), confidence: round(confidence), source: 'text',
    reviewReason: reasons.join('；'), status: !reasons.length && confidence >= 0.86 ? 'auto' : 'review'};
}

function alignSegments(lines, words, duration, featureBuffer, options = {}) {
  const timeline = wordTimeline(words, options.analysisDuration || duration, options.timeCalibration);
  const previous = new Map((options.previousSegments || []).map(segment => [segment.lineId, segment]));
  const scope = options.lineIds ? new Set(options.lineIds) : null;
  const texts = lines.map(line => line.type === 'direction' ? '' : normalizeText(line.text));
  const anchors = new Map(), kept = new Map();
  const inBounds = candidate => candidate.seconds >= 0 && candidate.endSeconds <= duration + 0.001;
  for (let index = 0; index < lines.length; index++) {
    const segment = previous.get(lines[index].id);
    if (segment && scope && !scope.has(lines[index].id)) kept.set(index, segment);
    if (!segment || segment.textHash !== hashText(lines[index])) continue;
    if (segment.status === 'manual' || (scope && !scope.has(lines[index].id))) {
      kept.set(index, segment);
      if (['manual', 'auto'].includes(segment.status) && Number.isFinite(segment.start) && Number.isFinite(segment.end)) {
        const start = lowerBound(timeline.units, segment.start), end = lowerBound(timeline.units, segment.end);
        anchors.set(index, {start, end: Math.max(start, end), seconds: segment.start, endSeconds: segment.end,
          similarity: 1, confidence: 1, weight: 1000});
      }
    }
  }
  const boundaries = index => {
    let low = 0, high = timeline.text.length;
    for (const [i, anchor] of anchors) { if (i < index) low = Math.max(low, anchor.end); if (i > index) high = Math.min(high, anchor.start); }
    return {low, high};
  };
  const exact = texts.map((text, index) => {
    if (!text || text.length > 512 || kept.has(index) || (scope && !scope.has(lines[index].id))) return [];
    const {low, high} = boundaries(index);
    return exactCandidates(timeline, text, low, high).filter(inBounds).map(candidate => ({...candidate, weight: text.length}));
  });
  // Establish distinctive full-line anchors first. Repeated lines never become
  // anchors merely because one occurrence happened to be visited first.
  const distinctive = exact.map((candidates, index) => texts[index].length >= 6 && candidates.length === 1 &&
    candidates[0].confidence >= 0.76 && candidates[0].gap <= 3
    ? [{...candidates[0], weight: 24}] : []);
  const selectedAnchors = bestChain(distinctive, anchors);
  for (const [index, candidate] of selectedAnchors) if (distinctive[index]?.length && [...selectedAnchors].some(([other, value]) =>
    other !== index && Math.abs(other - index) <= 3 && Math.abs(value.seconds - candidate.seconds) <= 180)) anchors.set(index, candidate);
  const seeds = createSeeds(timeline.text);
  const entries = texts.map((text, index) => {
    if (!text || text.length > 512 || kept.has(index) || (scope && !scope.has(lines[index].id))) return [];
    if (anchors.has(index)) return [anchors.get(index)];
    const {low, high} = boundaries(index);
    const all = [...exact[index].filter(candidate => candidate.start >= low && candidate.end <= high),
      ...fuzzyCandidates(timeline, text, seeds, low, high).filter(inBounds).map(candidate => ({...candidate, weight: text.length}))];
    const unique = new Map();
    for (const candidate of all) {
      const key = `${candidate.start}:${candidate.end}`;
      if (!unique.has(key) || candidate.similarity > unique.get(key).similarity) unique.set(key, candidate);
    }
    return [...unique.values()].sort((a, b) => b.similarity - a.similarity || a.start - b.start).slice(0, 64);
  });
  const selected = bestChain(entries, anchors);
  const reference = featureBuffer ? decodeFeatures(featureBuffer) : null;
  return lines.map((line, index) => {
    if (kept.has(index)) return kept.get(index);
    const candidate = selected.get(index);
    const base = {lineId: line.id, textHash: hashText(line), start: null, end: null, confidence: 0,
      status: line.type === 'direction' ? 'direction' : 'unmatched', reviewReason: line.type === 'direction' ? '' : '未找到可靠的台詞範圍'};
    if (!candidate || !texts[index]) return base;
    const rivals = entries[index].filter(other => other.similarity >= candidate.similarity - 0.18 &&
      Math.abs(other.seconds - candidate.seconds) > Math.max(2, candidate.endSeconds - candidate.seconds));
    const alternatives = entries[index].filter(other => other.start !== candidate.start).slice(0, 3).map(other => ({
      wordStart: timeline.units[other.start].wordId, wordEnd: timeline.units[other.end - 1].wordId,
      start: round(other.seconds), end: round(other.endSeconds), similarity: round(other.similarity)}));
    const before = selected.get(index - 1), after = selected.get(index + 1);
    const segment = segmentFromCandidate(line, {...candidate, ambiguous: rivals.length > 0}, timeline,
      {reference, correction: options.featureCalibration,
        // Do not pad an operator-calibrated word boundary away from its anchor.
        refine: !options.timeCalibration || (options.timeCalibration.scale === 1 && options.timeCalibration.offset === 0),
        duration, previousEnd: before?.endSeconds || 0, nextStart: after?.seconds ?? duration});
    return {...segment, alternatives};
  });
}
module.exports = {alignSegments, hashText, wordTimeline, editDistance, lowerBound, spanCandidate, segmentFromCandidate};
