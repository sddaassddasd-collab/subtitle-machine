const {pinyin} = require('pinyin-pro');
const {normalizeText} = require('./follow-text');
const {alignedWords} = require('./word-evidence');

const SETTINGS = Object.freeze({ahead: 72, behind: 6, historyMs: 8000, maximumWords: 20,
  maximumCueCharacters: 8, maximumGapMs: 2500, maximumLagMs: 2000,
  minimumCues: 3, minimumCharacters: 6, minimumConfidence: .76, minimumMargin: 1.25});
const negations = text => (text.match(/[不沒無勿別]/gu) || []).join('');
const particles = '啊呢嗎啦吧喔哦呀嘛囉欸';

function soundDistance(heard, expected, phone) {
  let previous = Array.from({length: expected.length + 1}, (_, i) => i);
  for (let a = 0; a < heard.length; a++) {
    const row = [a + 1];
    for (let b = 0; b < expected.length; b++) {
      const from = heard[a], to = expected[b];
      const substitution = from === to ? 0 : phone && phone(from) && phone(from) === phone(to) ? .35
        : a === heard.length - 1 && b === expected.length - 1 && particles.includes(from) && particles.includes(to) ? .55 : 1;
      const inserted = a === heard.length - 1 && particles.includes(from) ? .55 : 1;
      const deleted = b === expected.length - 1 && particles.includes(to) ? .55 : 1;
      row.push(Math.min(previous[b] + substitution, previous[b + 1] + inserted, row[b] + deleted));
    }
    previous = row;
  }
  return previous[expected.length];
}

function matchCue(heard, cue, phone) {
  const short = cue.length <= SETTINGS.maximumCueCharacters;
  if (!short && heard.length < 4) return null;
  const expected = short ? cue : cue.slice(0, heard.length);
  if (Math.abs(heard.length - expected.length) > 1 || negations(heard) !== negations(expected)) return null;
  const size = Math.max(heard.length, expected.length);
  const cost = heard === expected ? 0 : soundDistance([...heard], [...expected], phone);
  if (cost && (size === 1 || cost > Math.max(.7, size * .35))) return null;
  return {short, size, cost, offset: expected.length,
    literal: cost ? [...heard].filter((char, index) => char === expected[index]).length : heard.length};
}

function findSequence(words, script, from, to, event, languageAllowsPinyin) {
  const cues = [];
  for (let index = from; index <= to; index++) {
    const entry = script.entries[index];
    if (entry?.text && !entry.source.music) cues.push({index, text: entry.text});
  }
  const phones = new Map(), comparisons = new Map();
  const phone = char => {
    if (!phones.has(char)) phones.set(char, /\p{Script=Han}/u.test(char) ? pinyin(char, {toneType: 'none'}) : '');
    return phones.get(char);
  };
  const paths = words.map(() => new Map());
  for (let end = 0; end < words.length; end++) {
    let text = '', hasCantonese = false;
    for (let start = end; start >= 0; start--) {
      const word = words[start];
      if (start < end && words[start + 1].startMs - word.endMs > SETTINGS.maximumGapMs) break;
      text = word.normalized + text;
      if (text.length > SETTINGS.maximumCueCharacters + 1) break;
      hasCantonese ||= word.cantonese;
      const allowPinyin = languageAllowsPinyin && !hasCantonese;
      const comparisonKey = (allowPinyin ? 'zh:' : ':') + text;
      if (!comparisons.has(comparisonKey)) comparisons.set(comparisonKey,
        cues.map(cue => matchCue(text, cue.text, allowPinyin ? phone : null)));
      comparisons.get(comparisonKey).forEach((match, position) => {
        if (!match) return;
        const previous = [
          {path: paths[start - 1]?.get(position - 1), penalty: 0},
          {path: paths[start - 1]?.get(position - 2), penalty: .6},
          {path: paths[start - 2]?.get(position - 1), penalty: .75},
        ].filter(({path}) => path && word.startMs - words[path.end].endMs <= SETTINGS.maximumGapMs)
          .sort((a, b) => (b.path.score - b.penalty) - (a.path.score - a.penalty))[0];
        const old = previous?.path;
        const score = (old?.score || 0) + match.size - 1.35 * match.cost - (previous?.penalty || 0);
        if (score <= (paths[end].get(position)?.score ?? -Infinity)) return;
        paths[end].set(position, {index: cues[position].index, score, start, end, offset: match.offset,
          steps: (old?.steps || 0) + 1, short: (old?.short || 0) + Number(match.short),
          size: (old?.size || 0) + match.size, cost: (old?.cost || 0) + match.cost,
          literal: (old?.literal || 0) + match.literal, supportingIndex: old?.index});
      });
    }
  }
  const last = words.at(-1);
  if (last.itemId !== event.itemId || (event.audioMs ?? event.endMs) - last.endMs > SETTINGS.maximumLagMs) return {};
  const ranked = [...paths.at(-1).values()].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.steps < SETTINGS.minimumCues || best.short < 2 || best.size < SETTINGS.minimumCharacters ||
    best.literal < 2 || 1 - best.cost / best.size < SETTINGS.minimumConfidence) return {};
  const rival = ranked.find(path => path.index !== best.index && path.steps >= 2 && path.size >= best.size - 1);
  if (rival && best.score - rival.score < SETTINGS.minimumMargin) return {ambiguous: true};
  const span = words.slice(best.start);
  const speech = {text: span.map(word => word.text).join(' '), itemId: event.itemId, startMs: span[0].startMs,
    endMs: last.endMs, firstWordId: span[0].id, lastWordId: last.id,
    words: span.every(word => Number.isInteger(word.id) && word.itemId === event.itemId) ? span : undefined};
  return {candidate: {index: best.index, confidence: 1 - best.cost / best.size, evidence: best.size,
    offset: best.offset, length: script.entries[best.index].length, shortCueSequence: true, pathConfirmed: true,
    pathSteps: best.steps, supportingIndex: best.supportingIndex, speech}};
}

function observeShortCueSequence(state, script, origin, event, {minimumMs = -1, search = true, mixed = false} = {}) {
  const {itemId, startMs, endMs, streamId} = event;
  if (state.script !== script || state.streamId !== streamId) {
    Object.assign(state, {script, streamId, items: new Map(), lastStartMs: -1});
  }
  if (!itemId || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs ||
    startMs < state.lastStartMs || state.items.get(itemId)?.final) return {};
  state.lastStartMs = startMs;
  const cutoff = Math.max(minimumMs, endMs - SETTINGS.historyMs);
  const timed = alignedWords(event);
  const words = timed.length ? timed : event.words?.length ? [] : [{text: event.text, startMs, endMs}];
  const normalized = words.slice(-SETTINGS.maximumWords).map(word => {
    const language = event.words?.find((entry, index) => (entry.id ?? index) === word.id)?.language || '';
    return {...word, itemId, normalized: normalizeText(word.text),
      cantonese: (!language && mixed) || /^(?:zh-HK|yue)(?:-|$)/i.test(language)};
  }).filter(word => word.normalized && word.startMs >= cutoff);
  state.items.delete(itemId);
  state.items.set(itemId, {words: normalized, final: event.isFinal === true, endMs});
  for (const [id, item] of state.items) if (item.endMs < cutoff) state.items.delete(id);
  while (state.items.size > SETTINGS.maximumWords) state.items.delete(state.items.keys().next().value);
  if (!search || !normalized.length) return {};

  const recent = [];
  for (const item of state.items.values()) for (const word of item.words) {
    if (word.startMs < cutoff) continue;
    while (recent.length && recent.at(-1).endMs > word.startMs) recent.pop();
    recent.push(word);
  }
  if (recent.length < SETTINGS.minimumCues) return {};
  let from = Math.max(0, origin - SETTINGS.behind), to = Math.min(script.entries.length - 1, origin + SETTINGS.ahead);
  if (script.entries[origin]?.source.music) return {};
  for (let index = origin - 1; index >= from; index--) if (script.entries[index].source.music) {from = index + 1; break;}
  for (let index = origin + 1; index <= to; index++) if (script.entries[index].source.music) {to = index - 1; break;}
  return findSequence(recent.slice(-SETTINGS.maximumWords), script, from, to, event,
    /^zh(?:-|$)/i.test(event.language || ''));
}

module.exports = {SHORT_CUE_SETTINGS: SETTINGS, observeShortCueSequence};
