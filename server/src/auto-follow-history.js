const crypto = require('node:crypto');
const storage = require('./persistence');
const {getFollowingLines, resolveFollowingLanguage, isRecordingCompatible} = require('./performance-language');
const {isUsableSegment} = require('./recordings');

function historyContext(session) {
  const lines = getFollowingLines(session);
  const recording = session.recordings?.find(item => item.id === session.activeRecordingId);
  const compatible = recording && isRecordingCompatible(session, recording);
  const segments = new Map((recording?.segments || []).map(segment => [segment.lineId, segment]));
  const following = resolveFollowingLanguage(session);
  const context = {
    cellId: session.selectedCellId, cellName: session.cells?.find(cell => cell.id === session.selectedCellId)?.name || '',
    language: following.language, languageId: following.languageId,
    recording: recording ? {id: recording.id, name: recording.name, revision: recording.revision,
      compatible: Boolean(compatible), ready: recording.status === 'ready',
      timeCalibration: recording.timeCalibration || null, featureCalibration: recording.featureCalibration || null} : null,
    lines: lines.map((line, index) => {
      const segment = segments.get(line.id);
      return {id: line.id, index, text: String(line.text || ''), type: line.type || 'dialogue', role: line.role || '',
        reference: {status: segment?.status || 'unmatched',
          usable: Boolean(compatible && recording.status === 'ready' && isUsableSegment(segment || {}, line)),
          start: Number.isFinite(segment?.start) ? segment.start : null,
          end: Number.isFinite(segment?.end) ? segment.end : null}};
    }),
  };
  return {...context, signature: crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex')};
}

// Callers never await history on the realtime audio path. Producers are ordered;
// small atomic database batches run separately and retain their payload on error.
class AutoFollowHistory {
  constructor({store = storage, now = Date.now, flushMs = 250, maxPending = 5000, onError = console.error} = {}) {
    this.store = store; this.now = now; this.flushMs = flushMs; this.maxPending = maxPending; this.onError = onError;
    this.entries = new Map();
  }
  entry(sessionId) {
    if (!this.entries.has(sessionId)) this.entries.set(sessionId, {
      tail: Promise.resolve(), loaded: false, run: null, context: null, pending: [], timer: null,
      error: '', lost: 0, diagnosticGate: new Map(), confirmGate: new Map(), enabled: false, queued: 0,
    });
    return this.entries.get(sessionId);
  }
  queue(sessionId, work, {background = false} = {}) {
    const entry = this.entry(sessionId);
    if (background && entry.queued >= this.maxPending) {
      entry.lost++; entry.error = '歷程待保存資料過多，部分事件未記錄';
      return Promise.resolve();
    }
    entry.queued++;
    const task = entry.tail.then(async () => {
      if (!entry.loaded) {
        const previous = await this.store.getOpenFollowRun(sessionId);
        entry.run = previous?.run || null; entry.context = previous?.context || null; entry.loaded = true;
        if (entry.run) this.append(entry, 'interruption', {reason: 'server_restarted',
          message: '服務重新啟動；從上次保存至恢復收音之間的紀錄不完整。'});
      }
      return work(entry);
    });
    entry.tail = task.catch(error => {
      if (error.status >= 400 && error.status < 500) return;
      entry.error = '跟戲歷程保存失敗，正在重試';
      this.onError('Auto-follow history:', error.message);
      this.schedule(sessionId, entry, 1000);
    }).finally(() => { entry.queued--; });
    return task;
  }
  schedule(sessionId, entry, delay = this.flushMs) {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.flush(sessionId).catch(() => {});
    }, delay);
    entry.timer.unref?.();
  }
  append(entry, type, data = {}) {
    if (!entry.run || entry.run.endedAt !== null) return null;
    if (entry.pending.length >= this.maxPending) {
      entry.lost++; entry.error = '歷程待保存資料過多，部分事件未記錄'; return null;
    }
    const at = this.now();
    const event = {...data, id: crypto.randomUUID(), type, at, sequence: entry.run.nextSequence++,
      contextId: data.contextId || entry.context?.contextId || null};
    entry.run.updatedAt = at;
    entry.pending.push(event);
    this.schedule(entry.run.sessionId, entry);
    return event;
  }
  visit(entry, index, source, data = {}) {
    if (!entry.context?.lines[index]) return;
    const visitId = crypto.randomUUID();
    const event = this.append(entry, 'cue_enter', {index, lineId: entry.context.lines[index].id, source, visitId, ...data});
    if (event) entry.run.cursor = {contextId: entry.context.contextId, index, visitId};
    entry.confirmGate.clear();
  }
  context(entry, context, index) {
    if (entry.context?.signature === context.signature) return;
    const contextId = crypto.randomUUID();
    const event = this.append(entry, 'context', {...context, contextId});
    if (!event) return;
    entry.context = event;
    this.visit(entry, index, 'context');
  }
  start(session, {fresh = false} = {}) {
    const context = historyContext(session), index = session.currentIndex;
    const sessionId = session.id, name = String(session.name || session.title || '未命名節目');
    const entry = this.entry(sessionId); entry.enabled = true;
    if (fresh || !entry.run || entry.requestedSignature !== context.signature) entry.confirmGate.clear();
    entry.requestedSignature = context.signature;
    return this.queue(sessionId, async entry => {
      if (entry.run?.endedAt != null) await this.flushEntry(entry);
      if (fresh && entry.run) await this.finishEntry(entry, 'new_run');
      if (!entry.run) {
        const at = this.now();
        entry.run = {id: crypto.randomUUID(), sessionId, name, startedAt: at, updatedAt: at,
          endedAt: null, nextSequence: 1, cursor: null};
        entry.context = null; entry.transport = null; entry.lastPacket = null;
        this.append(entry, 'run_start');
        this.context(entry, context, index);
        // Initial display is a position, not an automatic trigger.
        const initial = entry.pending.at(-1);
        if (initial?.type === 'cue_enter') initial.source = 'initial';
      } else {
        this.context(entry, context, index);
        if (entry.run.cursor?.index !== index) this.visit(entry, index, 'resume');
      }
      return entry.run.id;
    });
  }
  restore(session) {
    const context = historyContext(session), index = session.currentIndex;
    return this.queue(session.id, entry => {
      if (!entry.run) return null;
      entry.enabled = true; entry.requestedSignature = context.signature;
      this.context(entry, context, index);
      if (entry.run.cursor?.index !== index) this.visit(entry, index, 'resume');
      return entry.run.id;
    });
  }
  sync(session) {
    if (!this.entries.has(session.id)) return;
    const context = historyContext(session), index = session.currentIndex;
    const entry = this.entry(session.id);
    if (entry.requestedSignature !== context.signature) entry.confirmGate.clear();
    entry.requestedSignature = context.signature;
    return this.queue(session.id, entry => { if (entry.run) this.context(entry, context, index); }, {background: true});
  }
  enter(session, index, data) {
    if (!this.entries.has(session.id)) return;
    const fromIndex = session.currentIndex;
    this.entry(session.id).confirmGate.clear();
    return this.queue(session.id, entry => {
      if (!entry.run) return;
      this.visit(entry, index, data.source, {fromIndex, ...data});
    }, {background: true});
  }
  confirm(sessionId, index, source, data = {}) {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    const key = `${index}:${source}:${data.providerStreamId || ''}:${data.itemId || ''}`, completed = data.completed === true;
    if (entry.confirmGate.has(key) && (!completed || entry.confirmGate.get(key))) return;
    entry.confirmGate.set(key, completed);
    if (entry.confirmGate.size > 256) entry.confirmGate.delete(entry.confirmGate.keys().next().value);
    return this.queue(sessionId, entry => {
      if (!entry.run || entry.run.cursor?.index !== index) return;
      this.append(entry, 'cue_confirm', {index, source, visitId: entry.run.cursor.visitId, ...data});
    }, {background: true});
  }
  diagnostic(sessionId, lane, reason, data = {}) {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    const now = this.now(), previous = entry.diagnosticGate.get(lane);
    if (previous && now - previous.at < 5000) return;
    entry.diagnosticGate.set(lane, {at: now});
    return this.queue(sessionId, entry => {
      if (!entry.run) return;
      this.append(entry, 'diagnostic', {lane, reason, index: entry.run.cursor?.index, ...data});
    }, {background: true});
  }
  event(sessionId, type, data = {}) {
    if (!this.entries.has(sessionId)) return;
    return this.queue(sessionId, entry => this.append(entry, type, data), {background: true});
  }
  transport(sessionId, status, data = {}) {
    if (!this.entries.has(sessionId)) return;
    return this.queue(sessionId, entry => {
      if (!entry.run) return;
      const key = `${status}:${data.streamId || ''}`;
      if (entry.transport === key) return;
      entry.transport = key; entry.lastPacket = null;
      this.append(entry, 'capture_status', {status, ...data});
    }, {background: true});
  }
  audio(sessionId, streamId, audioMs) {
    const entry = this.entries.get(sessionId);
    if (!entry?.enabled) return;
    const at = this.now(), previous = entry.lastPacket;
    entry.lastPacket = {at, streamId};
    if (previous && previous.streamId === streamId && at - previous.at < 2000) return;
    return this.queue(sessionId, entry => {
      if (!entry.run) return;
      this.append(entry, 'capture_audio', {streamId, audioMs,
        gapStartedAt: previous?.at || null, gapMs: previous ? at - previous.at : null});
    }, {background: true});
  }
  async flushEntry(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (!entry.run || !entry.pending.length) return;
    const batch = entry.pending.slice();
    await this.store.saveFollowHistory(structuredClone(entry.run), batch);
    entry.pending.splice(0, batch.length); entry.error = '';
    if (entry.run.endedAt !== null) {
      entry.run = null; entry.context = null; entry.confirmGate.clear();
      return;
    }
    if (entry.lost) {
      const count = entry.lost; entry.lost = 0;
      this.append(entry, 'logging_gap', {count, message: '保存中斷期間有事件未記錄，不能據此判定漏格。'});
    }
  }
  flush(sessionId) {
    return this.queue(sessionId, async entry => {
      do { await this.flushEntry(entry); } while (entry.run && entry.pending.length);
    });
  }
  async finishEntry(entry, reason) {
    if (!entry.run) return;
    if (entry.lost || entry.pending.length >= this.maxPending) {
      await this.flushEntry(entry);
      if (entry.pending.length) await this.flushEntry(entry);
    }
    this.append(entry, 'run_end', {reason});
    entry.run.endedAt = this.now(); entry.run.endReason = reason;
    await this.flushEntry(entry);
    entry.run = null; entry.context = null; entry.confirmGate.clear();
  }
  end(sessionId, reason = 'user_finished', runId = null) {
    const entry = this.entry(sessionId); entry.enabled = false;
    return this.queue(sessionId, entry => {
      if (runId && entry.run?.id !== runId) throw Object.assign(new Error('本次紀錄已結束或已切換，請重新整理'), {status: 409});
      return this.finishEntry(entry, reason);
    });
  }
  async list(sessionId, limit, offset) {
    await this.flush(sessionId);
    return this.store.listFollowRuns(sessionId, limit, offset);
  }
  async read(sessionId, runId) {
    await this.flush(sessionId);
    return this.store.getFollowRun(sessionId, runId);
  }
  status(sessionId) {
    const entry = this.entries.get(sessionId);
    return {runId: entry?.run?.id || null, error: entry?.error || '',
      pending: (entry?.pending.length || 0) + (entry?.queued || 0), lost: entry?.lost || 0};
  }
  async remove(sessionId, runId = null) {
    return this.queue(sessionId, async entry => {
      if (runId && entry.run?.id === runId) throw Object.assign(new Error('請先結束本次紀錄再刪除'), {status: 409});
      if (!runId) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        entry.pending = []; entry.run = null; entry.context = null; entry.enabled = false;
      }
      await this.store.deleteFollowHistory(sessionId, runId);
    });
  }
  async close() {
    await Promise.all([...this.entries.keys()].map(id => this.queue(id, async entry => {
      if (entry.run) this.append(entry, 'interruption', {reason: 'server_shutdown', message: '服務停止，等待恢復收音。'});
      await this.flushEntry(entry);
    })));
  }
}

module.exports = {AutoFollowHistory, historyContext};
