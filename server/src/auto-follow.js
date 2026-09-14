// Script following is independent of ASR segment boundaries and display state.
// Times are milliseconds on the provider's audio clock, never arrival wall time.
const OpenCC = require('opencc-js');
const traditionalize = OpenCC.Converter({ from: 'cn', to: 'twp' });
const MAX_HEARD = 120;

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
  return { entries, chars, positions, starts, exactLines };
}

function normalizeText(text) {
  return traditionalize(String(text || '').normalize('NFKC'))
    .replace(/[（(][^（）()]{0,80}[）)]/gu, '')
    .replace(/[\p{P}\p{Z}\p{S}\s]/gu, '').toLocaleLowerCase();
}

function createTracker({ ignoreBeforeMs = -1 } = {}) {
  return {
    streamId: null, ignoreBeforeMs, latestStartMs: -1, latestOrder: -1, items: new Map(),
    progressIndex: null, progress: 0, armedIndex: null, armedAtMs: null,
    pending: null, quietMs: 0, loudMs: 0, released: false,
    noiseFloor: 0.004, lastOnsetMs: -1, lastGlobalAtMs: -Infinity,
    script: null, located: false, candidates: [], preparedIndex: null,
    anchor: null, openingHint: '',
  };
}

// Semi-global edit alignment: all heard characters must be accounted for;
// the script may have an unheard prefix/suffix. Keep the order of characters.
function align(heard, lines, from, to) {
  const script = Array.isArray(lines) ? prepareScript(lines) : lines;
  const start = script.starts[Math.max(0, from)] ?? 0;
  const end = script.starts[Math.min(script.entries.length, to + 1)] ?? start;
  const text = script.chars.slice(start, end);
  const positions = script.positions.slice(start, end);
  const input = Array.from(heard).slice(-MAX_HEARD);
  if (!input.length || !text.length) return [];
  let previous = new Float64Array(text.length + 1);
  let current = new Float64Array(text.length + 1);
  for (let i = 1; i <= input.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= text.length; j += 1) {
      current[j] = Math.min(
        previous[j - 1] + (input[i - 1] === text[j - 1] ? 0 : 1),
        previous[j] + 1,
        current[j - 1] + 1,
      );
    }
    [previous, current] = [current, previous];
  }
  const byLine = new Map();
  for (let j = 1; j <= text.length; j += 1) {
    // Do not report progress through a suffix that has not actually been heard.
    if (text[j - 1] !== input[input.length - 1]) continue;
    const position = positions[j - 1];
    const confidence = Math.max(0, 1 - previous[j] / input.length);
    const candidate = { ...position, confidence, evidence: input.length, heard };
    const old = byLine.get(position.index);
    if (!old || confidence > old.confidence ||
      (confidence === old.confidence && position.offset < old.offset)) {
      byLine.set(position.index, candidate);
    }
  }
  return [...byLine.values()];
}

function clearPreparation(tracker) {
  tracker.armedIndex = null;
  tracker.preparedIndex = null;
  tracker.anchor = null;
  tracker.openingHint = '';
}

function preparedOpeningText(tracker, currentIndex, text, event) {
  const index = tracker.preparedIndex;
  const anchor = tracker.anchor;
  if (!tracker.located || index !== currentIndex + 1 || !anchor ||
    event.endMs < anchor.endMs || event.endMs - anchor.endMs > 10000) return null;
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
    evidence > 12 || !entry.text.startsWith(opening)) return null;
  // Short openings must distinguish nearby alternatives, including words still
  // ahead in the current cue. Sequence alone cannot resolve a shared opening.
  for (let i = Math.max(0, currentIndex - 3); i <= Math.min(script.entries.length - 1, currentIndex + 18); i++) {
    if (i !== index && script.entries[i].text.includes(opening)) return null;
  }
  return {
    index, offset: evidence, length: entry.length, confidence: 1, rank: 1,
    evidence, heard: opening, openingConfirmed: true,
  };
}

function rankCandidates(variants, lines, currentIndex, from, to, expectedIndex) {
  const candidates = new Map();
  for (const variant of variants) {
    for (const match of align(variant.text, lines, from, to)) {
      const contextBonus = variant.context && match.confidence >= 0.85 ? 0.04 : 0;
      const expectationBonus = match.index === expectedIndex ? 0.025 : 0;
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

function followTranscript(tracker, lines, currentIndex, event) {
  const text = normalizeText(event.text);
  if (!text || !event.itemId || !Number.isFinite(event.startMs) ||
    !Number.isFinite(event.endMs)) return { ignored: true };
  if (tracker.streamId !== event.streamId) {
    const ignoreBeforeMs = tracker.streamId === null ? tracker.ignoreBeforeMs : -1;
    Object.assign(tracker, createTracker({ ignoreBeforeMs }), {
      streamId: event.streamId, script: tracker.script,
    });
  }
  if (event.startMs < tracker.ignoreBeforeMs || event.endMs <= tracker.ignoreBeforeMs) {
    return { ignored: true };
  }
  const script = prepareScript(lines, tracker.script);
  if (tracker.script && script !== tracker.script) {
    // Edits invalidate old alignment history but preserve the audio ordering fence.
    clearPreparation(tracker);
    tracker.items.clear();
    tracker.located = false;
    tracker.progressIndex = null;
    tracker.progress = 0;
    tracker.pending = null;
    tracker.lastGlobalAtMs = -Infinity;
  }
  tracker.script = script;
  if (event.startMs < tracker.latestStartMs ||
    (Number.isFinite(event.order) && event.order < tracker.latestOrder)) {
    // Late finals can complete history for future alignment, but cannot move the screen.
    const prior = tracker.items.get(event.itemId);
    if (prior && event.isFinal) {
      tracker.items.set(event.itemId, { ...prior, text, endMs: event.endMs, final: true });
    }
    return { ignored: true };
  }
  if (Number.isFinite(event.order)) tracker.latestOrder = event.order;
  const old = tracker.items.get(event.itemId);
  if (old?.final || (old && event.endMs < old.endMs && !event.isFinal)) return { ignored: true };
  if (old?.text === text && !event.isFinal) return { ignored: true };
  tracker.latestStartMs = event.startMs;
  const item = { ...event, text, final: event.isFinal === true, maxIndex: old?.maxIndex ?? null };
  tracker.items.set(event.itemId, item);
  while (tracker.items.size > 8) tracker.items.delete(tracker.items.keys().next().value);

  const history = [...tracker.items.values()]
    .filter(entry => entry.itemId !== event.itemId && entry.final &&
      entry.endMs <= event.startMs && event.startMs - entry.endMs < 4000)
    .sort((a, b) => a.startMs - b.startMs).slice(-2).map(entry => entry.text).join('');
  const variants = [{ text: text.slice(-MAX_HEARD), context: false }];
  if (history) variants.unshift({ text: (history + text).slice(-MAX_HEARD), context: true });
  const expectedIndex = tracker.armedIndex ?? currentIndex;
  const opening = matchPreparedOpening(tracker, script, currentIndex, text, event);
  const partialOpening = preparedOpeningText(tracker, currentIndex, text, event);
  const waitingForOpening = partialOpening &&
    script.entries[tracker.preparedIndex].text.startsWith(partialOpening);
  let candidates = opening ? [opening] : rankCandidates(variants, script, currentIndex,
    Math.max(0, currentIndex - 3), Math.min(lines.length - 1, currentIndex + 18), expectedIndex);
  let best = candidates[0];
  let global = false;
  const remoteExact = script.exactLines.get(text)?.some(index =>
    index < currentIndex - 3 || index > currentIndex + 18);
  // A long, unique line can reacquire anywhere, including genuine backward jumps.
  if (!opening && text.length >= 6 && (remoteExact || !tracker.located || !best || best.confidence < 0.88 ||
    (candidates[1] && best.rank - candidates[1].rank < 0.07)) &&
    (event.isFinal || event.endMs - tracker.lastGlobalAtMs >= 400)) {
    tracker.lastGlobalAtMs = event.endMs;
    candidates = rankCandidates([{ text: text.slice(-MAX_HEARD), context: false }],
      script, currentIndex, 0, lines.length - 1, expectedIndex);
    best = candidates[0];
    global = best && (best.index < currentIndex - 3 || best.index > currentIndex + 18);
  }
  tracker.candidates = candidates.slice(0, 3).map(({ index, confidence, offset, length }) =>
    ({ index, confidence, progress: offset / length }));
  const uncertain = (reason) => {
    if (!waitingForOpening) {
      clearPreparation(tracker);
      tracker.located = false;
    }
    return { status: 'searching', message: reason, candidate: best || null };
  };
  if (!best || best.confidence < 0.78) {
    tracker.pending = null;
    return uncertain('正在重新定位台詞，暫時維持目前字幕。');
  }
  const runner = candidates[1];
  const ambiguous = runner && best.rank - runner.rank < 0.07;
  const sequential = best.index === currentIndex || best.index === tracker.armedIndex;
  // Identical short lines are only resolvable through an already confirmed boundary.
  const expectedShort = sequential && text === script.entries[best.index].text &&
    (best.index === currentIndex || tracker.progress === 1);
  const exactUnique = best.confidence === 1 && text === script.entries[best.index].text &&
    !candidates.some(candidate => candidate.index !== best.index && candidate.confidence === 1);
  if (best.index !== currentIndex && best.offset < Math.min(2, best.length)) {
    return uncertain('已聽到可能的開頭，等待更多內容確認。');
  }
  if ((ambiguous && !exactUnique) ||
    (best.evidence < 3 && !expectedShort && !best.openingConfirmed)) {
    tracker.pending = null;
    return uncertain('有多處相似台詞，等待更多內容確認。');
  }
  // Revisions/finalization of one ASR item must not rewind that item's progress.
  if (item.maxIndex !== null && best.index < item.maxIndex) return { ignored: true };

  const next = script.entries[currentIndex]?.next;
  const relocation = best.index !== currentIndex && best.index !== next;
  if (relocation || global) {
    if (best.confidence < 0.88 || text.length < 6 || (ambiguous && !exactUnique)) {
      return uncertain('疑似跳詞，正在核對新的位置。');
    }
    const prior = tracker.pending;
    const supported = prior?.index === best.index && prior.text !== text &&
      event.endMs >= prior.endMs;
    tracker.pending = { index: best.index, text, endMs: event.endMs };
    if (!supported && !event.isFinal) return uncertain('疑似跳詞，等待後續語音確認。');
  } else {
    tracker.pending = null;
  }
  item.maxIndex = Math.max(item.maxIndex ?? best.index, best.index);
  const progress = best.offset / best.length;
  tracker.progressIndex = best.index;
  tracker.progress = progress;
  tracker.located = true;
  const entry = script.entries[best.index];
  const tail = entry.tail;
  // Only arm from the actual end of a line, never merely from ASR is_final.
  const completed = progress === 1 && best.confidence >= 0.88 &&
    best.heard.endsWith(tail) && (best.evidence >= 3 || expectedShort);
  const following = entry.next;
  const nearEnding = progress >= 0.7 && entry.length - best.offset <= 3;
  const canPrepare = (completed || nearEnding) && best.confidence >= 0.88 && following === best.index + 1 &&
    !lines[best.index]?.music && !lines[following]?.music;
  tracker.preparedIndex = canPrepare ? following : null;
  tracker.armedIndex = canPrepare && completed ? following : null;
  tracker.openingHint = canPrepare ? script.entries[following].opening : '';
  tracker.anchor = canPrepare ? {
    itemId: event.itemId, text, endMs: event.endMs, completed,
  } : null;
  tracker.armedAtMs = completed ? event.endMs : null;
  return {
    index: best.index, candidate: best, progress, armedIndex: tracker.armedIndex,
    status: best.index === currentIndex ? 'verified' : relocation ? 'corrected' : 'advanced',
    message: best.openingConfirmed ? '已確認下一格開頭，持續核對後續台詞。' :
      canPrepare ? (completed ? '已核對句尾，等待下一格開頭。' : '接近句尾，正在準備下一格。') :
      best.index === currentIndex ? '正在跟隨目前台詞。' : '已依語音定位字幕。',
  };
}

function followAudio(tracker, lines, currentIndex, { level, durationMs, endMs }) {
  const duration = Math.max(0, Math.min(100, durationMs || 0));
  const threshold = Math.max(0.025, Math.min(0.12, tracker.noiseFloor * 4));
  const releaseThreshold = threshold * 0.45;
  if (level < releaseThreshold) {
    tracker.noiseFloor = tracker.noiseFloor * 0.98 + level * 0.02;
    tracker.quietMs += duration;
    tracker.loudMs = 0;
    if (tracker.quietMs >= 120) tracker.released = true;
  } else if (level >= threshold) {
    tracker.loudMs += duration;
    tracker.quietMs = 0;
  } else {
    tracker.loudMs = 0;
    tracker.quietMs = 0;
  }
  const result = { threshold, releaseThreshold };
  if (tracker.loudMs < 40 || !tracker.released) return result;
  tracker.released = false;
  const onsetMs = endMs - tracker.loudMs;
  tracker.lastOnsetMs = onsetMs;
  result.onsetMs = onsetMs;
  // Onset is supporting evidence only. Applause or an effect cannot change cues.
  return result;
}

module.exports = { createTracker, prepareScript, normalizeText, align, followTranscript, followAudio };
