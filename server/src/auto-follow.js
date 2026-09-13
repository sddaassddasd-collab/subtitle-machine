// Script following is independent of ASR segment boundaries and display state.
// Times are milliseconds on the provider's audio clock, never arrival wall time.
const OpenCC = require('opencc-js');
const traditionalize = OpenCC.Converter({ from: 'cn', to: 'twp' });
const MAX_HEARD = 120;

function normalizeText(text) {
  return traditionalize(String(text || '').normalize('NFKC'))
    .replace(/[（(][^（）()]{0,80}[）)]/gu, '')
    .replace(/[\p{P}\p{Z}\p{S}\s]/gu, '').toLocaleLowerCase();
}

function createTracker({ ignoreBeforeMs = -1 } = {}) {
  return {
    streamId: null, ignoreBeforeMs, latestStartMs: -1, latestOrder: -1, items: new Map(),
    progressIndex: null, progress: 0, armedIndex: null, armedAtMs: null,
    prediction: null, pending: null, quietMs: 0, loudMs: 0, released: false,
    noiseFloor: 0.004, lastOnsetMs: -1, lastGlobalAtMs: -Infinity,
  };
}

function dialogue(lines, index) {
  const line = lines[index];
  return line && line.type !== 'direction' ? normalizeText(line.text) : '';
}

function nextDialogue(lines, index) {
  for (let i = index + 1; i < lines.length; i += 1) {
    if (dialogue(lines, i)) return i;
  }
  return null;
}

// Semi-global edit alignment: all heard characters must be accounted for;
// the script may have an unheard prefix/suffix. Keep the order of characters.
function align(heard, lines, from, to) {
  const text = [], positions = [];
  for (let index = from; index <= to; index += 1) {
    const chars = Array.from(dialogue(lines, index));
    chars.forEach((char, offset) => {
      text.push(char);
      positions.push({ index, offset: offset + 1, length: chars.length });
    });
  }
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
    Object.assign(tracker, createTracker({ ignoreBeforeMs }), { streamId: event.streamId });
  }
  if (event.startMs < tracker.ignoreBeforeMs || event.endMs <= tracker.ignoreBeforeMs) {
    return { ignored: true };
  }
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
  let candidates = rankCandidates(variants, lines, currentIndex,
    Math.max(0, currentIndex - 3), Math.min(lines.length - 1, currentIndex + 18), expectedIndex);
  let best = candidates[0];
  let global = false;
  // A long, unique line can reacquire anywhere, including genuine backward jumps.
  if (text.length >= 6 && (!best || best.confidence < 0.88) &&
    (event.isFinal || event.endMs - tracker.lastGlobalAtMs >= 400)) {
    tracker.lastGlobalAtMs = event.endMs;
    candidates = rankCandidates([{ text: text.slice(-MAX_HEARD), context: false }],
      lines, currentIndex, 0, lines.length - 1, expectedIndex);
    best = candidates[0];
    global = best && (best.index < currentIndex - 3 || best.index > currentIndex + 18);
  }
  const uncertain = (reason) => {
    tracker.armedIndex = null;
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
  const expectedShort = sequential && text === dialogue(lines, best.index) &&
    (best.index === currentIndex || tracker.progress === 1);
  if ((ambiguous && !(expectedShort && best.index === expectedIndex)) ||
    (best.evidence < 3 && !expectedShort)) {
    tracker.pending = null;
    return uncertain('有多處相似台詞，等待更多內容確認。');
  }
  if (tracker.prediction && event.endMs <= tracker.prediction.onsetMs &&
    best.index !== currentIndex) return { ignored: true };
  // Revisions/finalization of one ASR item must not rewind that item's progress.
  if (item.maxIndex !== null && best.index < item.maxIndex) return { ignored: true };

  const next = nextDialogue(lines, currentIndex);
  const relocation = best.index !== currentIndex && best.index !== next;
  if (relocation || global) {
    if (best.confidence < 0.88 || text.length < 6 || ambiguous) {
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
  tracker.prediction = null;
  const target = dialogue(lines, best.index);
  const tail = Array.from(target).slice(-Math.min(3, Array.from(target).length)).join('');
  // Only arm from the actual end of a line, never merely from ASR is_final.
  const completed = progress === 1 && best.confidence >= 0.88 &&
    best.heard.endsWith(tail) && (best.evidence >= 3 || expectedShort);
  const following = nextDialogue(lines, best.index);
  const canPredict = completed && following === best.index + 1 &&
    !lines[best.index]?.music && !lines[following]?.music;
  tracker.armedIndex = canPredict ? following : null;
  tracker.completedText = canPredict ? target : null;
  tracker.nextText = canPredict ? dialogue(lines, following) : null;
  tracker.armedAtMs = canPredict ? event.endMs : null;
  return {
    index: best.index, candidate: best, progress, armedIndex: tracker.armedIndex,
    status: best.index === currentIndex ? 'verified' : relocation ? 'corrected' : 'advanced',
    message: canPredict ? '已核對句尾，準備下一格；手動定位後仍會繼續跟戲。' :
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
  if (tracker.armedIndex === null || tracker.progressIndex !== currentIndex ||
    tracker.progress !== 1 || onsetMs < tracker.armedAtMs ||
    onsetMs - tracker.armedAtMs > 10000 || lines[currentIndex]?.music ||
    tracker.armedIndex !== currentIndex + 1 ||
    dialogue(lines, currentIndex) !== tracker.completedText ||
    dialogue(lines, tracker.armedIndex) !== tracker.nextText) {
    return result;
  }
  result.index = tracker.armedIndex;
  result.onsetMs = onsetMs;
  tracker.prediction = { index: result.index, onsetMs };
  // Freeze older items at the predicted position so their final cannot rewind it.
  for (const item of tracker.items.values()) {
    if (item.endMs <= onsetMs) item.maxIndex = Math.max(item.maxIndex ?? 0, result.index);
  }
  tracker.armedIndex = null;
  tracker.progress = 0;
  return result;
}

module.exports = { createTracker, normalizeText, align, followTranscript, followAudio };
