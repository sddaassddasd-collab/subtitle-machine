// Script following is independent of ASR segment boundaries and display state.
// Times are milliseconds on the provider's audio clock, never arrival wall time.
const {normalizeText} = require('./follow-text');
const {alignedWords, freshSpeech, suffixSpeech, wordWindows} = require('./word-evidence');
const {TEXT_SETTINGS: T, ONSET_SETTINGS: O, SEMANTIC_SETTINGS: S} = require('./follow-settings');
const {pinyin} = require('pinyin-pro');
const {observeScriptPath, observeWeakScriptPath, observeWordPath, isCurrentSuffix} = require('./script-path');
const {prepareOpening, matchOpening, observeOpening} = require('./sequential-opening');
const MAX_HEARD = T.maxHeard;
const SEQUENCE_TTL_MS = T.sequenceTtlMs;
const DIRECTION_SILENCE_MS = O.directionSilenceMs;

function createCorrection() {
  return { pending: null, candidates: [], lastScanMs: -Infinity, status: 'searching' };
}

// Reuse immutable analysis even when the server recreates its public line array.
// Checking source fields is cheap; Unicode conversion and indexing only run for
// a changed script, never for an audio packet.
function prepareScript(lines, previous) {
  if (previous && previous.entries.length === lines.length && lines.every((line, i) => {
    const source = previous.entries[i].source;
    return source.text === line.text && source.type === line.type &&
      source.music === line.music && source.role === line.role;
  })) return previous;
  const chars = [], positions = [], starts = [];
  const exactLines = new Map();
  const entries = lines.map((line, index) => {
    const text = line.type === 'direction' ? '' : normalizeText(line.text);
    const letters = Array.from(text);
    if (text) {
      if (!exactLines.has(text)) exactLines.set(text, []);
      exactLines.get(text).push(index);
    }
    starts.push(chars.length);
    letters.forEach((char, offset) => {
      chars.push(char);
      positions.push({ index, offset: offset + 1, length: letters.length });
    });
    return {
      source: { text: line.text, type: line.type, music: line.music, role: line.role },
      text, opening: letters.slice(0, 12).join(''), tail: letters.slice(-3).join(''),
      length: letters.length, next: null,
    };
  });
  starts.push(chars.length);
  let next = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    entries[i].next = next;
    if (entries[i].text) next = i;
  }
  const phones = pinyin(chars.join(''), {toneType: 'none', type: 'array', nonZh: 'consecutive'});
  // Preserve one token per character even for Latin text and digits.
  const phonemes = phones.length === chars.length ? phones : chars.map(char => pinyin(char, {toneType: 'none'}));
  const bigrams = new Map();
  for (let i = 0; i + 1 < chars.length; i++) {
    const gram = chars[i] + chars[i + 1];
    if (!bigrams.has(gram)) bigrams.set(gram, new Set());
    bigrams.get(gram).add(positions[i + 1].index);
  }
  return { entries, chars, phonemes, bigrams, positions, starts, exactLines };
}


function createTracker({ ignoreBeforeMs = -1 } = {}) {
  return {
    streamId: null, ignoreBeforeMs, latestStartMs: -1, latestOrder: -1, items: new Map(),
    progressIndex: null, progress: 0, armedIndex: null, armedAtMs: null,
    sequence: null, correction: createCorrection(), quietMs: 0, loudMs: 0, released: false,
    noiseFloor: 0.004, lastOnsetMs: -1,
    script: null, located: false, candidates: [], preparedIndex: null,
    anchor: null, openingHint: '', prediction: null, directionWait: null,
    directionSpeechStartedMs: null,
    referenceFence: null,
    referenceProgress: null,
    lastLocated: null,
    textAnchor: null,
    path: {hypotheses: [], lastMs: -1},
    weakPath: {hypotheses: [], lastMs: -1},
    wordPath: {hypotheses: []},
    shortOpenings: false, openingPlan: null, selectedStartIndex: null,
    captureRecovery: null,
  };
}

// Semi-global edit alignment: all heard characters must be accounted for;
// the script may have an unheard prefix/suffix. Keep the order of characters.
function align(heard, lines, from, to, {local = false, phonetic = false} = {}) {
  const script = Array.isArray(lines) ? prepareScript(lines) : lines;
  const start = script.starts[Math.max(0, from)] ?? 0;
  const end = script.starts[Math.min(script.entries.length, to + 1)] ?? start;
  const text = script.chars.slice(start, end);
  const positions = script.positions.slice(start, end);
  const input = Array.from(heard).slice(-MAX_HEARD);
  const inputPhones = phonetic ? input.map(char => pinyin(char, {toneType: 'none'})) : null;
  if (!input.length || !text.length) return [];
  let previous = new Float64Array(text.length + 1);
  let current = new Float64Array(text.length + 1);
  let previousMatches = local ? new Uint16Array(text.length + 1) : null;
  let currentMatches = local ? new Uint16Array(text.length + 1) : null;
  let previousPhones = phonetic ? new Uint16Array(text.length + 1) : null;
  let currentPhones = phonetic ? new Uint16Array(text.length + 1) : null;
  for (let i = 1; i <= input.length; i += 1) {
    const insertionCost = local && T.localFillers.includes(input[i - 1]) ? T.localInsertionCost : 1;
    current[0] = previous[0] + insertionCost;
    for (let j = 1; j <= text.length; j += 1) {
      const exact = input[i - 1] === text[j - 1];
      const samePhone = phonetic && /\p{Script=Han}/u.test(input[i - 1]) &&
        /\p{Script=Han}/u.test(text[j - 1]) && inputPhones[i - 1] === script.phonemes[start + j - 1];
      const diagonal = previous[j - 1] + (exact ? 0 : samePhone ? T.phoneticCost : 1);
      const insertion = previous[j] + insertionCost, deletion = current[j - 1] + 1;
      current[j] = Math.min(diagonal, insertion, deletion);
      if (local) currentMatches[j] = diagonal <= insertion && diagonal <= deletion
        ? previousMatches[j - 1] + Number(exact) : insertion <= deletion ? previousMatches[j] : currentMatches[j - 1];
      if (phonetic) currentPhones[j] = diagonal <= insertion && diagonal <= deletion
        ? previousPhones[j - 1] + Number(!exact && samePhone) : insertion <= deletion ? previousPhones[j] : currentPhones[j - 1];
    }
    [previous, current] = [current, previous];
    if (local) { [previousMatches, currentMatches] = [currentMatches, previousMatches]; currentMatches[0] = 0; }
    if (phonetic) { [previousPhones, currentPhones] = [currentPhones, previousPhones]; currentPhones[0] = 0; }
  }
  const byLine = new Map();
  for (let j = 1; j <= text.length; j += 1) {
    // Do not report progress through a suffix that has not actually been heard.
    if (text[j - 1] !== input[input.length - 1] &&
      !(phonetic && inputPhones.at(-1) === script.phonemes[start + j - 1])) continue;
    const position = positions[j - 1];
    const confidence = Math.max(0, 1 - previous[j] / input.length);
    const candidate = { ...position, confidence, evidence: input.length, heard,
      ...(local ? {matchedCharacters: previousMatches[j], colloquial: true} : {}),
      ...(phonetic ? {phonetic: true, phoneticMatches: previousPhones[j]} : {}) };
    const old = byLine.get(position.index);
    if (!old || confidence > old.confidence ||
      (confidence === old.confidence && position.offset < old.offset)) {
      byLine.set(position.index, candidate);
    }
  }
  return [...byLine.values()];
}

// Trace only an accepted, bounded match, not the entire script on each scan.
// Exact character pairs expose which intervening cues were actually heard;
// deleted script text must never be reported as spoken or displayed.
function traceAlignment(input, text, freePrefix = true) {
  const width = text.length + 1, path = new Uint8Array((input.length + 1) * width);
  let previous = Float64Array.from({length: width}, (_, j) => freePrefix ? 0 : j);
  let current = new Float64Array(width);
  for (let i = 1; i <= input.length; i++) {
    current[0] = i;
    for (let j = 1; j <= text.length; j++) {
      const diagonal = previous[j - 1] + (input[i - 1] === text[j - 1] ? 0 : 1);
      const insertion = previous[j] + 1, deletion = current[j - 1] + 1;
      const step = diagonal <= insertion && diagonal <= deletion ? 0 : insertion <= deletion ? 1 : 2;
      path[i * width + j] = step;
      current[j] = step === 0 ? diagonal : step === 1 ? insertion : deletion;
    }
    [previous, current] = [current, previous];
  }
  const pairs = [];
  let i = input.length, j = text.length;
  while (i > 0 && j > 0) {
    const step = path[i * width + j];
    if (step === 0) {
      if (input[i - 1] === text[j - 1]) pairs.push({input: i - 1, script: j - 1});
      i--; j--;
    } else if (step === 1) i--;
    else j--;
  }
  return {cost: previous[text.length], pairs: pairs.reverse()};
}

function matchedSpans(best, script) {
  if (best.confidence < T.strongConfidence || best.contextualShort || best.weakPath || best.locationOnly) return [];
  const input = Array.from(best.heard).slice(-MAX_HEARD);
  const end = script.starts[best.index] + best.offset;
  const start = Math.max(0, end - MAX_HEARD * 2);
  const {pairs} = traceAlignment(input, script.chars.slice(start, end));
  const groups = new Map();
  for (const pair of pairs) {
    const position = script.positions[start + pair.script];
    if (!groups.has(position.index)) groups.set(position.index, []);
    groups.get(position.index).push({...pair, offset: position.offset});
  }
  return [...groups].flatMap(([index, matches]) => {
    const entry = script.entries[index], first = matches[0], last = matches.at(-1);
    const coverage = matches.length / (last.offset - first.offset + 1);
    if (matches.length < Math.min(3, entry.length) || coverage < T.spanCoverage) return [];
    return [{index, offset: last.offset, length: entry.length, coverage,
      completed: first.offset === 1 && last.offset === entry.length && matches.length / entry.length >= T.spanCoverage,
      heard: input.slice(first.input, last.input + 1).join('')}];
  });
}

// One edit in a short, already located cue is useful evidence, even when an
// added particle changes the last character. Never use this for reacquisition.
function matchContextualShort(tracker, script, currentIndex, text, event, next = false) {
  const recent = tracker.sequence?.index === currentIndex && event.endMs >= tracker.sequence.atMs &&
    event.endMs - tracker.sequence.atMs <= SEQUENCE_TTL_MS;
  const predicted = tracker.prediction?.index === currentIndex && event.endMs >= tracker.prediction.onsetMs &&
    event.endMs - tracker.prediction.onsetMs <= SEQUENCE_TTL_MS;
  if (!recent && !predicted) return null;
  let index = currentIndex;
  if (next) {
    index++;
    if (!recent || script.entries[currentIndex]?.next !== index || script.entries[currentIndex].source.music ||
      script.entries[index]?.source.type === 'direction') return null;
    const speech = freshSpeech({...event, text}, tracker.sequence.observed.endMs);
    if (!speech) return null;
    text = normalizeText(speech.text);
  }
  const entry = script.entries[index], input = Array.from(text);
  if (!entry?.text || entry.source.music || entry.length < T.shortMinLength || entry.length > T.shortMaxLength ||
    Math.abs(input.length - entry.length) > 1) return null;
  const {cost, pairs} = traceAlignment(input, Array.from(entry.text), false);
  const missingShort = entry.length === T.shortMinLength && input.length === T.predictedShortMatchedCharacters &&
    !next && (predicted || recent) && pairs.length === input.length;
  if (cost !== T.shortMaxEdits || pairs.length < (missingShort ? T.predictedShortMatchedCharacters : T.shortMatchedCharacters)) return null;
  // A similar nearby phrase cannot be resolved by a one-edit allowance alone.
  for (let otherIndex = Math.max(0, currentIndex - T.nearbyBehind); otherIndex <= Math.min(script.entries.length - 1, currentIndex + T.nearbyAhead); otherIndex++) {
    if (otherIndex === index) continue;
    const other = script.entries[otherIndex];
    if (!other.text || Math.abs(other.length - input.length) > 1) continue;
    if (traceAlignment(input, Array.from(other.text), false).cost <= cost) return null;
  }
  const confidence = Math.max(missingShort ? T.contextualShortConfidence : 0, 1 - cost / Math.max(input.length, entry.length));
  return {index, offset: pairs.at(-1).script + 1, length: entry.length,
    confidence, rank: confidence, evidence: pairs.length, heard: text, contextualShort: true,
    ...(next ? {shortNext: true, locationOnly: true} : {})};
}

function canRecoverShort(tracker, script, currentIndex, best, event) {
  const anchor = tracker.textAnchor;
  return Boolean(anchor && currentIndex >= anchor.index && currentIndex <= anchor.index + 1 &&
    event.startMs >= anchor.atMs && event.endMs - anchor.atMs <= T.weakAnchorTtlMs &&
    best?.index > currentIndex + 1 && best.index <= currentIndex + T.recoveryAhead && best.confidence === 1 &&
    best.heard === normalizeText(event.text) && best.heard === script.entries[best.index].text &&
    best.evidence >= T.shortRecoveryEvidence && script.exactLines.get(best.heard)?.length === 1 &&
    !script.entries.slice(currentIndex, best.index + 1).some(e => e.source.music || e.source.type === 'direction'));
}

// Only a recently established local position permits filler/trailing-word
// tolerance. Full-script relocation keeps the strict, ordered edit distance.
function recoveryAnchor(tracker, currentIndex) {
  const confirmed = tracker.lastLocated;
  if (confirmed?.index === currentIndex) return confirmed;
  const prediction = tracker.prediction;
  // A pending onset is not a confirmation. It can, however, retain the
  // established path from the immediately preceding confirmed dialogue.
  if (confirmed?.index === currentIndex - 1 && prediction?.index === currentIndex &&
    prediction.fromIndex === confirmed.index && tracker.sequence?.index === currentIndex) {
    return {index: currentIndex, atMs: confirmed.atMs};
  }
  return null;
}

function canReacquireCapture(tracker, script, currentIndex, best, event) {
  const recovery = tracker.captureRecovery, text = normalizeText(event.text);
  if (!recovery || recovery.index !== currentIndex || event.endMs > T.captureRecoveryMs ||
    !best || best.index <= currentIndex || best.index > currentIndex + T.captureRecoveryAhead ||
    best.confidence < T.captureRecoveryConfidence || best.context || best.phonetic || best.weakPath ||
    text.length < T.captureRecoveryCharacters || !alignedWords(event).length ||
    !script.entries[best.index].text.endsWith(text) ||
    script.entries.slice(currentIndex, best.index + 1).some(e => e.source.music || e.source.type === 'direction')) return false;
  // The selected position survives recovery, but old audio evidence does not.
  // Reacquire only an isolated, distinctive literal suffix on the NEW clock.
  return script.entries.slice(Math.max(0, currentIndex - T.nearbyBehind), currentIndex + T.nearbyAhead + 1)
    .filter(e => e.text.includes(text)).length === 1;
}

function localCandidates(tracker, script, currentIndex, text, event) {
  const anchor = recoveryAnchor(tracker, currentIndex) || tracker.sequence;
  const predicted = tracker.prediction?.index === currentIndex && event.endMs >= tracker.prediction.onsetMs &&
    event.endMs - tracker.prediction.onsetMs <= SEQUENCE_TTL_MS;
  const fresh = anchor?.index === currentIndex && event.endMs >= (anchor.atMs ?? anchor.endMs) &&
    event.endMs - (anchor.atMs ?? anchor.endMs) <= T.recoveryTtlMs;
  if (!predicted && !fresh) return [];
  const ahead = fresh && event.endMs - (anchor.atMs ?? anchor.endMs) >= T.recoveryAfterMs ? T.recoveryAhead : T.catchUpAhead;
  const matches = [];
  for (let trailing = 0; trailing <= T.localTrailingCharacters; trailing++) {
    const heard = trailing ? text.slice(0, -trailing) : text;
    if (heard.length < T.localMinimumMatches) continue;
    for (const match of align(heard, script, currentIndex, Math.min(script.entries.length - 1, currentIndex + ahead), {local: true})) {
      if (match.matchedCharacters < T.localMinimumMatches || match.matchedCharacters / heard.length < T.localMatchedCoverage) continue;
      const confidence = match.confidence - trailing * T.localTrailingPenalty;
      if (confidence < T.minimumConfidence) continue;
      matches.push({...match, confidence, rank: confidence - (trailing ? T.recoveryPenalty : 0), trailingCharacters: trailing});
    }
  }
  return matches;
}

function canRecoverNearby(tracker, script, currentIndex, best, event, ambiguous) {
  const anchor = recoveryAnchor(tracker, currentIndex);
  return Boolean(anchor?.index === currentIndex && !ambiguous && best &&
    best.index > currentIndex + 1 && best.index <= currentIndex + T.recoveryAhead &&
    event.endMs - anchor.atMs >= T.recoveryAfterMs && event.endMs - anchor.atMs <= T.recoveryTtlMs &&
    event.startMs >= anchor.atMs && best.confidence >= T.recoveryMinimumConfidence &&
    (best.evidence >= T.recoveryMinimumEvidence || canRecoverShort(tracker, script, currentIndex, best, event)) &&
    !script.entries.slice(currentIndex, best.index + 1).some(entry => entry.source.music));
}

function clearPreparation(tracker) {
  tracker.armedIndex = null;
  tracker.preparedIndex = null;
  tracker.anchor = null;
  tracker.openingHint = '';
  tracker.directionWait = null;
}

function preparedOpeningText(tracker, currentIndex, text, event) {
  const index = tracker.preparedIndex;
  const anchor = tracker.anchor;
  if (!tracker.located || index !== currentIndex + 1 || !anchor ||
    event.endMs < anchor.endMs || event.endMs - anchor.endMs > SEQUENCE_TTL_MS) return null;
  let opening = text;
  if (event.itemId === anchor.itemId) {
    if (!anchor.completed || !text.startsWith(anchor.text)) return null;
    opening = text.slice(anchor.text.length);
  } else if (event.startMs < anchor.endMs) {
    return null;
  }
  return opening;
}

function matchPreparedOpening(tracker, script, currentIndex, text, event) {
  const opening = preparedOpeningText(tracker, currentIndex, text, event);
  if (!opening) return null;
  const index = tracker.preparedIndex;
  const anchor = tracker.anchor;
  const entry = script.entries[index];
  const evidence = Array.from(opening).length;
  // A near-ending preparation needs an intervening onset; a confirmed ending
  // can also transition through uninterrupted speech in the same ASR item.
  if ((!anchor.completed && tracker.lastOnsetMs < anchor.endMs) || evidence < 2 ||
    evidence > MAX_HEARD || (!anchor.completed && evidence > 12) || !entry.text.startsWith(opening)) return null;
  // Once the previous ending is verified, sequence supplies the missing context.
  // Reacquisition and near-ending guesses still need a distinctive opening.
  if (!anchor.completed) {
    const remaining = Array.from(script.entries[currentIndex].text)
      .slice(Math.floor(tracker.progress * script.entries[currentIndex].length)).join('');
    if (remaining.includes(opening)) return null;
    for (let i = Math.max(0, currentIndex - T.nearbyBehind); i <= Math.min(script.entries.length - 1, currentIndex + T.nearbyAhead); i++) {
      if (i !== index && script.entries[i].text.startsWith(opening)) return null;
    }
  }
  return {
    index, offset: evidence, length: entry.length, confidence: 1, rank: 1,
    evidence, heard: opening, openingConfirmed: true,
  };
}

function matchPredictedOpening(tracker, script, text, event) {
  const prediction = tracker.prediction;
  const waitingOnDirection = prediction?.source === 'silence';
  if (!prediction || event.endMs < prediction.onsetMs ||
    (!waitingOnDirection && event.endMs - prediction.onsetMs > SEQUENCE_TTL_MS)) return null;
  const opening = event.itemId === prediction.anchor.itemId && text.startsWith(prediction.anchor.text)
    ? text.slice(prediction.anchor.text.length) : text;
  // A direction can hold for an entire scene movement. Keep the next dialogue
  // available even after the normal onset prediction window has expired.
  const index = waitingOnDirection ? script.entries[prediction.index]?.next : prediction.index;
  const entry = script.entries[index];
  const evidence = Array.from(opening).length;
  const minimumEvidence = waitingOnDirection && event.isFinal && entry?.length === 1 ? 1 : 2;
  if (evidence < minimumEvidence || evidence > MAX_HEARD || !entry?.text.startsWith(opening)) return null;
  return { index, offset: evidence, length: entry.length,
    confidence: 1, rank: 1, evidence, heard: opening, openingConfirmed: true };
}

function rankCandidates(variants, lines, currentIndex, from, to, expectedIndex) {
  const candidates = new Map();
  for (const variant of variants) {
    for (const match of align(variant.text, lines, from, to)) {
      const contextBonus = variant.context && match.confidence >= T.contextConfidence ? T.contextBonus : 0;
      const expectationBonus = match.index === expectedIndex ? T.expectationBonus : 0;
      const rank = match.confidence + contextBonus + expectationBonus;
      const previous = candidates.get(match.index);
      if (!previous || rank > previous.rank) {
        candidates.set(match.index, { ...match, rank, context: variant.context });
      }
    }
  }
  return [...candidates.values()].sort((a, b) => b.rank - a.rank ||
    Math.abs(a.index - currentIndex) - Math.abs(b.index - currentIndex));
}

// Retry only weak matches with recent suffixes; strong full-context matches win.
// Six characters is the minimum recovery evidence, never a one-word blind jump.
function rankRecentCandidates(variants, script, currentIndex, from, to, expectedIndex) {
  const full = rankCandidates(variants, script, currentIndex, from, to, expectedIndex);
  if (full[0]?.confidence >= T.strongConfidence) return full;
  const text = Array.from(variants.find(variant => !variant.context).text);
  const suffixes = T.recoveryLengths.filter(length => length < text.length)
    .map(length => ({ text: text.slice(-length).join(''), context: false }));
  if (!suffixes.length) return full;
  const recovered = rankCandidates(suffixes, script, currentIndex, from, to, expectedIndex)
    .filter(candidate => candidate.confidence >= T.recoveryConfidence)
    .map(candidate => ({ ...candidate, rank: candidate.rank - T.recoveryPenalty, recovered: true }));
  const byIndex = new Map(full.map(candidate => [candidate.index, candidate]));
  for (const candidate of recovered) {
    if (!byIndex.has(candidate.index) || candidate.rank > byIndex.get(candidate.index).rank) {
      byIndex.set(candidate.index, candidate);
    }
  }
  return [...byIndex.values()].sort((a, b) => b.rank - a.rank || b.evidence - a.evidence);
}

function canCatchUp(tracker, script, currentIndex, best, event) {
  const sequence = tracker.sequence;
  if (!sequence || sequence.index !== currentIndex ||
    event.endMs <= sequence.atMs || event.endMs - sequence.atMs > SEQUENCE_TTL_MS ||
    best.index <= currentIndex + 1 || best.index > currentIndex + T.catchUpAhead ||
    best.confidence < T.strongConfidence || best.evidence < T.relocationEvidence) return false;
  // A single growing ASR item may already contain several complete cues. An
  // explicit ordered path through every intervening cue is stronger evidence
  // than a clear suffix alone, and can also verify a pending onset prediction.
  const spans = matchedSpans(best, script);
  const covered = new Map(spans.map(span => [span.index, span]));
  if (best.evidence >= T.catchUpEvidence && Array.from({length: best.index - currentIndex + 1}, (_, offset) => currentIndex + offset)
    .every(index => !script.entries[index].source.music && covered.has(index) &&
      (index === best.index || covered.get(index).completed))) return true;
  if (tracker.prediction || best.confidence < T.catchUpConfidence) return false;
  // Partial phrases need more evidence than a complete cue. All candidates still
  // pass ambiguity checks; distant/reverse jumps retain the correction handshake.
  return best.evidence >= T.catchUpEvidence || best.heard === script.entries[best.index].text;
}

// This anchor survives uncertain recognition, but uncertainty never renews its
// lifetime or authorizes an audio-only advance. Only a verified match/onset does.
function matchSequenceOpening(tracker, script, currentIndex, text, event) {
  const sequence = tracker.sequence;
  if (!sequence || sequence.index !== currentIndex ||
    event.endMs < sequence.atMs || event.endMs - sequence.atMs > SEQUENCE_TTL_MS) return null;
  const index = currentIndex + 1;
  const current = script.entries[currentIndex];
  const entry = script.entries[index];
  if (current?.next !== index || current.source.music || entry.source.music) return null;
  const observed = sequence.observed;
  let opening = text;
  if (event.itemId === observed.itemId) {
    if (!text.startsWith(observed.text)) return null;
    opening = text.slice(observed.text.length);
  } else if (event.startMs < observed.endMs) return null;
  const evidence = Array.from(opening).length;
  if (evidence < 3 || evidence > MAX_HEARD || !entry.text.startsWith(opening) ||
    current.text.includes(opening)) return null;
  // Without a confirmed ending, a shared opening cannot resolve the position.
  for (let i = Math.max(0, currentIndex - T.nearbyBehind); i <= Math.min(script.entries.length - 1, currentIndex + T.nearbyAhead); i++) {
    if (i !== index && script.entries[i].text.startsWith(opening)) return null;
  }
  return { index, offset: evidence, length: entry.length, confidence: 1, rank: 1,
    evidence, heard: opening, openingConfirmed: true };
}

// Full-script correction has its own candidates and pending evidence. It runs
// even when the sequence lane has a usable opening; waiting here never vetoes
// that lane. Scans are throttled on the provider audio clock.
function evaluateCorrection(tracker, script, currentIndex, text, event) {
  const lane = tracker.correction;
  const growingPending = lane.pending && text.length > lane.pending.text.length &&
    text.startsWith(lane.pending.text);
  if (text.length < T.relocationEvidence || (!event.isFinal && !growingPending &&
    event.endMs - lane.lastScanMs < T.correctionIntervalMs)) return null;
  lane.lastScanMs = event.endMs;
  const windows = correctionWindows(script, text);
  const byIndex = new Map();
  for (const [from, to] of windows) {
    for (const candidate of rankRecentCandidates([{text: text.slice(-MAX_HEARD), context: false}],
      script, currentIndex, from, to, currentIndex)) {
      if (!byIndex.has(candidate.index) || candidate.rank > byIndex.get(candidate.index).rank)
        byIndex.set(candidate.index, candidate);
    }
  }
  const candidates = [...byIndex.values()].sort((a, b) => b.rank - a.rank || b.evidence - a.evidence);
  lane.candidates = candidates.slice(0, 3).map(({ index, confidence, offset, length }) =>
    ({ index, confidence, progress: offset / length }));
  const best = candidates[0];
  const exactUnique = best?.confidence === 1 && script.exactLines.get(text)?.length === 1 && text === script.entries[best.index].text &&
    !candidates.some(candidate => candidate.index !== best.index && candidate.confidence === 1);
  if (!best || best.confidence < T.strongConfidence || best.offset < Math.min(2, best.length) ||
    (candidates[1] && best.rank - candidates[1].rank < T.minimumMargin && !exactUnique)) {
    lane.pending = null;
    lane.status = 'searching';
    return { candidates, accepted: false };
  }
  const prior = lane.pending;
  const supported = prior?.index === best.index && best.heard !== prior.heard &&
    event.endMs > prior.endMs && event.endMs - prior.endMs <= SEQUENCE_TTL_MS;
  const sequential = best.index === currentIndex || best.index === script.entries[currentIndex]?.next;
  lane.pending = sequential ? null : { index: best.index, text, heard: best.heard, endMs: event.endMs };
  const accepted = sequential || supported || event.isFinal === true ||
    canCatchUp(tracker, script, currentIndex, best, event);
  lane.status = accepted ? 'verified' : 'pending';
  return { candidates, accepted, exactUnique };
}

function correctionWindows(script, text) {
  if (script.chars.length <= T.fullScanCharacters) return [[0, script.entries.length - 1]];
  const scores = new Map(), chars = Array.from(text).slice(-MAX_HEARD), seen = new Set();
  for (let i = 0; i + 1 < chars.length; i++) {
    const gram = chars[i] + chars[i + 1];
    if (seen.has(gram)) continue;
    seen.add(gram);
    const hits = script.bigrams.get(gram);
    if (!hits) continue;
    for (const index of hits) scores.set(index, (scores.get(index) || 0) + 1 / hits.size);
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  // Do not arbitrarily discard equally plausible repeated material and then
  // mistake the remaining subset for a unique global match.
  if (ranked.length > T.correctionWindowCount && ranked[T.correctionWindowCount - 1][1] === ranked[T.correctionWindowCount][1]) return [];
  const windows = ranked.slice(0, T.correctionWindowCount).map(([index]) => [Math.max(0, index - 2),
    Math.min(script.entries.length - 1, index + 2)]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const window of windows) {
    const last = merged.at(-1);
    if (last && window[0] <= last[1] + 1) last[1] = Math.max(last[1], window[1]);
    else merged.push(window);
  }
  return merged;
}

function locateTranscript(tracker, lines, currentIndex, event, preparedScript) {
  const text = normalizeText(event.text);
  if (!text || !event.itemId || !Number.isFinite(event.startMs) ||
    !Number.isFinite(event.endMs)) return {ignored: true, reason: 'invalid_transcript'};
  if (tracker.streamId !== event.streamId) {
    const ignoreBeforeMs = tracker.streamId === null ? tracker.ignoreBeforeMs : -1;
    const referenceState = tracker.streamId === null && tracker.referenceFence ? {
      referenceFence: tracker.referenceFence, progressIndex: tracker.progressIndex, progress: tracker.progress,
      referenceProgress: tracker.referenceProgress,
      located: tracker.located, anchor: tracker.anchor, armedIndex: tracker.armedIndex,
      armedAtMs: tracker.armedAtMs, preparedIndex: tracker.preparedIndex,
      directionWait: tracker.directionWait, openingHint: tracker.openingHint,
      lastLocated: tracker.lastLocated,
    } : {};
    const captureRecovery = tracker.streamId === null ? tracker.captureRecovery : null;
    Object.assign(tracker, createTracker({ ignoreBeforeMs }), {
      ...referenceState, streamId: event.streamId, script: tracker.script,
      captureRecovery,
    });
  }
  if (event.startMs < tracker.ignoreBeforeMs || event.endMs <= tracker.ignoreBeforeMs) {
    return {ignored: true, reason: 'before_manual_fence'};
  }
  const script = preparedScript || prepareScript(lines, tracker.script);
  if (tracker.script && script !== tracker.script) {
    // Edits invalidate old alignment history but preserve the audio ordering fence.
    clearPreparation(tracker);
    tracker.items.clear();
    tracker.located = false;
    tracker.progressIndex = null;
    tracker.progress = 0;
    tracker.sequence = null;
    tracker.correction = createCorrection();
    tracker.prediction = null;
    tracker.referenceFence = null;
    tracker.referenceProgress = null;
    tracker.lastLocated = null;
    tracker.textAnchor = null;
    tracker.path = {hypotheses: [], lastMs: -1};
    tracker.weakPath = {hypotheses: [], lastMs: -1};
    tracker.wordPath = {hypotheses: []};
  }
  tracker.script = script;
  if (event.startMs < tracker.latestStartMs ||
    (Number.isFinite(event.order) && event.order < tracker.latestOrder)) {
    // Late finals can complete history for future alignment, but cannot move the screen.
    const prior = tracker.items.get(event.itemId);
    if (prior && event.isFinal) {
      tracker.items.set(event.itemId, { ...prior, text, endMs: event.endMs, final: true });
    }
    return {ignored: true, reason: 'out_of_order'};
  }
  if (Number.isFinite(event.order)) tracker.latestOrder = event.order;
  const old = tracker.items.get(event.itemId);
  if (old?.final) return {ignored: true, reason: 'item_already_final'};
  // Ordered interim revisions may correct an overestimated word timestamp.
  // Display fences and maxIndex below still prevent stale audio rewinding cues.
  if (old?.text === text && !event.isFinal) return {ignored: true, reason: 'duplicate_interim'};
  tracker.latestStartMs = event.startMs;
  const item = { ...event, text, final: event.isFinal === true, maxIndex: old?.maxIndex ?? null };
  tracker.items.set(event.itemId, item);
  while (tracker.items.size > T.retainedItems) tracker.items.delete(tracker.items.keys().next().value);
  const referenceFence = tracker.referenceFence;
  if (referenceFence && event.endMs <= referenceFence.audioMs) return {ignored: true, reason: 'before_reference_fence'};

  // Keep late finals as history, but they cannot undo an onset decision or arm
  // another cue. A new item with newer audio can still correct a genuine repeat.
  const prediction = tracker.prediction;
  const completeExpectedOpening = prediction?.source === 'opening' && text === script.entries[prediction.index]?.text;
  if (prediction && (event.endMs <= prediction.onsetMs ||
    (prediction.priorItems.has(event.itemId) && text === old?.text && !completeExpectedOpening))) {
    return {ignored: true, reason: 'before_prediction_fence'};
  }

  if (tracker.sequence && (tracker.sequence.index !== currentIndex ||
    event.endMs - tracker.sequence.atMs > SEQUENCE_TTL_MS)) tracker.sequence = null;

  const history = [...tracker.items.values()]
    .filter(entry => entry.itemId !== event.itemId && entry.final &&
      entry.endMs <= event.startMs && event.startMs - entry.endMs < T.historyMs)
    .sort((a, b) => a.startMs - b.startMs).slice(-T.historyItems).map(entry => entry.text).join('');
  const variants = [{ text: text.slice(-MAX_HEARD), context: false }];
  if (history) variants.unshift({ text: (history + text).slice(-MAX_HEARD), context: true });
  const expectedIndex = tracker.armedIndex ?? currentIndex;
  const opening = event.prepareOnly ? null : matchPredictedOpening(tracker, script, text, event) ||
    matchPreparedOpening(tracker, script, currentIndex, text, event) ||
    matchSequenceOpening(tracker, script, currentIndex, text, event);
  const partialOpening = preparedOpeningText(tracker, currentIndex, text, event);
  const waitingForOpening = partialOpening &&
    script.entries[tracker.preparedIndex].text.startsWith(partialOpening);
  let candidates = opening ? [opening] : rankRecentCandidates(variants, script, currentIndex,
    Math.max(0, currentIndex - T.nearbyBehind), Math.min(lines.length - 1, currentIndex + T.nearbyAhead), expectedIndex);
  if (!opening) {
    const byIndex = new Map(candidates.map(candidate => [candidate.index, candidate]));
    for (const candidate of localCandidates(tracker, script, currentIndex, text, event)) {
      if (!byIndex.has(candidate.index) || candidate.rank > byIndex.get(candidate.index).rank) byIndex.set(candidate.index, candidate);
    }
    candidates = [...byIndex.values()].sort((a, b) => b.rank - a.rank || Math.abs(a.index - currentIndex) - Math.abs(b.index - currentIndex));
  }
  // An isolated first character of a future cue must not hide a viable
  // completed preceding cue in the same growing utterance.
  const viableCandidates = candidates.filter(candidate => candidate.index === currentIndex ||
    candidate.offset >= Math.min(2, candidate.length));
  if (!opening && !waitingForOpening && viableCandidates.length) candidates = viableCandidates;
  // Phone tolerance is local, requires literal anchors and never authorizes a
  // global relocation or completion. It is not an acoustic model.
  const anchor = recoveryAnchor(tracker, currentIndex);
  if (!opening && anchor && event.endMs >= anchor.atMs && event.endMs - anchor.atMs <= T.recoveryTtlMs &&
    (!candidates[0] || candidates[0].confidence < T.strongConfidence || candidates[0].trailingCharacters)) {
    const phonetic = align(text, script, currentIndex, Math.min(lines.length - 1, currentIndex + T.catchUpAhead),
      {local: true, phonetic: true}).filter(c => c.matchedCharacters >= T.phoneticMinimumMatches &&
        c.phoneticMatches > 0 &&
        c.confidence >= T.strongConfidence && (c.index === currentIndex || c.offset >= Math.min(2, c.length)) &&
        !script.entries[c.index].source.music);
    const byIndex = new Map(candidates.map(c => [c.index, c]));
    for (const c of phonetic) {
      const rank = c.confidence + (byIndex.get(c.index)?.trailingCharacters ? T.localTrailingPenalty * 2 : 0);
      if (!byIndex.has(c.index) || byIndex.get(c.index).rank < rank) byIndex.set(c.index, {...c, rank});
    }
    candidates = [...byIndex.values()].sort((a, b) => b.rank - a.rank);
  }
  const currentSuffix = candidates[0]?.index > currentIndex + 1 ? align(text, script, currentIndex, currentIndex)[0] : null;
  let suffixConflict = isCurrentSuffix(script, currentIndex, text, candidates[0], currentSuffix);
  if (suffixConflict && currentSuffix) candidates = [{...currentSuffix, rank: currentSuffix.confidence}];
  const pathCandidate = observeScriptPath(tracker, script, currentIndex, candidates, event);
  const weakPathCandidate = observeWeakScriptPath(tracker, script, currentIndex, candidates, {...event, text});
  if (pathCandidate) candidates = [pathCandidate, ...candidates.filter(c => c.index !== pathCandidate.index)];
  let best = candidates[0];
  const short = matchContextualShort(tracker, script, currentIndex, text, event);
  if (short && (!best || best.index === currentIndex || best.confidence <= short.confidence)) {
    candidates = [short, ...candidates.filter(candidate => candidate.index !== currentIndex)];
    best = short;
  }
  if (!short && (!best || best.confidence < T.minimumConfidence)) {
    const nextShort = matchContextualShort(tracker, script, currentIndex, text, event, true);
    if (nextShort) { best = nextShort; candidates = [best, ...candidates.filter(c => c.index !== best.index)]; }
  }
  const correction = suffixConflict || pathCandidate ? null : evaluateCorrection(tracker, script, currentIndex, text, event);
  const corrected = correction?.candidates[0];
  const next = script.entries[currentIndex]?.next;
  const localSequential = best && (best.index === currentIndex || best.index === next);
  const localRecovery = best && canRecoverNearby(tracker, script, currentIndex, best, event,
    candidates[1] && best.rank - candidates[1].rank < T.minimumMargin);
  // One arbiter owns the display. A confirmed correction can override a local
  // guess, while an ambiguous/pending search cannot block a usable sequence.
  const useCorrection = correction?.candidates.length > 0 && (
    (!tracker.sequence && !opening && !localRecovery && !(localSequential && best.colloquial)) ||
    (correction.accepted && (!localSequential || !best ||
      corrected.confidence > best.confidence ||
      (correction.exactUnique && text !== script.entries[best.index].text)))
  );
  if (useCorrection) {
    candidates = correction.candidates;
    best = candidates[0];
  }
  // Keep the existing arbiter's usable matches ahead of the weaker lane.
  if (!pathCandidate && weakPathCandidate && (!best || best.confidence < T.minimumConfidence)) {
    best = weakPathCandidate;
    candidates = [best, ...candidates.filter(c => c.index !== best.index)];
  }
  // Path promotion happens AFTER the initial suffix check. Recheck the final
  // winner so a remembered path cannot turn this cue's ending into a later
  // cue's opening (for example, jumping over a short intervening line).
  if (best?.index > currentIndex + 1) {
    const suffix = align(text, script, currentIndex, currentIndex)[0];
    if (isCurrentSuffix(script, currentIndex, text, best, suffix)) {
      suffixConflict = true;
      best = {...suffix, rank: suffix.confidence}; candidates = [best];
      tracker.path.hypotheses = tracker.path.hypotheses.filter(h => h.index <= currentIndex || h.endMs !== event.endMs);
    }
  }
  // The selected display is the starting occurrence. Repeated copies elsewhere
  // do not override an equally good current-cue match on initial acquisition.
  const selected = event.trustedCurrentIndex === currentIndex && candidates.find(c => c.index === currentIndex &&
    c.confidence >= T.minimumConfidence && c.rank >= (best?.rank ?? 0) - T.minimumMargin);
  if (selected) { best = selected; candidates = [selected, ...candidates.filter(c => c !== selected)]; }
  tracker.candidates = candidates.slice(0, 3).map(({ index, confidence, offset, length }) =>
    ({ index, confidence, progress: offset / length }));
  const uncertain = (reason, message) => {
    if (tracker.referenceProgress?.index === currentIndex && tracker.referenceProgress.completed &&
      event.endMs <= tracker.referenceProgress.audioEndMs) return {ignored: true, reason: 'older_than_reference_completion'};
    if (!suffixConflict && !['ambiguous_text', 'insufficient_text_evidence', 'insufficient_opening'].includes(reason)) {
      const words = recoverWordPosition(tracker, script, lines, currentIndex, {...event, text, minimumIndex: item.maxIndex ?? -1});
      if (words) return words;
    }
    tracker.directionWait = null;
    if (!waitingForOpening && !(text.length <= 2 && tracker.located && tracker.anchor &&
      event.endMs - tracker.anchor.endMs <= SEQUENCE_TTL_MS)) {
      clearPreparation(tracker);
      tracker.located = false;
    }
    if (tracker.sequence) {
      // Remember revisions for same-item suffix matching without extending TTL.
      // Keep an existing prefix while a short opening is still growing.
      const observed = tracker.sequence.observed;
      const suffix = event.itemId === observed.itemId && text.startsWith(observed.text)
        ? text.slice(observed.text.length) : text;
      if (!suffix || !script.entries[currentIndex + 1]?.text.startsWith(suffix)) {
        tracker.sequence.observed = { itemId: event.itemId, text, endMs: event.endMs };
      }
    }
    return {status: 'searching', reason, message: tracker.sequence
      ? `${message} 保留順序跟隨，等待下一格明確開頭。` : message, candidate: best || null};
  };
  if (!best || best.confidence < (best.weakPath ? T.weakPathConfidence : best.contextualShort ? T.contextualShortConfidence : T.minimumConfidence)) {
    return uncertain('low_text_score', '正在重新定位台詞，暫時維持目前字幕。');
  }
  const runner = candidates[1];
  const ambiguous = !selected && !best.pathConfirmed && runner && best.rank - runner.rank < T.minimumMargin;
  const sequential = best.index === currentIndex || best.index === tracker.armedIndex;
  // Identical short lines are only resolvable through an already confirmed boundary.
  const expectedShort = sequential && text === script.entries[best.index].text &&
    (best.index === currentIndex || tracker.progress === 1);
  const exactUnique = best.confidence === 1 && text === script.entries[best.index].text &&
    !candidates.some(candidate => candidate.index !== best.index && candidate.confidence === 1);
  if (prediction && prediction.source !== 'opening' && best.index < prediction.index &&
    (prediction.priorItems.has(event.itemId) || event.startMs < prediction.onsetMs)) {
    return {ignored: true, reason: 'prediction_rewind'};
  }
  if (referenceFence && best.index < referenceFence.index &&
    (event.endMs < (referenceFence.decidedAudioMs ?? referenceFence.audioMs) ||
      (referenceFence.priorItems.has(event.itemId) && old?.text === text))) return {ignored: true, reason: 'reference_rewind'};
  if (best.index !== currentIndex && best.offset < Math.min(2, best.length)) {
    return uncertain('insufficient_opening', '已聽到可能的開頭，等待更多內容確認。');
  }
  if ((ambiguous && !exactUnique) ||
    (best.evidence < 3 && !expectedShort && !best.openingConfirmed && !best.contextualShort)) {
    return uncertain(ambiguous ? 'ambiguous_text' : 'insufficient_text_evidence', '有多處相似台詞，等待更多內容確認。');
  }
  // Revisions/finalization of one ASR item must not rewind that item's progress.
  if (item.maxIndex !== null && best.index < item.maxIndex) return {ignored: true, reason: 'same_item_rewind'};

  const relocation = best.index !== currentIndex && best.index !== next;
  const caughtUp = relocation && canCatchUp(tracker, script, currentIndex, best, event);
  const recoveredNearby = relocation && canRecoverNearby(tracker, script, currentIndex, best, event, ambiguous);
  const captureReacquired = relocation && canReacquireCapture(tracker, script, currentIndex, best, event);
  if (relocation) {
    if (best.confidence < (best.weakPath ? T.weakPathConfidence : best.pathConfirmed ? T.minimumConfidence : T.strongConfidence) ||
      (!best.pathConfirmed && text.length < T.relocationEvidence && !recoveredNearby) || (ambiguous && !exactUnique && !best.pathConfirmed)) {
      return uncertain('relocation_requirements', '疑似跳詞，正在核對新的位置。');
    }
    if (!best.pathConfirmed && !recoveredNearby && !captureReacquired && (!correction?.accepted || corrected.index !== best.index)) {
      return uncertain('correction_pending', '疑似跳詞，等待後續語音確認。');
    }
  }
  item.maxIndex = Math.max(item.maxIndex ?? best.index, best.index);
  tracker.captureRecovery = null;
  const progress = best.offset / best.length;
  if (tracker.referenceProgress?.index === best.index && event.endMs <= tracker.referenceProgress.audioEndMs &&
    progress < tracker.referenceProgress.progress) return {ignored: true, reason: 'reference_progress_regression'};
  if (tracker.referenceFence && tracker.referenceFence.index !== best.index) {
    // New, confirmed words may correct an acoustic guess even when an ASR item
    // began before that guess. Old finals still cannot rewind the committed cue.
    tracker.referenceFence = null; tracker.referenceProgress = null;
  }
  tracker.progressIndex = best.index;
  tracker.progress = progress;
  tracker.located = true;
  tracker.prediction = null;
  tracker.sequence = { index: best.index, atMs: event.endMs,
    observed: { itemId: event.itemId, text, endMs: event.endMs } };
  tracker.lastLocated = {index: best.index, atMs: event.endMs, confidence: best.confidence,
    literal: !best.phonetic && !best.trailingCharacters && !best.weakPath && best.evidence >= T.relocationEvidence};
  const entry = script.entries[best.index];
  const shortAnchor = best.confidence === 1 && best.evidence >= T.shortAnchorEvidence && !best.context &&
    entry.text.includes(best.heard) && !script.entries.some((e, i) => i !== best.index &&
      i >= best.index - T.nearbyBehind && i <= best.index + T.nearbyAhead && e.text.includes(best.heard));
  if (!best.phonetic && !best.trailingCharacters && !best.weakPath &&
    best.confidence >= T.strongConfidence && (tracker.lastLocated.literal || shortAnchor))
    tracker.textAnchor = {...tracker.lastLocated, literal: true};
  const shortRecovery = recoveredNearby && best.evidence < T.recoveryMinimumEvidence;
  if (shortRecovery) best = {...best, locationOnly: true, shortRecovery: true};
  if (relocation) tracker.correction.pending = null;
  const tail = entry.tail;
  // Only arm from the actual end of a line, never merely from ASR is_final.
  const completed = !best.locationOnly && !best.weakPath && !best.phonetic && !best.trailingCharacters && progress === 1 && best.confidence >= T.strongConfidence &&
    best.heard.endsWith(tail) && (best.evidence >= 3 || expectedShort);
  const following = entry.next;
  const nearEnding = progress >= T.nearEndingProgress && entry.length - best.offset <= T.nearEndingRemaining;
  const canPrepare = !best.locationOnly && !best.weakPath && !best.phonetic && !best.trailingCharacters && (completed || nearEnding) && best.confidence >= T.strongConfidence && following === best.index + 1 &&
    !lines[best.index]?.music && !lines[following]?.music;
  tracker.preparedIndex = canPrepare ? following : null;
  tracker.armedIndex = canPrepare && completed ? following : null;
  tracker.openingHint = canPrepare ? script.entries[following].opening : '';
  tracker.anchor = canPrepare ? {
    itemId: event.itemId, text, endMs: event.endMs, completed,
  } : null;
  tracker.armedAtMs = completed ? event.endMs : null;
  if (completed && lines[best.index + 1]?.type === 'direction' &&
    (!Number.isFinite(tracker.directionSpeechStartedMs) || event.endMs >= tracker.directionSpeechStartedMs)) {
    const previousWait = tracker.directionWait;
    // Finalization of the same confirmed words must not restart the countdown.
    tracker.directionWait = previousWait?.fromIndex === best.index &&
      previousWait.anchor.itemId === event.itemId && previousWait.anchor.text === text
      ? previousWait
      : { fromIndex: best.index, index: best.index + 1, quietMs: 0, lastAudioEndMs: null,
        anchor: { itemId: event.itemId, text, endMs: event.endMs, completed: true } };
  } else {
    tracker.directionWait = null;
  }
  return {
    index: best.index, candidate: best, progress, completed, armedIndex: tracker.armedIndex,
    reason: captureReacquired ? 'capture_reacquired' : best.shortRecovery ? 'short_exact_recovery' : best.shortNext ? 'contextual_short_next' : best.weakPath ? 'weak_path_recovery' : best.pathConfirmed ? 'path_recovery' : best.phonetic ? 'local_phonetic' : recoveredNearby ? 'nearby_recovery' : caughtUp ? 'nearby_catch_up' : best.contextualShort ? 'contextual_short'
      : best.trailingCharacters ? 'trailing_tolerance' : best.colloquial ? 'local_colloquial' : best.recovered ? 'suffix_recovery'
      : best.openingConfirmed ? 'opening_confirmed' : 'text_matched',
    spans: matchedSpans(best, script),
    status: best.index === currentIndex ? 'verified' : relocation || prediction ? 'corrected' : 'advanced',
    message: recoveredNearby ? '已依附近明確台詞恢復定位。' : caughtUp ? '已依最新清楚台詞追上附近字幕。' :
      best.contextualShort ? '已依附近順序容許短句一字差異，持續核對句尾。' :
      best.recovered ? '已依最新文字尾段重新定位字幕。' :
      best.openingConfirmed ? '已確認下一格開頭，持續核對後續台詞。' :
      canPrepare ? (completed ? '已核對句尾，等待下一格開頭。' : '接近句尾，正在準備下一格。') :
      best.index === currentIndex ? '正在跟隨目前台詞。' : '已依語音定位字幕。',
  };
}

function restoreOpeningPreparation(tracker) {
  const plan = tracker.openingPlan;
  tracker.preparedIndex = plan?.index ?? null;
  tracker.armedIndex = null;
  tracker.openingHint = plan ? tracker.script?.entries[plan.index]?.opening || '' : '';
}

// Display timing is separate from the full-evidence locator. A short opening
// spends one preparation; only a normal accepted match prepares another cue.
function followTranscript(tracker, lines, currentIndex, event) {
  const script = prepareScript(lines, tracker.script);
  const reset = !tracker.shortOpenings || tracker.streamId !== event.streamId || tracker.script !== script;
  let plan = reset ? null : tracker.openingPlan;
  const selectedStartIndex = reset ? currentIndex : tracker.selectedStartIndex;
  if (plan?.fromIndex !== currentIndex) plan = null;
  if (!plan && script.entries[currentIndex]?.source.type === 'direction')
    plan = prepareOpening(script, currentIndex, {text: '', endMs: Math.max(0, tracker.ignoreBeforeMs)}, true);
  const trigger = matchOpening(plan, script, event);
  const result = locateTranscript(tracker, lines, currentIndex,
    {...event, prepareOnly: true, trustedCurrentIndex: tracker.prediction?.source === 'opening' &&
      normalizeText(event.text) === script.entries[currentIndex]?.text ? currentIndex : selectedStartIndex}, script);
  tracker.shortOpenings = true;
  tracker.selectedStartIndex = selectedStartIndex;
  if (result.ignored) {
    tracker.openingPlan = plan;
    restoreOpeningPreparation(tracker);
    return result;
  }
  const accepted = Number.isInteger(result.index);
  const repeatedCurrent = accepted && result.index === currentIndex && result.completed &&
    normalizeText(event.text) === script.entries[currentIndex].text &&
    script.entries[currentIndex].length > T.triggerOpeningCharacters;
  // A full accepted relocation still wins when the ASR batch already proves a
  // different location. Otherwise the prepared short opening owns the change.
  if (trigger && !repeatedCurrent && (!accepted || result.index === currentIndex)) {
    const speech = {...event, text: trigger.text, startMs: trigger.startMs, endMs: trigger.endMs};
    const item = tracker.items.get(event.itemId), maxIndex = item?.maxIndex ?? null;
    applySemanticLocation(tracker, lines, trigger.index, speech, {prepare: false});
    // Displaying an expectation is not a verified same-item forward fence:
    // later revised/new words must still be able to correct the estimate.
    if (item) item.maxIndex = maxIndex;
    tracker.openingPlan = null;
    tracker.prediction = {index: trigger.index, fromIndex: currentIndex, source: 'opening',
      onsetMs: trigger.startMs, decidedAudioMs: event.endMs, anchor: {itemId: event.itemId, text: normalizeText(event.text), endMs: event.endMs},
      priorItems: new Set([event.itemId, ...[...tracker.items.values()].filter(item => item.endMs <= trigger.startMs).map(item => item.itemId)])};
    tracker.selectedStartIndex = null;
    restoreOpeningPreparation(tracker);
    return {index: trigger.index, status: 'advanced', reason: 'prepared_short_opening', shortOpening: trigger,
      progress: 0, completed: false, spans: [], armedIndex: null,
      evidence: {startMs: trigger.startMs, endMs: trigger.endMs},
      candidate: {index: trigger.index, offset: trigger.characters, length: script.entries[trigger.index].length,
        confidence: 1, evidence: trigger.characters, heard: trigger.text, locationOnly: true, shortOpening: true},
      message: '已依下一格短開頭顯示字幕，等待現有配對標準核對後再準備下一格。'};
  }
  if (accepted) {
    const span = result.spans?.find(s => s.index === result.index);
    const fullText = script.entries[result.index].text;
    const heard = result.completed && normalizeText(event.text).endsWith(fullText) ? fullText : span?.heard || result.candidate?.heard;
    const speech = result.candidate?.speech || suffixSpeech(event, heard);
    if (speech) {
      result.candidate = {...result.candidate, speech};
      result.evidence = {startMs: speech.startMs, endMs: speech.endMs};
    }
    tracker.selectedStartIndex = null;
    tracker.openingPlan = prepareOpening(script, result.index, event);
  } else {
    tracker.openingPlan = plan;
    if (plan) observeOpening(plan, event);
  }
  restoreOpeningPreparation(tracker);
  return result;
}

function followAudio(tracker, lines, currentIndex, { level, durationMs, endMs }) {
  const duration = Math.max(0, Math.min(O.maxPacketMs, durationMs || 0));
  const threshold = Math.max(O.minimumThreshold, Math.min(O.maximumThreshold, tracker.noiseFloor * O.noiseMultiplier));
  const releaseThreshold = threshold * O.releaseRatio;
  if (level < releaseThreshold) {
    tracker.noiseFloor = tracker.noiseFloor * O.noiseSmoothing + level * (1 - O.noiseSmoothing);
    tracker.quietMs += duration;
    tracker.loudMs = 0;
    if (tracker.quietMs >= O.quietMs) tracker.released = true;
  } else if (level >= threshold) {
    tracker.loudMs += duration;
    tracker.quietMs = 0;
  } else {
    tracker.loudMs = 0;
    tracker.quietMs = 0;
  }
  const result = { threshold, releaseThreshold };
  const directionWait = tracker.directionWait;
  if (directionWait) {
    const indexes = [directionWait.fromIndex, directionWait.index];
    const unchanged = indexes.every(index => {
      const line = lines[index], source = tracker.script?.entries[index]?.source;
      return line && source && line.text === source.text && line.type === source.type &&
        line.music === source.music && line.role === source.role;
    });
    if (tracker.prediction || !tracker.located || tracker.progressIndex !== currentIndex ||
      tracker.progress !== 1 || directionWait.fromIndex !== currentIndex ||
      lines[currentIndex]?.type === 'direction' ||
      lines[directionWait.index]?.type !== 'direction' || !unchanged) {
      tracker.directionWait = null;
    } else if (Number.isFinite(endMs) && endMs > directionWait.anchor.endMs &&
      (directionWait.lastAudioEndMs === null || endMs > directionWait.lastAudioEndMs)) {
      // Count only newly received, continuous quiet audio after confirming the
      // ending. Missing audio, stale capture and an ASR delay are not silence.
      if (directionWait.lastAudioEndMs !== null &&
        endMs - directionWait.lastAudioEndMs > duration + O.maximumGapMs) directionWait.quietMs = 0;
      directionWait.lastAudioEndMs = endMs;
      directionWait.quietMs = level < releaseThreshold ? directionWait.quietMs + duration : 0;
      if (directionWait.quietMs >= DIRECTION_SILENCE_MS) {
        result.index = directionWait.index;
        result.source = 'silence';
        tracker.prediction = {
          index: result.index, fromIndex: currentIndex, onsetMs: endMs, decidedAudioMs: endMs,
          source: 'silence', anchor: directionWait.anchor,
          priorItems: new Set([...tracker.items.values()].filter(item => item.endMs <= endMs)
            .map(item => item.itemId)),
        };
        tracker.sequence = { index: result.index, atMs: endMs,
          observed: { itemId: directionWait.anchor.itemId, text: directionWait.anchor.text,
            endMs: directionWait.anchor.endMs } };
        clearPreparation(tracker);
        tracker.progressIndex = result.index;
        tracker.progress = 0;
        tracker.candidates = [];
        return result;
      }
    }
  }
  if (tracker.loudMs < O.loudMs || !tracker.released) return result;
  tracker.released = false;
  const onsetMs = endMs - tracker.loudMs;
  tracker.lastOnsetMs = onsetMs;
  result.onsetMs = onsetMs;
  if (tracker.shortOpenings) return result;
  if (tracker.prediction || !tracker.located || tracker.progressIndex !== currentIndex ||
    tracker.progress !== 1 || tracker.armedIndex !== currentIndex + 1 ||
    !tracker.anchor?.completed || onsetMs < tracker.armedAtMs ||
    onsetMs - tracker.armedAtMs > SEQUENCE_TTL_MS) return result;
  // Only inspect the two relevant raw records at an onset. No full-script scan,
  // Unicode normalization or rebuilding is permitted on the 50 Hz audio path.
  for (const index of [currentIndex, tracker.armedIndex]) {
    const line = lines[index], source = tracker.script?.entries[index]?.source;
    if (!line || !source || line.music || line.type === 'direction' ||
      line.text !== source.text || line.type !== source.type ||
      line.music !== source.music || line.role !== source.role) {
      clearPreparation(tracker);
      return result;
    }
  }
  result.index = tracker.armedIndex;
  tracker.prediction = {
    index: result.index, fromIndex: currentIndex, onsetMs, decidedAudioMs: endMs,
    anchor: tracker.anchor,
    priorItems: new Set([...tracker.items.values()].filter(item => item.endMs <= onsetMs)
      .map(item => item.itemId)),
  };
  tracker.sequence = { index: result.index, atMs: onsetMs,
    observed: { itemId: tracker.anchor.itemId, text: tracker.anchor.text, endMs: tracker.anchor.endMs } };
  clearPreparation(tracker);
  tracker.progressIndex = result.index;
  tracker.progress = 0;
  tracker.candidates = [];
  return result;
}

function applyReferencePosition(tracker, lines, index, evidence) {
  const script = prepareScript(lines, tracker.script), entry = script.entries[index];
  if (!entry?.text) return false;
  const sameLine = tracker.progressIndex === index;
  if (!sameLine) {
    clearPreparation(tracker); tracker.prediction = null; tracker.sequence = null;
  }
  if (!tracker.referenceFence || tracker.referenceFence.index !== index) {
    tracker.referenceFence = {index, audioMs: evidence.audioStartMs, decidedAudioMs: evidence.audioEndMs,
      priorItems: new Set(tracker.items.keys())};
  }
  tracker.script = script; tracker.located = true; tracker.progressIndex = index;
  tracker.prediction = null;
  tracker.progress = Math.max(sameLine ? tracker.progress : 0, evidence.completed ? 1 : evidence.progress);
  tracker.referenceProgress = {index, progress: tracker.progress, completed: tracker.progress === 1, audioEndMs: evidence.audioEndMs};
  tracker.lastLocated = {index, atMs: evidence.audioEndMs};
  if (tracker.progress === 1) {
    const anchor = {itemId: `reference-${index}`, text: entry.text, endMs: evidence.audioEndMs, completed: true};
    const following = entry.next;
    if (following === index + 1 && !lines[index]?.music && !lines[following]?.music) {
      tracker.anchor = anchor; tracker.armedIndex = following; tracker.preparedIndex = following;
      tracker.armedAtMs = evidence.audioEndMs; tracker.openingHint = script.entries[following].opening;
    }
    if (lines[index + 1]?.type === 'direction' && !tracker.directionWait &&
      (!Number.isFinite(tracker.directionSpeechStartedMs) || evidence.audioStartMs >= tracker.directionSpeechStartedMs)) {
      tracker.directionWait = {fromIndex: index, index: index + 1, quietMs: 0, lastAudioEndMs: null, anchor};
    }
  }
  return true;
}

function recoverWordPosition(tracker, script, lines, currentIndex, event) {
  const anchor = tracker.textAnchor;
  if (!anchor || currentIndex < anchor.index || currentIndex > anchor.index + 1 ||
    event.endMs - anchor.atMs > T.weakAnchorTtlMs) return null;
  let to = Math.min(lines.length - 1, currentIndex + T.weakPathAhead);
  for (let i = currentIndex; i <= to; i++) if (lines[i].music || lines[i].type === 'direction') { to = i - 1; break; }
  const candidates = [];
  for (const speech of wordWindows(event, {maximumWords: T.wordWindowWords, windowWords: T.wordWindowLength,
    maximumCharacters: T.wordWindowCharacters})) {
    if (speech.startMs < anchor.atMs) continue;
    const heard = normalizeText(speech.text);
    for (let index = currentIndex; index <= to; index++) {
      const entry = script.entries[index];
      if (heard.length > entry.length / T.weakPathConfidence ||
        Array.from(heard).filter(char => entry.text.includes(char)).length < T.shortMatchedCharacters) continue;
      for (const c of align(heard, script, index, index, {local: true})) {
        if (c.confidence < T.weakPathConfidence || c.matchedCharacters < Math.min(T.shortAnchorEvidence, entry.length) || c.offset < 2) continue;
        candidates.push({...c, speech, rank: c.confidence + .01 * Math.min(c.evidence, 12)});
      }
    }
  }
  const best = observeWordPath(tracker, script, currentIndex, candidates, event);
  if (!best || (tracker.prediction && best.speech.endMs <= tracker.prediction.onsetMs) ||
    !applySemanticLocation(tracker, lines, best.index, best.speech)) return null;
  tracker.candidates = [{index: best.index, confidence: best.confidence, progress: 0}];
  // Text ranges can establish a new position; this path never supplies a
  // completed ending, fake intermediate visits or an onset preparation.
  if (best.confidence >= T.strongConfidence && best.matchedCharacters >= T.shortAnchorEvidence)
    tracker.textAnchor = {index: best.index, atMs: best.speech.endMs, confidence: best.confidence, literal: true};
  return {index: best.index, candidate: best, progress: 0, completed: false, armedIndex: null, spans: [],
    evidence: {startMs: best.speech.startMs, endMs: best.speech.endMs},
    reason: 'word_span_recovery', status: 'corrected', message: '已依不重疊詞區間恢復附近位置，持續核對台詞。'};
}

// Isolated new speech only: no earlier ASR items, expectation bonus or global
// correction. Competing nearby lines remain present for ambiguity checks.
function localSupportCandidates(script, currentIndex, text, {ahead = T.nearbyAhead, behind = T.nearbyBehind, crossDirections = false} = {}) {
  const heard = normalizeText(text).slice(-MAX_HEARD);
  let to = Math.min(script.entries.length - 1, currentIndex + ahead);
  for (let i = currentIndex + 1; i <= to; i++) {
    if (script.entries[i].source.music || (!crossDirections && script.entries[i].source.type === 'direction')) { to = i - 1; break; }
  }
  let from = Math.max(0, currentIndex - behind);
  if (crossDirections) for (let i = currentIndex - 1; i >= from; i--) {
    if (script.entries[i].source.music) { from = i + 1; break; }
  }
  const byIndex = new Map(align(heard, script, from, to, {local: true}).map(c => [c.index, c]));
  for (const c of align(heard, script, from, to, {local: true, phonetic: true})) {
    if (c.phoneticMatches > 0 && c.confidence >= S.phoneticConfidence && c.matchedCharacters >= T.phoneticMinimumMatches &&
      c.confidence > (byIndex.get(c.index)?.confidence ?? 0)) byIndex.set(c.index, c);
  }
  return [...byIndex.values()].filter(c => c.offset >= Math.min(2, c.length) && !script.entries[c.index].source.music);
}

function applySemanticLocation(tracker, lines, index, event, {prepare = true} = {}) {
  const script = prepareScript(lines, tracker.script);
  if (!script.entries[index]?.text || script.entries[index].source.music ||
    event.endMs <= tracker.ignoreBeforeMs) return false;
  clearPreparation(tracker);
  tracker.script = script; tracker.located = true; tracker.progressIndex = index; tracker.progress = 0;
  tracker.prediction = null; tracker.referenceFence = null; tracker.referenceProgress = null;
  tracker.path = {hypotheses: [], lastMs: event.endMs};
  tracker.weakPath = {hypotheses: [], lastMs: event.endMs};
  tracker.wordPath = {hypotheses: []};
  tracker.correction = createCorrection();
  tracker.lastLocated = {index, atMs: event.endMs};
  tracker.sequence = {index, atMs: event.endMs, observed: {itemId: event.itemId,
    text: normalizeText(event.text), endMs: event.endMs}};
  const item = tracker.items.get(event.itemId);
  if (item) item.maxIndex = Math.max(item.maxIndex ?? index, index);
  tracker.shortOpenings = true;
  tracker.openingPlan = prepare ? prepareOpening(script, index, event) : null;
  restoreOpeningPreparation(tracker);
  return true;
}

module.exports = { createTracker, prepareScript, normalizeText, align, followTranscript, locateTranscript, followAudio, applyReferencePosition, applySemanticLocation, localSupportCandidates };
