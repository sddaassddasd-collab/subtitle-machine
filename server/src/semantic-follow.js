const {SEMANTIC_SETTINGS: S} = require('./follow-settings');
const {SemanticTranscript, freshSpeech} = require('./semantic-transcript');
const {compactInput, selectMatches, requestSemanticCandidate} = require('./semantic-candidates');
const {normalizeText} = require('./follow-text');
const {alignedWords} = require('./word-evidence');

// Model proposals require independent forward support. Text and phonetic
// evidence can support a proposal without waiting for another model call.
class SemanticFollower {
  constructor({request, now = Date.now, timeoutMs = S.timeoutMs, cooldownMs = S.cooldownMs} = {}) {
    this.request = request; this.now = now; this.timeoutMs = timeoutMs; this.cooldownMs = cooldownMs;
    this.states = new WeakMap();
    this.budgets = new WeakMap();
  }
  clearPending(state, reason) {
    if (!state.pending) return;
    state.handlers.record('reset', {reason, candidateIndex: state.pending.index,
      proposalInputId: state.pending.inputId, pendingAgeMs: this.now() - state.pending.at});
    state.pending = null;
  }
  reset(stream, reason = 'context_changed') {
    const state = this.states.get(stream);
    if (!state) return;
    this.clearPending(state, reason);
    state.cancelReason = reason;
    state.controller?.abort();
    this.states.delete(stream);
  }
  invalidReason(handlers) {
    const current = handlers.isCurrent();
    return current === true ? null : typeof current === 'string' ? current : 'context_changed';
  }
  afterMappedPrefix(revision, speech, pending) {
    if (!pending.hasSpan || revision.itemId !== pending.itemId || revision.inputId === pending.inputId) return true;
    if (!normalizeText(revision.text).startsWith(pending.prefixText) || !Number.isInteger(speech.firstWordId)) return false;
    const suffix = alignedWords(revision).filter(w => w.id >= speech.firstWordId).map(w => w.text).join('');
    return normalizeText(revision.text).length - normalizeText(suffix).length >= pending.prefixText.length;
  }
  gate(state, reason, revision) {
    const key = `${revision.itemId}:${reason}`;
    if (state.lastGate === key) return;
    state.lastGate = key;
    state.handlers.record('skipped', {reason, inputId: revision.inputId, itemId: revision.itemId,
      currentIndex: state.currentIndex, pendingIndex: state.pending?.index ?? null});
  }
  supportMappedWords(state, matches, data) {
    if (matches.length < 2 || !state.handlers.textCandidates) return false;
    const target = matches.at(-1), preceding = matches.at(-2), h = state.handlers;
    if (!target.speech || !preceding.speech || this.invalidReason(h)) return false;
    const [best, runner] = h.textCandidates(preceding.speech).sort((a, b) => b.confidence - a.confidence);
    if (best?.index !== preceding.index || best.confidence < S.textConfidence || best.evidence < S.textEvidence ||
      best.matchedCharacters < S.literalMatches || (best.supportMargin ?? best.confidence - (runner?.confidence ?? 0)) < S.textMargin) return false;
    h.record('supported', {...data, reason: 'word_span_text', supportSource: 'text',
      textConfidence: best.confidence, supportingIndex: preceding.index,
      firstWordId: target.speech.firstWordId, lastWordId: target.speech.lastWordId,
      supportingFirstWordId: preceding.speech.firstWordId, supportingLastWordId: preceding.speech.lastWordId,
      audioStartMs: target.speech.startMs, audioEndMs: target.speech.endMs});
    state.pending = null; state.resolved = true;
    h.accept(target, {...target.speech, supportSource: 'text', proposalInputId: data.inputId,
      supportingFirstWordId: preceding.speech.firstWordId, supportingLastWordId: preceding.speech.lastWordId});
    return true;
  }
  supportText(state, revision) {
    const p = state.pending, h = state.handlers;
    if (!p || !h.textCandidates) return false;
    const expired = this.now() - p.at > S.supportTtlMs || revision.endMs - p.endMs > S.supportTtlMs;
    const invalid = this.invalidReason(h);
    if (invalid || expired) { this.clearPending(state, invalid || 'support_expired'); return false; }
    const afterMs = p.weak?.endMs ?? p.endMs;
    const preservesPrefix = !p.hasSpan || revision.itemId !== p.itemId || revision.inputId === p.inputId ||
      normalizeText(revision.text).startsWith(p.prefixText);
    const fresh = preservesPrefix ? freshSpeech(revision, afterMs) : null;
    const speech = fresh && this.afterMappedPrefix(revision, fresh, p) ? fresh : null;
    if (!speech) {
      // A revision of the same audio is not positive independent support, but
      // clear contradictory literal words can withdraw a mistaken proposal.
      if (revision.itemId === p.itemId && revision.inputId !== p.inputId) {
        const [best, runner] = h.textCandidates(revision).sort((a, b) => b.confidence - a.confidence);
        if (best && !best.phonetic && best.index !== p.index && best.confidence >= S.phoneticConfidence &&
          best.evidence >= S.textEvidence && best.matchedCharacters >= S.literalMatches &&
          (best.supportMargin ?? best.confidence - (runner?.confidence ?? 0)) >= S.textMargin) {
          h.record('support_wait', {reason: 'revised_text_contradiction', inputId: revision.inputId,
            proposalInputId: p.inputId, candidateIndex: best.index, confidence: best.confidence,
            supportText: revision.text});
          this.clearPending(state, 'revised_text_contradiction'); return false;
        }
      }
      if (revision.inputId !== p.inputId) h.record('support_wait', {reason: 'no_independent_audio',
        inputId: revision.inputId, proposalInputId: p.inputId, candidateIndex: p.index,
        audioStartMs: revision.startMs, audioEndMs: revision.endMs, evidenceAfterMs: afterMs,
        pendingAgeMs: this.now() - p.at});
      return false;
    }
    const candidates = h.textCandidates(speech).sort((a, b) => b.confidence - a.confidence ||
      (b.speech?.endMs || 0) - (a.speech?.endMs || 0));
    const best = candidates[0], runner = candidates[1];
    const support = best?.speech || speech;
    const margin = best ? best.supportMargin ?? best.confidence - (runner?.confidence ?? 0) : 0;
    const fromIndex = p.weak?.index ?? p.index;
    const matches = best?.matchedCharacters ?? 0;
    const strong = best && best.confidence >= (best.phonetic ? S.phoneticConfidence : S.textConfidence) &&
      best.evidence >= S.textEvidence && matches >= S.literalMatches;
    const weak = best && !best.phonetic && best.confidence >= S.weakConfidence &&
      best.evidence >= S.weakEvidence && matches >= S.weakLiteralMatches;
    const maximumStep = strong && best.confidence >= S.skipConfidence && matches >= S.skipLiteralMatches
      ? S.strongMaximumStep : S.maximumStep;
    const near = best && best.index >= fromIndex && best.index <= fromIndex + maximumStep &&
      (strong || best.index > fromIndex);
    const reason = !best ? 'no_text_candidate' : margin < S.textMargin ? 'ambiguous_text_support'
      : !near ? 'text_outside_proposed_path' : !(strong || weak) ? 'insufficient_text_support' : null;
    const data = {inputId: revision.inputId, proposalInputId: p.inputId, candidateIndex: best?.index ?? null,
      confidence: best?.confidence ?? null, margin, matchedCharacters: matches, evidence: best?.evidence ?? 0,
      textConfidence: best?.confidence ?? null, semanticMatchConfidence: p.matchConfidence,
      asrConfidence: revision.confidence, scoreSource: 'text_alignment',
      supportText: support.text, audioStartMs: support.startMs, audioEndMs: support.endMs,
      firstWordId: support.firstWordId ?? null, lastWordId: support.lastWordId ?? null,
      pendingAgeMs: this.now() - p.at, phonetic: best?.phonetic === true};
    if (reason) {
      h.record('support_wait', {...data, reason});
      // A clear competing position invalidates the proposal. Weak or ambiguous
      // observations do not erase it or renew its lifetime.
      if (strong && margin >= S.textMargin && (best.index < p.index || best.index > fromIndex + maximumStep))
        this.clearPending(state, 'contradictory_text');
      return false;
    }
    const steps = (p.weak?.steps ?? 0) + 1;
    if (!strong && steps < S.weakSteps) {
      p.weak = {index: best.index, endMs: support.endMs, steps};
      h.record('support_wait', {...data, reason: 'weak_path_needs_next_cue', pathSteps: steps});
      return false;
    }
    h.record('supported', {...data, reason: strong ? 'independent_text' : 'ordered_weak_text',
      supportSource: best.phonetic ? 'phonetic' : 'text', pathSteps: steps});
    state.pending = null;
    h.accept(best, {...support, supportSource: best.phonetic ? 'phonetic' : 'text', proposalInputId: p.inputId});
    state.resolved = true;
    state.controller?.abort();
    return true;
  }
  async observe(stream, observation, handlers) {
    let budget = this.budgets.get(stream);
    if (!budget) { budget = {lastRequest: -Infinity, busy: false, itemRequests: new Map()}; this.budgets.set(stream, budget); }
    let state = this.states.get(stream);
    const sameDisplay = state && Number.isInteger(observation.displayIndex) && state.displayIndex === observation.displayIndex;
    if (state && (state.context !== observation.context || state.scope !== observation.scope || state.scriptScope !== observation.scriptScope ||
      (state.currentIndex !== observation.currentIndex && !sameDisplay))) {
      this.reset(stream, 'position_or_script_changed'); state = null;
    }
    if (!state) {
      state = {pending: null, memory: new SemanticTranscript(),
        context: observation.context, scope: observation.scope, scriptScope: observation.scriptScope,
        displayIndex: observation.displayIndex, currentIndex: observation.currentIndex};
      this.states.set(stream, state);
    }
    state.currentIndex = observation.currentIndex;
    state.handlers = handlers;
    const now = this.now(), revision = state.memory.remember(observation, now);
    if (observation.textResolved || state.resolved) { this.reset(stream, 'text_resolved'); return; }
    if (!revision) return;
    if (state.pending && (now - state.pending.at > S.supportTtlMs || revision.endMs - state.pending.endMs > S.supportTtlMs))
      this.clearPending(state, 'support_expired');
    if (this.supportText(state, revision)) return;
    const reason = this.invalidReason(handlers) || state.memory.requestReason(revision) ||
      ((budget.itemRequests.get(revision.itemId) || 0) >= S.requestsPerItem ? 'item_request_limit' : null) ||
      (budget.busy ? 'request_in_flight' : now - budget.lastRequest < this.cooldownMs ? 'cooldown' : null);
    if (reason) { this.gate(state, reason, revision); return; }
    budget.lastRequest = now; budget.busy = true; state.lastGate = null;
    budget.itemRequests.set(revision.itemId, (budget.itemRequests.get(revision.itemId) || 0) + 1);
    while (budget.itemRequests.size > S.historyItems) budget.itemRequests.delete(budget.itemRequests.keys().next().value);
    state.memory.requested(revision);
    const input = state.memory.input(revision);
    const modelInput = compactInput(input);
    const requestObservation = {...observation, input: modelInput, inputId: revision.inputId, evidenceEndMs: input.evidenceEndMs};
    const meta = {inputId: revision.inputId, itemId: revision.itemId, currentIndex: observation.currentIndex,
      audioStartMs: revision.startMs, audioEndMs: revision.endMs, evidenceEndMs: input.evidenceEndMs,
      isFinal: revision.isFinal, providerStreamId: observation.streamId ?? null, asrConfidence: revision.confidence};
    handlers.record('requested', {...meta, input: modelInput, candidates: observation.candidates});
    const controller = new AbortController(); state.controller = controller;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('semantic timeout')); }, this.timeoutMs);
    });
    try {
      const result = await Promise.race([this.request(requestObservation, controller.signal), timeout]);
      const reported = result?.matches?.at(-1);
      const modelScore = reported?.matchConfidence ?? result?.confidence;
      const data = {...meta, candidateIndex: reported?.index ?? result?.index ?? null,
        confidence: Number.isFinite(modelScore) ? modelScore : null, matchConfidence: Number.isFinite(modelScore) ? modelScore : null,
        asrConfidence: revision.confidence, scoreSource: 'semantic_model', requestMs: this.now() - now};
      const stale = this.states.get(stream) !== state ? state.cancelReason || 'state_replaced'
        : this.invalidReason(handlers) || (this.now() - now > S.maximumResultAgeMs ? 'result_expired' : null)
          || (controller.signal.aborted ? 'request_cancelled' : null);
      if (stale) { handlers.record('stale', {...data, reason: stale}); return; }
      if (state.pending && (this.now() - state.pending.at > S.supportTtlMs ||
        revision.endMs - state.pending.endMs > S.supportTtlMs)) this.clearPending(state, 'support_expired');
      const selected = selectMatches(result, observation, revision);
      const match = selected.matches.at(-1);
      const reportedScore = match?.matchConfidence ?? selected.reported?.matchConfidence ?? result?.confidence;
      const proposalData = {...data, confidence: Number.isFinite(reportedScore) ? reportedScore : null,
        matchConfidence: Number.isFinite(reportedScore) ? reportedScore : null,
        asrConfidence: revision.confidence, scoreSource: 'semantic_model',
        candidateIndex: match?.index ?? selected.reported?.index ?? result?.index ?? null,
        matches: selected.matches.map(m => ({index: m.index, matchConfidence: m.matchConfidence,
          firstWordId: m.speech?.firstWordId ?? null, lastWordId: m.speech?.lastWordId ?? null})),
        legacyResponse: selected.legacy};
      if (selected.reason) {
        handlers.record('uncertain', {...proposalData, reason: selected.reason, pendingIndex: state.pending?.index ?? null}); return;
      }
      if (match.index <= observation.currentIndex) {
        handlers.record(match.index === observation.currentIndex ? 'current_support' : 'uncertain',
          {...proposalData, reason: match.index === observation.currentIndex ? 'semantic_supports_current' : 'previous_cue'});
        return;
      }
      // Two spans from one model call are not independent proof. A literal match on a
      // different, nonoverlapping word range may support the final semantic span.
      if (this.supportMappedWords(state, selected.matches, proposalData)) return;
      const prior = state.pending;
      const speech = match.speech || revision;
      const independent = prior && speech.startMs >= prior.endMs && speech.endMs > prior.endMs &&
        speech.endMs - prior.endMs <= S.supportTtlMs && this.now() - prior.at <= S.supportTtlMs &&
        (revision.itemId !== prior.itemId || (match.speech && prior.hasSpan && this.afterMappedPrefix(revision, match.speech, prior)));
      const consistent = independent && match.tier === 'high' && prior.tier === 'high' &&
        match.index > prior.index && match.index <= prior.index + S.maximumStep;
      if (consistent) {
        handlers.record('supported', {...proposalData, reason: 'independent_semantic', supportSource: 'semantic',
          proposalInputId: prior.inputId, pendingAgeMs: this.now() - prior.at});
        state.pending = null; state.resolved = true;
        handlers.accept(match, {...speech, supportSource: 'semantic', proposalInputId: prior.inputId});
      } else {
        if (prior && match.index !== prior.index) this.clearPending(state, 'proposal_replaced');
        state.pending ||= {index: match.index, itemId: revision.itemId,
          endMs: match.speech?.endMs ?? input.evidenceEndMs, hasSpan: Boolean(match.speech), tier: match.tier,
          matchConfidence: match.matchConfidence,
          prefixText: match.speech ? normalizeText(revision.text).slice(0, normalizeText(revision.text).length -
            normalizeText(alignedWords(revision).filter(w => w.id > match.speech.lastWordId).map(w => w.text).join('')).length) : '',
          inputId: revision.inputId, at: this.now()};
        handlers.record('pending', {...proposalData, reason: 'needs_independent_support', tier: state.pending.tier,
          evidenceEndMs: state.pending.endMs, proposalInputId: state.pending.inputId, pendingAgeMs: this.now() - state.pending.at});
        for (const latest of state.memory.latest()) {
          if (latest.endMs > state.pending.endMs && this.supportText(state, latest)) break;
          if (!state.pending) break;
        }
      }
    } catch (error) {
      const cancelled = this.states.get(stream) !== state || state.resolved;
      handlers.record(cancelled ? 'stale' : controller.signal.aborted ? 'timeout' : 'error', {...meta,
        reason: cancelled ? state.cancelReason || 'text_supported' : controller.signal.aborted ? 'request_timeout' : 'request_error',
        confidence: null, requestMs: this.now() - now,
        message: '語意備援未完成，持續使用文字跟戲。', statusCode: Number.isInteger(error?.status) ? error.status : null});
    } finally { clearTimeout(timer); budget.busy = false; state.controller = null; }
  }
}

module.exports = {SemanticFollower, requestSemanticCandidate};
