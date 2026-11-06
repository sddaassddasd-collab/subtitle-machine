const {normalizeText} = require('./follow-text');
const {freshSpeech} = require('./word-evidence');
const {preservedSpeech, returnMatch} = require('./return-evidence');

const PERFORMANCE_SETTINGS = Object.freeze({version: 6, mismatchMs: 4500, mismatchAudioMs: 3000,
  minimumItems: 2, minimumCharacters: 8, minimumSpeechConfidence: .35,
  longItemMs: 6500, longItemCharacters: 18, stablePrefixCharacters: 3, stableMs: 900, semanticGraceMs: 2500,
  mismatchGapMs: 2500,
  switchHoldMs: 4000, maximumLagMs: 5000, bufferMs: 6000, bufferItems: 3,
  returnConfidence: .94, returnCharacters: 5, returnMargin: .12, returnAhead: 18,
  searchExpandMs: 8000, maximumSearchAhead: 72, returnMaximumStep: 4, returnWitnesses: 16,
  scriptContextTtlMs: 15000, maximumStableMatches: 32,
  retainedSupportMs: 15000, weakReturnConfidence: .70, weakReturnMatches: 3, weakReturnSteps: 3,
  wordTimestampToleranceMs: 750, weakReturnMaximumStep: 2,
  returnBehind: 3, returnSupportMs: 8000, audioGapMs: 1200, quietLevel: .0015, quietMs: 1800,
  maximumGroups: 30, maximumGroupCues: 12});
const normalized = new WeakMap();
const number = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.max(min, Math.min(max, Number(value))) : fallback;
function normalizePerformanceSettings(value) {
  if (value && typeof value === 'object' && normalized.has(value)) return normalized.get(value);
  const result = {automaticLive: value?.automaticLive === true, scriptCorrection: value?.scriptCorrection !== false,
    captionAnimation: value?.captionAnimation !== false,
    overlapGroups: (Array.isArray(value?.overlapGroups) ? value.overlapGroups : []).slice(0, PERFORMANCE_SETTINGS.maximumGroups)
      .filter(g => g && ['id', 'cellId', 'startLineId', 'endLineId'].every(k => typeof g[k] === 'string' && g[k].trim().length > 0 && g[k].length <= 100))
      .map(g => ({id: g.id, cellId: g.cellId, startLineId: g.startLineId, endLineId: g.endLineId,
        name: String(g.name || '交疊段').slice(0, 60), minimumSeconds: number(g.minimumSeconds, 1.8, 1, 8),
        maximumSeconds: number(g.maximumSeconds, 45, 5, 120), charactersPerSecond: number(g.charactersPerSecond, 4, 2, 12)}))};
  if (value && typeof value === 'object') normalized.set(value, result);
  normalized.set(result, result);
  return result;
}
function resolveGroups(settings, cellId, lines) {
  const ids = new Map(lines.map((l, i) => [l.id, i]));
  return settings.overlapGroups.filter(g => g.cellId === cellId).map(g => {
    const start = ids.get(g.startLineId), end = ids.get(g.endLineId);
    const valid = Number.isInteger(start) && Number.isInteger(end) && end > start &&
      end - start < PERFORMANCE_SETTINGS.maximumGroupCues && lines[end + 1] &&
      lines.slice(start, end + 2).every(l => l.type !== 'direction' && !l.music && normalizeText(l.text));
    return {...g, start, end, valid: Boolean(valid)};
  }).map((g, _, groups) => ({...g, valid: g.valid && !groups.some(other => other.id !== g.id &&
    other.valid && g.start <= other.end && other.start <= g.end)}));
}

// No wall-clock timers: pacing advances only while fresh audio packets arrive.
// One owner chooses the output source; the ASR and script locator keep running.
class PerformanceFollower {
  constructor() {
    this.source = 'script'; this.lock = 'auto'; this.buffer = []; this.usedGroups = new Set();
    this.rates = []; this.lastReliable = null; this.lastConfirmedEnd = -1;
    this.mismatch = null; this.group = null; this.speed = 1;
    this.switchedAt = -Infinity; this.semanticAt = -Infinity; this.reason = 'ready';
    this.returnWitnesses = []; this.stableMatches = new Map();
  }
  bind(settings, cellId, lines) {
    if (this.settings === settings && this.cellId === cellId && this.lines === lines) return;
    this.settings = settings; this.cellId = cellId; this.lines = lines;
    this.groups = resolveGroups(settings, cellId, lines);
    this.group = null; this.reason = 'context_changed';
  }
  publicState() {
    return {source: this.source, lock: this.lock, reason: this.reason,
      lastReliableIndex: this.lastReliable?.index ?? null, backgroundIndex: this.backgroundIndex ?? null,
      backgroundConfirmedIndex: this.backgroundConfirmed?.index ?? null,
      searchWindow: this.lastSearchWindow ?? null, returnDecision: this.returnDecision ?? null,
      fallbackDecision: this.fallbackDecision ?? null,
      preparedIndex: this.prepared && Date.now() - this.prepared.at < 15000 ? this.prepared.index : null,
      group: this.group ? {id: this.group.id, name: this.group.name, start: this.group.start,
        end: this.group.end, index: this.group.index, paused: this.group.paused,
        nextAudioMs: this.group.nextAudioMs, expiresAudioMs: this.group.expiresAudioMs, speed: this.speed} : null,
      groups: this.groups?.map(g => ({id: g.id, valid: g.valid, start: g.start, end: g.end})) || []};
  }
  get enabled() { return this.settings?.automaticLive || this.groups?.length || this.source === 'live'; }
  transition(source, reason, now) {
    if (this.source === source) { this.reason = reason; return null; }
    const from = this.source; this.source = source; this.reason = reason; this.switchedAt = now;
    this.mismatch = null; this.returnWitnesses = []; this.stableMatches.clear();
    this.backgroundConfirmed = null; this.searchAt = now; this.returnDecision = null;
    if (source === 'live') { this.group = null; this.backgroundIndex = this.lastReliable?.index ?? this.originIndex; }
    else { this.returnBuffer = this.buffer; this.buffer = []; }
    return {type: 'source', from, source, reason};
  }
  searchWindow(now = Date.now()) {
    const origin = this.backgroundConfirmed?.index ?? this.lastReliable?.index ?? this.originIndex ?? 0;
    const elapsed = Math.max(0, now - (this.backgroundConfirmed?.at ?? this.searchAt ?? now));
    const ahead = Math.min(PERFORMANCE_SETTINGS.maximumSearchAhead,
      PERFORMANCE_SETTINGS.returnAhead * (1 + Math.floor(elapsed / PERFORMANCE_SETTINGS.searchExpandMs)));
    let from = Math.max(0, origin - PERFORMANCE_SETTINGS.returnBehind), to = Math.min(this.lines.length - 1, origin + ahead);
    // Directions are silent annotations, not a permanent boundary. Music still
    // requires an explicit position/scene change; it is never auto-skipped.
    for (let i = origin + 1; i <= to; i++) if (this.lines[i].music) { to = i - 1; break; }
    for (let i = origin - 1; i >= from; i--) if (this.lines[i].music) { from = i + 1; break; }
    return this.lastSearchWindow = {origin, from, to, crossDirections: true};
  }
  hasRecentScriptContext(now = Date.now()) {
    return this.source !== 'live' || now - (this.backgroundConfirmed?.at ?? this.switchedAt) <= PERFORMANCE_SETTINGS.scriptContextTtlMs;
  }
  forgetMismatch(itemId) {
    const m = this.mismatch;
    if (!m) return;
    m.items.delete(itemId);
    if (!m.items.size) { this.mismatch = null; return; }
    m.startMs = Math.min(...[...m.items.values()].map(x => x.startMs));
    m.endMs = Math.max(...[...m.items.values()].map(x => x.endMs));
  }
  semanticRequested(inputId, now) {
    this.semanticRequest = {inputId, until: now + PERFORMANCE_SETTINGS.semanticGraceMs};
    if (this.mismatch && !this.mismatch.semanticReserved) {
      this.mismatch.semanticReserved = true;
      this.mismatch.semanticUntil = this.semanticRequest.until;
    }
  }
  semanticSettled(inputId) {
    if (!inputId || this.semanticRequest?.inputId === inputId) this.semanticRequest = null;
  }
  speech(event, now) {
    if (!event.itemId || !Number.isFinite(event.startMs) || !Number.isFinite(event.endMs) || event.endMs <= event.startMs) return null;
    if (event.audioMs - event.endMs > PERFORMANCE_SETTINGS.maximumLagMs || event.endMs > event.audioMs + 250) return null;
    const fresh = freshSpeech(event, this.lastConfirmedEnd);
    const prior = this.buffer.find(x => x.itemId === event.itemId);
    if (!fresh || !normalizeText(fresh.text)) {
      if (prior) this.buffer = this.buffer.filter(x => x !== prior);
      this.forgetMismatch(event.itemId);
      return null;
    }
    const text = String(fresh.text).slice(-300), unchanged = prior?.text === text;
    const a = normalizeText(prior?.text), b = normalizeText(text);
    let prefix = 0; while (prefix < a.length && a[prefix] === b[prefix]) prefix++;
    const preservesPrefix = prefix >= PERFORMANCE_SETTINGS.stablePrefixCharacters;
    const entry = {itemId: event.itemId, startMs: fresh.startMs, endMs: fresh.endMs, text,
      at: now, stableAt: unchanged || preservesPrefix ? prior.stableAt : now,
      confidence: event.confidence, isFinal: event.isFinal === true, id: event.itemId};
    this.buffer = this.buffer.filter(x => x.itemId !== entry.itemId && x.endMs > event.audioMs - PERFORMANCE_SETTINGS.bufferMs);
    this.buffer.push(entry); this.buffer.sort((a, b) => a.endMs - b.endMs);
    this.buffer = this.buffer.slice(-PERFORMANCE_SETTINGS.bufferItems);
    return entry;
  }
  observe(event, match, now = Date.now()) {
    const speech = this.speech(event, now);
    if (this.source === 'live') {
      match = returnMatch(this.stableMatches, event, match, now, PERFORMANCE_SETTINGS);
      this.returnWitnesses = this.returnWitnesses.filter(w => w.itemId !== event.itemId || preservedSpeech(event, w));
    }
    if (match && Number.isInteger(match.index)) {
      this.recognitionReliable = false;
      const action = this.recognize(match, event, now);
      if (this.source === 'live' || action || this.recognitionReliable) return action;
    }
    if (this.source === 'live') {
      this.returnDecision = {reason: 'no_reliable_candidate'};
    }
    const reject = !speech ? 'no_fresh_speech' : this.group ? 'overlap_active' : this.source === 'live' ? 'already_live'
      : this.lock !== 'auto' ? 'operator_script_lock' : !this.settings.automaticLive ? 'disabled'
        : !this.lastReliable && !Number.isInteger(this.originIndex) ? 'no_script_anchor' : null;
    if (reject) { this.fallbackDecision = {reason: reject}; return null; }
    if (Number.isFinite(event.confidence) && event.confidence < PERFORMANCE_SETTINGS.minimumSpeechConfidence) {
      this.forgetMismatch(event.itemId);
      this.fallbackDecision = {reason: 'speech_confidence_too_low', confidence: event.confidence}; return null;
    }
    if (!speech.isFinal && now - speech.stableAt < PERFORMANCE_SETTINGS.stableMs) {
      this.fallbackDecision = {reason: 'waiting_for_stable_prefix', stableMs: now - speech.stableAt}; return null;
    }
    if (this.mismatch && speech.startMs - this.mismatch.endMs > PERFORMANCE_SETTINGS.mismatchGapMs) this.mismatch = null;
    const m = this.mismatch ||= {at: now, startMs: speech.startMs, endMs: -1, items: new Map()};
    if (!m.semanticReserved && this.semanticRequest) {
      m.semanticReserved = true; m.semanticUntil = this.semanticRequest.until;
    }
    if (speech.endMs <= m.endMs && !m.items.has(speech.itemId)) return null;
    m.items.set(speech.itemId, speech);
    // Revisions replace evidence, never count as an additional utterance.
    while (m.items.size > 12) m.items.delete(m.items.keys().next().value);
    m.startMs = Math.min(...[...m.items.values()].map(x => x.startMs));
    m.endMs = Math.max(...[...m.items.values()].map(x => x.endMs));
    return this.maybeLive(event.audioMs, now);
  }
  maybeLive(audioMs, now) {
    const m = this.mismatch;
    if (!m || this.group || this.source === 'live' || this.lock !== 'auto' || !this.settings?.automaticLive ||
      audioMs - m.endMs > PERFORMANCE_SETTINGS.maximumLagMs) return null;
    const parts = [...m.items.values()].sort((a, b) => a.startMs - b.startMs);
    if (!parts.length) return null;
    let end = -1, items = 0, characters = 0, unclear = false;
    for (const part of parts) if (part.startMs >= end) {
      items++; characters += normalizeText(part.text).length; end = part.endMs;
      if (Number.isFinite(part.confidence) && part.confidence < .6) unclear = true;
    }
    const elapsedMs = now - m.at, speechMs = m.endMs - m.startMs;
    const longItem = items === 1 && characters >= PERFORMANCE_SETTINGS.longItemCharacters &&
      speechMs >= PERFORMANCE_SETTINGS.longItemMs && elapsedMs >= PERFORMANCE_SETTINGS.longItemMs;
    const reason = items < PERFORMANCE_SETTINGS.minimumItems && !longItem ? 'needs_distinct_speech'
      : characters < PERFORMANCE_SETTINGS.minimumCharacters ? 'needs_more_characters'
        : elapsedMs < PERFORMANCE_SETTINGS.mismatchMs ? 'mismatch_hold'
          : speechMs < PERFORMANCE_SETTINGS.mismatchAudioMs ? 'needs_more_audio'
            : now - this.switchedAt < PERFORMANCE_SETTINGS.switchHoldMs ? 'switch_hold'
              : (m.semanticReserved ? this.semanticRequest && now < m.semanticUntil
                : now - this.semanticAt < PERFORMANCE_SETTINGS.semanticGraceMs) ? 'semantic_grace' : null;
    this.fallbackDecision = {reason: reason || 'ready', items, characters, elapsedMs, speechMs, unclear};
    if (reason) return null;
    this.buffer = this.buffer.filter(x => x.endMs > audioMs - PERFORMANCE_SETTINGS.bufferMs);
    return this.transition('live', unclear ? 'sustained_unclear_speech' : 'sustained_unmatched_speech', now);
  }
  recognize(match, event, now = Date.now()) {
    const {index} = match, line = this.lines[index];
    if (!line || line.music || line.type === 'direction') {
      if (this.source === 'live') this.returnDecision = {reason: 'non_dialogue_candidate', index};
      return null;
    }
    const startMs = match.startMs ?? event.startMs, endMs = match.endMs ?? event.endMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs ||
      event.audioMs - endMs > PERFORMANCE_SETTINGS.maximumLagMs || endMs > event.audioMs + 250) {
      if (this.source === 'live') this.returnDecision = {reason: 'stale_or_invalid_audio', index, startMs, endMs};
      return null;
    }
    if (this.source === 'live') {
      const window = this.searchWindow(now), origin = window.origin;
      const reject = index < window.from || index > window.to ? 'outside_search_window'
        : endMs <= this.lastConfirmedEnd ? 'already_confirmed_audio'
          : index < (this.backgroundConfirmed?.index ?? origin) ? 'behind_background_position'
            : this.lines.slice(Math.min(origin, index), Math.max(origin, index) + 1).some(l => l.music) ? 'music_barrier' : null;
      if (reject) { this.returnDecision = {reason: reject, index, startMs, endMs}; return null; }
      this.backgroundIndex = index;
      const strong = match.semantic === true || (!match.phonetic && match.confidence >= PERFORMANCE_SETTINGS.returnConfidence &&
        match.evidence >= PERFORMANCE_SETTINGS.returnCharacters && match.margin >= PERFORMANCE_SETTINGS.returnMargin);
      const text = normalizeText(match.speech?.text || event.text), stableAt = match.stableAt ?? now;
      const nearEnding = Number.isFinite(match.offset) && Number.isFinite(match.length) && match.offset >= match.length - 1;
      const boundarySettled = Boolean(event.isFinal || event.speechFinal || event.semanticSupported ||
        (nearEnding && now - stableAt >= PERFORMANCE_SETTINGS.stableMs));
      this.returnWitnesses = this.returnWitnesses.filter(w => endMs - w.endMs <=
        (w.settled ? PERFORMANCE_SETTINGS.retainedSupportMs : PERFORMANCE_SETTINGS.returnSupportMs));
      const previous = this.returnWitnesses.findLast(w => startMs >= w.endMs && endMs > w.endMs &&
        index > w.index && index <= w.index + (match.confidence < .8
          ? PERFORMANCE_SETTINGS.weakReturnMaximumStep : PERFORMANCE_SETTINGS.returnMaximumStep) &&
        (w.itemId !== event.itemId || (Number.isInteger(match.speech?.firstWordId) && match.speech.firstWordId > w.lastWordId &&
          normalizeText(event.text).includes(w.text))));
      const literal = !match.phonetic && match.confidence >= PERFORMANCE_SETTINGS.weakReturnConfidence &&
        match.evidence >= 4 && match.matchedCharacters >= PERFORMANCE_SETTINGS.weakReturnMatches && match.margin >= .1;
      const steps = previous ? (previous.steps || 1) + 1 : 1;
      const supported = previous && ((match.confidence >= .8 && previous.confidence >= .8 && match.evidence >= 4 && match.margin >= .07) ||
        (literal && steps >= PERFORMANCE_SETTINGS.weakReturnSteps));
      const settled = boundarySettled || Boolean(supported && match.stablePrefix);
      if (settled && (strong || supported)) this.backgroundConfirmed = {index, startMs, endMs, at: now};
      this.returnDecision = {reason: this.lock === 'live' ? 'operator_live_lock' : !settled ? 'waiting_for_stable_speech'
        : !strong && !supported ? 'needs_independent_support'
          : !strong && now - this.switchedAt < PERFORMANCE_SETTINGS.switchHoldMs ? 'switch_hold' : 'script_reacquired', index, strong, supported: Boolean(supported),
        confidence: match.confidence, evidence: match.evidence, margin: match.margin, startMs, endMs,
        supportingIndex: previous?.index ?? null, pathSteps: steps, retainedPhrase: match.retained === true,
        stablePrefix: match.stablePrefix === true};
      if (this.lock !== 'live' && settled && (strong || (supported && now - this.switchedAt >= PERFORMANCE_SETTINGS.switchHoldMs))) {
        const returnEvidence = this.returnDecision;
        const action = this.transition('script', 'script_reacquired', now);
        this.confirm(index, startMs, endMs, now);
        return {...action, index, matchSource: match.semantic ? 'semantic' : 'transcript',
          audioStartMs: startMs, audioEndMs: endMs, confidence: match.confidence ?? null, returnEvidence,
          speech: match.speech};
      }
      if ((match.confidence >= .8 && match.evidence >= 4 && match.margin >= .07) || literal) {
        // Revisions update their own range, never erase a different cue's
        // nonoverlapping witness or count as a second observation.
        this.returnWitnesses = this.returnWitnesses.filter(w => !(w.index === index && w.itemId === event.itemId && startMs < w.endMs));
        this.returnWitnesses.push({index, itemId: event.itemId, startMs, endMs, text,
          rawText: match.speech?.text || event.text, confidence: match.confidence, settled, steps,
          lastWordId: match.speech?.lastWordId});
        this.returnWitnesses = this.returnWitnesses.slice(-PERFORMANCE_SETTINGS.returnWitnesses);
      }
      return null;
    }
    const reliable = match.semantic || match.scriptVerified || (match.confidence >= .86 && match.evidence >= 4 && match.margin >= .07) ||
      (match.pathConfirmed && match.evidence >= 4);
    if (!reliable || endMs <= this.lastConfirmedEnd) return null;
    this.recognitionReliable = true;
    this.mismatch = null; this.fallbackDecision = {reason: 'script_matched', index};
    this.confirm(index, startMs, endMs, now);
    let exitedGroupId = null;
    if (this.group && index > this.group.end) {
      exitedGroupId = this.group.id; this.group = null; this.reason = 'overlap_exit_recognized';
    }
    if (this.group && index >= this.group.index && index <= this.group.end) {
      this.group.index = index; this.group.nextAudioMs = event.audioMs + this.dwell(index);
      this.group.nextAt = now + this.dwell(index);
      if (this.group.quietPaused) { this.group.paused = false; this.group.quietPaused = false; }
    }
    const group = this.groups.find(g => g.valid && g.start === index && !this.usedGroups.has(g.id));
    if (group && this.lock === 'auto') return {...this.startGroup(group, event.audioMs, now), exitedGroupId};
    if (exitedGroupId) return {type: 'overlap_stop', reason: this.reason, groupId: exitedGroupId};
    return null;
  }
  confirm(index, startMs, endMs, now) {
    this.lastReliable = {index, startMs, endMs, at: now}; this.lastConfirmedEnd = Math.max(this.lastConfirmedEnd, endMs);
    this.buffer = this.buffer.filter(x => x.endMs > this.lastConfirmedEnd);
    const rate = normalizeText(this.lines[index].text).length / ((endMs - startMs) / 1000);
    if (rate >= 2 && rate <= 12) this.rates = [...this.rates, rate].slice(-5);
  }
  dwell(index) {
    const g = this.group, length = normalizeText(this.lines[index]?.text).length;
    const cps = this.rates.length ? this.rates.reduce((a, b) => a + b) / this.rates.length : g.charactersPerSecond;
    const segment = this.segments?.find(s => s.lineId === this.lines[index]?.id && ['auto', 'manual'].includes(s.status));
    const referenceSeconds = segment && segment.end - segment.start;
    const seconds = referenceSeconds > 0 ? referenceSeconds * number(length / referenceSeconds / cps, 1, .65, 1.5) : length / cps;
    return Math.max(g.minimumSeconds, Math.min(12, seconds / this.speed)) * 1000;
  }
  startGroup(group, audioMs, now) {
    this.usedGroups.add(group.id); this.speed = 1;
    this.group = {...group, index: group.start, startedAt: now, startedAudioMs: audioMs,
      expiresAudioMs: audioMs + group.maximumSeconds * 1000, paused: false};
    this.group.nextAudioMs = audioMs + this.dwell(group.start); this.group.nextAt = now + this.dwell(group.start);
    this.reason = 'overlap_started';
    return {type: 'overlap_start', groupId: group.id, reason: this.reason};
  }
  tick(audioMs, now = Date.now(), level) {
    const lastAt = this.lastPacketAt; this.lastPacketAt = now;
    const lastAudioMs = this.lastPacketAudioMs; this.lastPacketAudioMs = audioMs;
    const g = this.group;
    if (!g) {
      if (lastAt !== undefined && now - lastAt > PERFORMANCE_SETTINGS.audioGapMs) {
        this.mismatch = null; this.fallbackDecision = {reason: 'capture_gap'}; return null;
      }
      return this.maybeLive(audioMs, now);
    }
    if (audioMs >= g.expiresAudioMs || now - g.startedAt >= g.maximumSeconds * 1000 ||
      (lastAt !== undefined && now - lastAt > PERFORMANCE_SETTINGS.audioGapMs) ||
      (lastAudioMs !== undefined && audioMs - lastAudioMs > PERFORMANCE_SETTINGS.audioGapMs)) {
      this.group = null; this.reason = audioMs >= g.expiresAudioMs || now - g.startedAt >= g.maximumSeconds * 1000
        ? 'overlap_limit' : 'capture_gap';
      return {type: 'overlap_stop', groupId: g.id, reason: this.reason};
    }
    if (Number.isFinite(level) && level <= PERFORMANCE_SETTINGS.quietLevel) {
      g.quietSince ??= audioMs;
      if (!g.paused && audioMs - g.quietSince >= PERFORMANCE_SETTINGS.quietMs) {
        g.paused = true; g.quietPaused = true; this.reason = 'overlap_quiet';
        return {type: 'overlap_pause', groupId: g.id, reason: this.reason};
      }
    } else g.quietSince = null;
    if (g.paused || this.source !== 'script' || audioMs < g.nextAudioMs || now < g.nextAt || g.index >= g.end) return null;
    g.index++; g.nextAudioMs = audioMs + this.dwell(g.index); g.nextAt = now + this.dwell(g.index); this.reason = 'paced_estimate';
    return {type: 'paced_estimate', index: g.index, groupId: g.id, reason: this.reason,
      speed: this.speed, nextAudioMs: g.nextAudioMs, expiresAudioMs: g.expiresAudioMs};
  }
  command(action, index, audioMs, now = Date.now()) {
    if (action === 'lock-live') { this.lock = 'live'; this.originIndex = index; return this.transition('live', 'operator_live_lock', now); }
    if (action === 'lock-script') { this.lock = 'script'; this.group = null; return this.transition('script', 'operator_script_lock', now); }
    if (action === 'auto') { this.lock = 'auto'; this.mismatch = null; this.reason = 'automatic_assistance'; return null; }
    if (action === 'start-overlap') {
      const g = this.groups.find(g => g.valid && index === g.start);
      if (!g || this.source !== 'script') throw new Error('請先定位到有效交疊段的第一格');
      return this.startGroup(g, audioMs, now);
    }
    if (action === 'cancel-overlap') { this.group = null; this.reason = 'operator_cancel'; return null; }
    if (!this.group) throw new Error('目前沒有交疊走格');
    if (action === 'pause') this.group.paused = true;
    else if (action === 'resume') { this.group.paused = false; this.group.quietPaused = false; this.group.quietSince = null;
      this.group.nextAudioMs = audioMs + this.dwell(this.group.index); this.group.nextAt = now + this.dwell(this.group.index); }
    else if (['faster', 'slower'].includes(action)) {
      this.speed = number(this.speed + (action === 'faster' ? .15 : -.15), 1, .5, 2);
      this.group.nextAudioMs = audioMs + this.dwell(this.group.index);
      this.group.nextAt = now + this.dwell(this.group.index);
    } else throw new Error('不支援的操作');
    this.reason = `operator_${action}`; return null;
  }
}
module.exports = {PerformanceFollower, PERFORMANCE_SETTINGS, normalizePerformanceSettings, resolveGroups};
