const {normalizeText} = require('./follow-text');
const {alignedWords, freshSpeech, wordSpeech} = require('./word-evidence');
const {TEXT_SETTINGS: T} = require('./follow-settings');

function prepareOpening(script, index, event, direction = false) {
  const current = script.entries[index], next = direction ? current?.next : index + 1;
  const entry = script.entries[next];
  if (!current || current.source.music || !entry?.text || entry.source.music ||
    (!direction && current.source.type === 'direction')) return null;
  if (script.entries.slice(index, next + 1).some(e => e.source.music)) return null;
  return {fromIndex: index, index: next, direction, completed: direction || event.completed === true, observed: {
    itemId: event.itemId ?? null, text: normalizeText(event.text), endMs: event.endMs,
  }};
}

function newOpeningSpeech(plan, event) {
  const previous = plan.observed, text = normalizeText(event.text);
  if (event.endMs <= previous.endMs) return null;
  const words = alignedWords(event);
  if (words.length) return freshSpeech(event, previous.endMs);
  if (previous.itemId === event.itemId) {
    if (!text.startsWith(previous.text)) return null;
    const suffix = text.slice(previous.text.length);
    return suffix ? {...event, text: suffix, startMs: previous.endMs, estimated: true} : null;
  }
  return event.startMs >= previous.endMs ? {...event, estimated: true} : null;
}

function matchOpening(plan, script, event) {
  if (!plan) return null;
  let speech = newOpeningSpeech(plan, event);
  const entry = script.entries[plan.index];
  if (speech && plan.completed && !plan.direction &&
    speech.startMs - plan.observed.endMs <= T.tailParticleGapMs && entry?.text !== normalizeText(speech.text)) {
    const words = alignedWords(speech);
    const particle = text => text && Array.from(normalizeText(text)).every(c => T.tailParticles.includes(c));
    // Only whole timed words may be removed; never invent a boundary inside
    // a provider word. Legitimate short next cues and speech after a pause stay fast.
    let skip = 0;
    while (skip < words.length && particle(words[skip].text) && !entry.text.startsWith(normalizeText(words[skip].text))) skip++;
    if (skip) speech = skip === words.length ? null : wordSpeech(speech, words[skip].id, words.at(-1).id);
    else if (!words.length && particle(speech.text) && !entry.text.startsWith(normalizeText(speech.text))) speech = null;
  }
  const heard = Array.from(normalizeText(speech?.text));
  const count = Math.min(T.triggerOpeningCharacters, heard.length, entry.length);
  // A completed cue owns the boundary: new speech triggers the expected next
  // display before its content is verified. Partial cues still need a matching
  // next opening, so ordinary continuation cannot spend this preparation.
  if (!count || (!plan.completed &&
    heard.slice(0, count).join('') !== Array.from(entry.text).slice(0, count).join(''))) return null;
  // Use the actual containing word range. Never invent a clock inside a
  // provider word just because only its first one or two characters trigger.
  const words = alignedWords(speech);
  let proof = speech;
  if (words.length) {
    let size = 0, last = words[0];
    for (const word of words) { size += Array.from(normalizeText(word.text)).length; last = word; if (size >= count) break; }
    proof = wordSpeech(speech, words[0].id, last.id);
  }
  return {index: plan.index, fromIndex: plan.fromIndex, text: heard.slice(0, count).join(''),
    characters: count, startMs: proof.startMs, endMs: proof.endMs,
    firstWordId: proof.firstWordId, lastWordId: proof.lastWordId, estimated: speech.estimated === true};
}

// One ASR batch may contain the completed cue and the start of the next.
// Split only at a real word boundary, never estimate inside a provider word.
function completedBatchOpening(script, index, event) {
  const target = script.entries[index]?.text;
  if (!target || !normalizeText(event.text).startsWith(target)) return null;
  let prefix = '';
  for (const word of alignedWords(event)) {
    prefix += normalizeText(word.text);
    if (!target.startsWith(prefix)) return null;
    if (prefix !== target) continue;
    const plan = prepareOpening(script, index, {...event, text: target, endMs: word.endMs, completed: true});
    const trigger = matchOpening(plan, script, event);
    return trigger ? {plan, trigger} : null;
  }
  return null;
}

function observeOpening(plan, event) {
  const text = normalizeText(event.text), previous = plan.observed;
  // A shortened revision does not make previously consumed audio fresh again.
  if (event.itemId === previous.itemId && previous.text.startsWith(text)) return;
  plan.observed = {itemId: event.itemId, text, endMs: Math.max(previous.endMs, event.endMs)};
}

module.exports = {prepareOpening, matchOpening, observeOpening, completedBatchOpening};
