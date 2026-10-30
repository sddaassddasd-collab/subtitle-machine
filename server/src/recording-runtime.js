const {Worker} = require('node:worker_threads');
const path = require('node:path');
const {getRecordingAsset} = require('./persistence');
const {validSegments, recordingLines, segmentEligibility} = require('./recordings');
const {ACOUSTIC_SETTINGS: A} = require('./follow-settings');
const {toAnalysis, toPlayback} = require('./recording-timing');
const {getFollowingLines, isRecordingCompatible} = require('./performance-language');
const workerPath = path.join(__dirname, 'recording-worker.js');
const scriptSignature = session => JSON.stringify([session.transcriptionLanguage,
  getFollowingLines(session).map(line => [line.id, line.type, line.text])]);

function runRecordingTask(message, timeoutMs = 180000, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath);
    let settled = false;
    const cleanup = () => { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { cleanup(); reject(new Error('錄音處理已取消')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('錄音分析超時，請稍後再試')); }, timeoutMs);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) { abort(); return; }
    worker.once('error', error => { cleanup(); reject(error); });
    worker.once('exit', () => { if (!settled) { cleanup(); reject(new Error('錄音分析工作意外停止，請重試')); } });
    worker.once('message', result => {
      cleanup();
      if (result.type === 'error') reject(new Error(result.error)); else resolve(result);
    });
    const transfer = [];
    for (const key of ['pcm', 'features']) if (message[key]) {
      // Database PCM buffers are large, dedicated allocations. Transfer them
      // instead of doubling memory in the worker; copy tiny pooled buffers only.
      const bytes = message[key];
      const view = bytes.byteLength === bytes.buffer.byteLength && bytes.byteOffset === 0
        ? bytes : Uint8Array.from(bytes);
      message[key] = view; transfer.push(view.buffer);
    }
    try { worker.postMessage(message, transfer); }
    catch {
      try { worker.postMessage(message); }
      catch (error) { cleanup(); reject(error); }
    }
  });
}

class RecordingRuntime {
  constructor({loadAsset = getRecordingAsset, onResult, onStatus, onDiagnostic} = {}) {
    this.loadAsset = loadAsset; this.onResult = onResult; this.onStatus = onStatus; this.onDiagnostic = onDiagnostic;
    this.sessions = new Map();
  }
  async ensure(session) {
    const recording = session.recordings?.find(r => r.id === session.activeRecordingId && r.cellId === session.selectedCellId);
    if (!recording || !isRecordingCompatible(session, recording) || recording.status !== 'ready') { this.stop(session.id); return; }
    const key = `${recording.id}:${recording.revision}:${session.selectedCellId}`;
    const previous = this.sessions.get(session.id);
    if (previous?.key === key) return;
    this.stop(session.id);
    const entry = {key, revision: recording.revision, signature: scriptSignature(session), generation: 1, pending: 0,
      inFlight: 0, inFlightAudioMs: 0, queue: [], queuedAudioMs: 0, jobs: new Map(), nextJobId: 1,
      currentIndex: session.currentIndex, ready: false, recordingId: recording.id};
    this.sessions.set(session.id, entry);
    this.onStatus?.(session.id, {status: 'loading', recordingId: recording.id, name: recording.name});
    try {
      let previousDialogue = -1;
      const predecessors = recordingLines(session, recording).map((line, index) => {
        const previous = previousDialogue;
        if (line.type !== 'direction') previousDialogue = index;
        return previous;
      });
      const segments = validSegments(session, recording).map(segment => ({...segment, previousDialogueIndex: predecessors[segment.index],
        start: Math.max(0, toAnalysis(segment.start, recording.featureCalibration)),
        end: Math.min(recording.duration, toAnalysis(segment.end, recording.featureCalibration))})).filter(segment => segment.end > segment.start);
      const byLine = new Map(recording.segments.map(segment => [segment.lineId, segment]));
      const indexed = new Set(segments.map(segment => segment.index));
      entry.eligibility = recordingLines(session, recording).map((line, index) => {
        const segment = byLine.get(line.id), reason = segmentEligibility(segment, line, recording);
        return {index, lineId: line.id, status: segment?.status || 'missing', start: segment?.start ?? null, end: segment?.end ?? null,
          reason: reason === 'usable' && !indexed.has(index) ? 'outside_feature_clock' : reason};
      });
      if (!segments.length) throw new Error('尚無有效時間範圍的錄音片段，沿用文字跟戲');
      const asset = await this.loadAsset(session.id, recording.id);
      if (this.sessions.get(session.id) !== entry) return;
      if (!asset?.features) throw new Error('錄音特徵不存在，請重新匯入錄音');
      const project = (result, current = true) => ({...result,
        ...(Number.isFinite(result.referenceSeconds) ? {referenceSeconds: toPlayback(result.referenceSeconds, recording.featureCalibration)} : {}),
        ...(result.diagnostics ? {diagnostics: {...result.diagnostics,
          ...(current ? {eligibility: entry.eligibility.slice(entry.currentIndex, entry.currentIndex + (result.diagnostics.searchAhead || A.ahead) + 1)} : {}),
          candidates: result.diagnostics.candidates.map(candidate => ({...candidate,
            referenceSeconds: toPlayback(candidate.referenceSeconds, recording.featureCalibration)}))}} : {})});
      const worker = new Worker(workerPath); entry.worker = worker;
      worker.on('message', message => {
        if (this.sessions.get(session.id) !== entry) return;
        if (message.type === 'ready') { entry.ready = true; this.onStatus?.(session.id, {status: 'listening', recordingId: recording.id, name: recording.name}); }
        if (message.type === 'result') {
          const job = entry.jobs.get(message.jobId);
          if (job) {
            entry.jobs.delete(message.jobId); entry.inFlight = entry.jobs.size;
            entry.inFlightAudioMs = Math.max(0, entry.inFlightAudioMs - job.durationMs);
            if (job.generation === entry.generation) entry.pending = Math.max(0, entry.pending - job.packetCount);
          }
          if (message.generation !== entry.generation && message.result) this.onDiagnostic?.(session.id, 'audio_observation', {
            ...project(message.result, false),
            reason: 'generation_changed', generation: message.generation, activeGeneration: entry.generation,
            workerTiming: message.workerTiming});
          if (message.generation === entry.generation && message.observation) this.onDiagnostic?.(session.id, 'audio_observation', {
            ...message.observation, generation: entry.generation, workerTiming: message.workerTiming});
          if (message.generation === entry.generation && message.result) this.onResult?.(session.id, {
            ...project(message.result),
            recordingId: recording.id, revision: entry.revision, generation: entry.generation,
            workerTiming: message.workerTiming,
          });
          this.scheduleDrain(session.id, entry);
        }
        if (message.type === 'error') this.fail(session.id, entry, message.error);
      });
      worker.on('error', error => this.fail(session.id, entry, error.message));
      worker.on('exit', () => { if (entry.worker === worker) this.fail(session.id, entry, '音訊比對工作已停止，沿用文字跟戲'); });
      worker.postMessage({type: 'configure', features: asset.features, segments,
        generation: entry.generation, currentIndex: entry.currentIndex});
      this.onDiagnostic?.(session.id, 'audio_reset', {reason: 'recording_loaded', index: entry.currentIndex,
        recordingId: recording.id, generation: entry.generation, usableSegments: segments.length,
        reviewSegments: segments.filter(segment => segment.status === 'review').length, buffersPreserved: false});
    } catch (error) { this.fail(session.id, entry, error.message); }
  }
  fail(sessionId, entry, error) {
    if (this.sessions.get(sessionId) !== entry) return;
    entry.ready = false; entry.worker?.terminate(); entry.worker = null;
    this.onStatus?.(sessionId, {status: 'error', recordingId: entry.recordingId, error});
  }
  position(session, audioMs = 0, {continuous = false, reason = 'reposition', droppedInputAudioMs = 0} = {}) {
    const entry = this.sessions.get(session.id);
    if (!entry) return;
    const fromIndex = entry.currentIndex;
    const preserve = entry.ready && continuous && session.currentIndex === fromIndex + 1 &&
      (!Number.isFinite(entry.lastAudioMs) || (audioMs >= entry.lastAudioMs && audioMs - entry.lastAudioMs <= A.maxAudioGapMs));
    const pending = entry.pending;
    entry.currentIndex = session.currentIndex; entry.generation++; entry.pending = 0;
    entry.fenceMs = audioMs;
    if (!preserve) entry.lastAudioMs = audioMs;
    const droppedAudioMs = preserve ? 0 : entry.queuedAudioMs + droppedInputAudioMs;
    if (!preserve) { entry.queue = []; entry.queuedAudioMs = 0; }
    entry.queue.push({type: 'position', generation: entry.generation, currentIndex: session.currentIndex, preserve});
    this.scheduleDrain(session.id, entry);
    this.onDiagnostic?.(session.id, preserve ? 'audio_position' : 'audio_reset', {reason, fromIndex,
      index: session.currentIndex, audioMs, generation: entry.generation, pending, inFlight: entry.inFlight,
      queuedAudioMs: entry.queuedAudioMs, inFlightAudioMs: entry.inFlightAudioMs, droppedAudioMs, buffersPreserved: preserve});
  }
  hint(session, candidate, audioEndMs) {
    const entry = this.sessions.get(session.id);
    if (!entry?.ready || !candidate || candidate.index <= session.currentIndex || candidate.index > session.currentIndex + A.recoveryMaxAhead ||
      candidate.confidence < A.hintMinimumConfidence || candidate.evidence < A.hintMinimumEvidence || !Number.isFinite(audioEndMs)) return;
    entry.queue.push({type: 'search', generation: entry.generation,
      hint: {index: candidate.index, confidence: candidate.confidence, expiresAudioMs: audioEndMs + A.hintTtlMs}});
    this.scheduleDrain(session.id, entry);
  }
  scheduleDrain(sessionId, entry) {
    if (entry.drainScheduled || !entry.worker) return;
    entry.drainScheduled = setImmediate(() => {
      entry.drainScheduled = null;
      if (this.sessions.get(sessionId) === entry) this.drain(entry);
    });
  }
  drain(entry) {
    while (entry.worker && entry.queue.length) {
      const first = entry.queue[0];
      if (first.type !== 'audio') { entry.worker.postMessage(entry.queue.shift()); continue; }
      if (entry.inFlight >= A.maxInFlight) break;
      const packets = [entry.queue.shift()];
      let durationMs = first.durationMs;
      while (entry.queue[0]?.type === 'audio' && entry.queue[0].generation === first.generation &&
        entry.queue[0].currentIndex === first.currentIndex && durationMs + entry.queue[0].durationMs <= A.maxBatchMs) {
        const packet = entry.queue.shift(); packets.push(packet); durationMs += packet.durationMs;
      }
      const jobId = entry.nextJobId++;
      entry.queuedAudioMs = Math.max(0, entry.queuedAudioMs - durationMs);
      entry.jobs.set(jobId, {generation: first.generation, durationMs, packetCount: packets.length});
      entry.inFlight = entry.jobs.size; entry.inFlightAudioMs += durationMs;
      entry.worker.postMessage({type: 'audio', pcm: Buffer.concat(packets.map(packet => packet.pcm)),
        audioEndMs: packets.at(-1).audioEndMs, currentIndex: first.currentIndex, generation: first.generation,
        sequence: packets.at(-1).sequence, queuedAt: first.queuedAt, jobId});
    }
  }
  feed(session, stream, audio, audioEndMs) {
    if (!session.activeRecordingId || session.subtitleControlMode !== 'auto') return;
    void this.ensure(session);
    const entry = this.sessions.get(session.id);
    if (!entry?.ready || !entry.worker || entry.currentIndex !== session.currentIndex) return;
    const pcm = Buffer.from(audio, 'base64');
    if (!pcm.length || pcm.length % 2) return;
    const durationMs = pcm.length / 2 / A.sourceSampleRate * 1000;
    if (durationMs > A.maxBufferedAudioMs) {
      this.position(session, audioEndMs, {reason: 'worker_backpressure', droppedInputAudioMs: durationMs});
      return;
    }
    // A short arrival burst is coalesced without losing PCM. Only a genuine
    // time backlog drops buffered audio and resets the matching window.
    if (Number.isFinite(entry.lastAudioMs) && (audioEndMs - entry.lastAudioMs > A.maxAudioGapMs || audioEndMs <= entry.lastAudioMs))
      this.position(session, audioEndMs - durationMs, {reason: audioEndMs <= entry.lastAudioMs ? 'audio_clock_reset' : 'audio_gap'});
    if (entry.inFlightAudioMs + entry.queuedAudioMs + durationMs > A.maxBufferedAudioMs)
      this.position(session, audioEndMs - durationMs, {reason: 'worker_backpressure'});
    entry.lastAudioMs = audioEndMs;
    entry.pending++; entry.queuedAudioMs += durationMs;
    entry.queue.push({type: 'audio', pcm, audioEndMs, durationMs, currentIndex: session.currentIndex,
      generation: entry.generation, sequence: stream.lastCaptureSequence, queuedAt: Date.now()});
    this.scheduleDrain(session.id, entry);
  }
  accepts(sessionId, result) {
    const entry = this.sessions.get(sessionId);
    return entry?.ready && entry.generation === result.generation && entry.recordingId === result.recordingId;
  }
  sync(session) {
    const entry = this.sessions.get(session.id);
    if (!entry) return;
    if (session.subtitleControlMode !== 'auto' || session.status === 'ended' ||
      entry.recordingId !== session.activeRecordingId ||
      !isRecordingCompatible(session, session.recordings.find(recording => recording.id === entry.recordingId) || {}) ||
      entry.signature !== scriptSignature(session)) this.stop(session.id);
    else if (entry.currentIndex !== session.currentIndex) this.position(session);
  }
  invalidate(sessionId) { this.stop(sessionId); }
  stop(sessionId) {
    const entry = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (entry?.drainScheduled) clearImmediate(entry.drainScheduled);
    entry?.worker?.terminate();
  }
  dispose() { for (const sessionId of this.sessions.keys()) this.stop(sessionId); }
}
module.exports = {RecordingRuntime, runRecordingTask};
