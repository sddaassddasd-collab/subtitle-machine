import {CaptureTransport, CAPTURE_TRANSPORT_LIMITS as T, connectCaptureSocket} from './capture-transport.js'
import {signalMetrics} from './audio-signal.js'
import {AUDIO_WIRE} from './capture-wire.mjs'

export const PIPELINE_SETTINGS = Object.freeze({version: 3, sampleRate: 24000, maximumAgeMs: 10000,
  maximumQueuedMs: 8000, overflowRetainMs: 1000, startupRetainMs: 1000,
  backlogMs: 4000, backlogRecoveryMs: 3000, reportMs: 500, sampleGapMs: 3000, retryBaseMs: 1000, retryMaxMs: 12000})

// Keep the fractional sample position across batches (including 44.1 kHz input).
// Input time and provider time are distinct; dropped input is never counted as
// audio already sent to the provider.
export class PcmResampler {
  constructor(inputRate) {this.rate = inputRate; this.input = 0; this.output = 0; this.previous = 0}
  convert(samples) {
    const end = this.input + samples.length
    const count = Math.round(end * PIPELINE_SETTINGS.sampleRate / this.rate) - this.output
    const pcm = new Int16Array(count)
    for (let i = 0; i < count; i++) {
      const at = (this.output + i) * this.rate / PIPELINE_SETTINGS.sampleRate - this.input
      const left = Math.floor(at), fraction = at - left
      const a = left < 0 ? this.previous : samples[Math.min(left, samples.length - 1)]
      const b = samples[Math.max(0, Math.min(left + 1, samples.length - 1))]
      const sample = Math.max(-1, Math.min(1, a + (b - a) * fraction))
      pcm[i] = Math.round(sample * (sample < 0 ? 32768 : 32767))
    }
    this.input = end; this.output += count; this.previous = samples.at(-1) || 0
    return pcm
  }
}

// Runs in a dedicated Worker. It owns network/provider epochs, never microphone
// tracks or AudioContexts. Replacing a connection cannot stop local capture.
export class CapturePipeline {
  constructor({createSocket, notify, now = Date.now, timers = globalThis} = {}) {
    this.createSocket = createSocket; this.notify = notify; this.now = now; this.timers = timers
    this.queue = []; this.queuedMs = 0; this.attempt = 0; this.epoch = 0; this.ready = false
  }
  report(reason, data = {}) {this.notify?.({type: 'report', reason, captureId: this.captureId || '', sourceId: this.config?.sourceId || '', occurredAt: this.now(), ...data})}
  state(status, message = '') {this.notify?.({type: 'state', status, message, captureId: this.captureId || ''})}
  start(config) {
    this.config = config; this.report('capture_pipeline_settings', PIPELINE_SETTINGS); this.desired = true; this.clock = config.clock
    this.resampler = new PcmResampler(config.inputRate)
    this.generation = config.clientInfo.captureGeneration
    this.generatedAudioMs = 0; this.droppedAudioMs = 0; this.nextProgressAt = 0
    this.lastSampleAt = this.now(); this.nextReportAt = 0
    this.timer = this.timers.setInterval(() => this.tick(), 100)
    void this.connect(true)
  }
  setClock(clock) {this.clock = clock; this.sampleWarning = false}
  setControlSocketId(controlSocketId) {
    this.config.clientInfo.controlSocketId = controlSocketId
    if (this.socket?.connected) this.socket.emit('transcription:control-link', {
      sessionId: this.config.request.sessionId, captureId: this.captureId, controlSocketId,
    })
  }
  async connect(replaceSocket = false) {
    if (!this.desired || this.connecting) return
    this.connecting = true; this.ready = false; const epoch = ++this.epoch
    this.transport?.close()
    if (replaceSocket || !this.socket?.connected) {
      this.socket?.disconnect()
      this.socket = this.createSocket()
      const socket = this.socket
      socket.on('disconnect', () => {
        if (this.desired && !this.connecting && this.socket === socket) this.recover('capture_transport_disconnected', 'transport')
      })
      socket.on('control:capture-health', data => {
        if (data?.captureId === this.captureId && data.recoverable && data.reason !== 'capture_stalled')
          this.recover(data.reason, data.reason?.startsWith('capture_transport') ? 'transport' : 'provider')
      })
    }
    this.captureId = `${this.config.sourceId}:${++this.generation}`
    this.backlogSince = null
    this.sequence = 0; this.firstReceipt = false; this.failedProbes = 0; this.probeAt = 0
    this.droppedSince = null; this.probePending = null
    this.notify?.({type: 'epoch', captureId: this.captureId, generation: this.generation, sourceId: this.config.sourceId})
    this.state('connecting', '本機持續收音，正在建立辨識連線。')
    try {
      const socket = this.socket
      await connectCaptureSocket(socket, () => !this.desired || epoch !== this.epoch)
      if (!this.desired || epoch !== this.epoch) return
      this.transport = new CaptureTransport(socket, {
        now: this.now,
        onBlocked: reason => {
          if (['invalid_pcm_packet', 'invalid_source_clock', 'invalid_audio_wire', 'session_not_allowed', 'missing_session'].includes(reason)) {
            this.state('fatal', '音訊輸入格式或授權無效，請重新整理後檢查設定。'); this.stop(); return
          }
          this.recover(reason, reason.startsWith('capture_transport') ? 'transport' : 'provider')
        },
        onReport: data => {
          this.report(data.reason, {...data, queuedAudioMs: this.queuedMs,
            oldestQueuedAgeMs: this.queue.length ? Math.max(0, this.now() - this.queue[0].capturedAt) : 0})
          if (data.reason === 'capture_transport_recovered' && this.firstReceipt && this.droppedSince === null)
            this.state('running', '音訊傳輸已恢復，辨識持續進行。')
        },
        onAck: ack => {
          if (ack.ok && ack.dropped && !ack.queued) {
            if (this.droppedSince === null) {
              this.droppedSince = this.now()
              this.state('delayed', '音訊抵達過晚，已略過過期片段；本機持續收音，字幕保留。')
              this.report('capture_input_discarding', {serverNetworkAgeMs: ack.networkAgeMs})
            }
          } else if (ack.ok && !ack.queued && !ack.ignored) {
            if (this.droppedSince !== null) {
              this.report('capture_input_recovered', {delayedForMs: this.now() - this.droppedSince})
              this.state('running', '已恢復接收即時音訊。')
            }
            this.droppedSince = null
          }
          if (this.now() >= (this.receiptReportAt || 0)) {
            this.receiptReportAt = this.now() + PIPELINE_SETTINGS.reportMs
            this.notify?.({type: 'receipt', ...ack})
          }
          if (ack.ok && !ack.dropped && !ack.queued && !ack.ignored && !this.firstReceipt) {
            this.firstReceipt = true; this.stableAt = this.now()
            this.state('running', '收音與辨識已連線。')
            this.report('capture_client_ready', {attempt: this.attempt})
          }
        },
      })
      const result = await new Promise((resolve, reject) => socket.timeout(10000).emit('transcription:start', {
        ...this.config.request, preserveTextOnRestart: this.config.request.preserveTextOnRestart || this.generation > this.config.clientInfo.captureGeneration + 1,
        clientInfo: {...this.config.clientInfo, captureId: this.captureId, captureGeneration: this.generation,
          audioWire: AUDIO_WIRE,
          sourceId: this.config.sourceId, audioChannel: 'worker-binary-v2', captureClock: 'audio-thread-v2',
          captureTransport: {...T, ...this.transport.details()}},
      }, (error, response) => error ? reject(new Error('辨識服務連線逾時')) : resolve(response)))
      if (!this.desired || epoch !== this.epoch) return
      if (result?.ok !== true) {
        // Configuration/authentication/ownership failures require operator action.
        if (result?.recoverable !== true && result?.reason && !['transcription_stopped', 'transcription_not_running'].includes(result.reason)) {
          this.desired = false; this.state('fatal', result.reason); this.stop(); return
        }
        throw new Error(result?.reason || '辨識服務尚未就緒')
      }
      this.ready = true; this.connecting = false
      if (result.audioWire === AUDIO_WIRE) this.transport.packedEpoch = this.generation
      this.report('capture_transport_ready', {...this.transport.details()})
      // Keep the last second of startup speech. During an established stream,
      // retain continuous PCM through ordinary receipt/transport jitter.
      this.trimQueue(PIPELINE_SETTINGS.startupRetainMs, 'reconnect_trim')
      this.recoveryReadyAt = this.now(); this.recoverySnapshots = new Set()
      this.report('capture_recovery_ready', {recoveryAt: this.recoveryAt || 0, retainedAudioMs: this.queuedMs, droppedAudioMs: this.droppedAudioMs})
      this.drain()
    } catch (error) {
      if (!this.desired || epoch !== this.epoch) return
      this.connecting = false
      this.report('capture_setup_failed', {message: error.message})
      this.schedule('capture_connection_failed', !this.socket?.connected ? 'transport' : 'provider')
    }
  }
  recover(reason, scope = 'provider') {
    if (!this.desired || this.retryAt) return
    // A provider may be reconnecting itself; its control snapshot is not a
    // request to rebuild the microphone or its transport.
    this.recoveryAt = this.now()
    this.report('capture_recovery_before', {cause: reason, stage: scope, queuedAudioMs: this.queuedMs,
      generatedAudioMs: this.generatedAudioMs, droppedAudioMs: this.droppedAudioMs, ...this.transport?.details()})
    this.epoch++; this.connecting = false; this.ready = false; this.transport?.close()
    this.schedule(reason, scope)
  }
  schedule(reason, scope) {
    if (!this.desired || this.retryAt) return
    if (this.stableAt && this.now() - this.stableAt >= 30000) this.attempt = 0
    this.stableAt = null; this.retryScope = scope
    const retryAfterMs = Math.min(PIPELINE_SETTINGS.retryBaseMs * 2 ** Math.min(this.attempt++, 4), PIPELINE_SETTINGS.retryMaxMs)
    this.retryAt = this.now() + retryAfterMs
    this.report('connection_retry_scheduled', {cause: reason, stage: scope, attempt: this.attempt, retryAfterMs})
    this.state('reconnecting', '本機持續收音，字幕保留；正在連接辨識服務。')
  }
  receive(frame) {
    if (!this.desired || !(frame?.samples instanceof Float32Array) || !frame.samples.length || !Number.isFinite(frame.endTime)) return
    const now = this.now(); this.lastSampleAt = now; this.sampleWarning = false
    const pcm = this.resampler.convert(frame.samples), durationMs = pcm.byteLength / 48
    // Worklet posting time measures the direct-port queue delay without treating
    // a hardware sample clock's long-run drift or suspension as stale audio.
    const generatedAt = Number.isFinite(frame.postedAt) ? frame.postedAt
      : this.clock.wallTime + (frame.endTime - this.clock.contextTime) * 1000
    this.generatedAudioMs += durationMs
    const ageMs = Math.max(0, now - generatedAt)
    const metrics = signalMetrics(frame.samples)
    if (now >= this.nextReportAt) {
      this.nextReportAt = now + PIPELINE_SETTINGS.reportMs
      this.notify?.({type: 'level', level: metrics.level, captureAgeMs: ageMs, at: now})
    }
    if (ageMs > PIPELINE_SETTINGS.maximumAgeMs) {
      this.recordDrop({sourceStartMs: frame.endTime * 1000 - durationMs, sourceEndMs: frame.endTime * 1000, durationMs}, 'source_expired')
      return
    }
    const packet = {sessionId: this.config.request.sessionId, pcm: pcm.buffer, durationMs, level: metrics.level,
      sourceId: this.config.sourceId, sourceStartMs: frame.endTime * 1000 - frame.samples.length / this.config.inputRate * 1000,
      sourceEndMs: frame.endTime * 1000, queuedAt: now, capturedAt: now - ageMs, captureAgeMs: ageMs, quality: metrics}
    this.queue.push(packet); this.queuedMs += durationMs
    // If a prolonged outage exceeds the finite buffer, skip one old block and
    // resume a coherent stretch. Dropping 40 ms on every ACK destroyed speech.
    if (this.queuedMs > PIPELINE_SETTINGS.maximumQueuedMs)
      this.trimQueue(PIPELINE_SETTINGS.overflowRetainMs, 'queue_overflow')
    this.drain()
  }
  recordDrop(packet, cause) {
    this.droppedMs = (this.droppedMs || 0) + packet.durationMs
    this.droppedAudioMs = (this.droppedAudioMs || 0) + packet.durationMs
    this.report('capture_drop_range', {cause, sourceId: this.config.sourceId,
      sourceStartMs: packet.sourceStartMs, sourceEndMs: packet.sourceEndMs,
      droppedInputMs: packet.durationMs, droppedAudioMs: this.droppedAudioMs})
  }
  trimQueue(retainMs, cause = 'queue_trim') {
    let first, last, durationMs = 0
    while (this.queuedMs > retainMs && this.queue.length) {
      const dropped = this.queue.shift(); this.queuedMs -= dropped.durationMs
      first ??= dropped; last = dropped; durationMs += dropped.durationMs
    }
    if (first) this.recordDrop({sourceStartMs: first.sourceStartMs, sourceEndMs: last.sourceEndMs, durationMs}, cause)
  }
  drain() {
    if (!this.ready || !this.desired || !this.transport) return
    while (this.queue.length) {
      let packet = this.queue[0], count = 1
      const age = this.now() - packet.capturedAt
      if (age > PIPELINE_SETTINGS.maximumAgeMs) {
        this.queue.shift(); this.queuedMs -= packet.durationMs; this.recordDrop(packet, 'queue_expired'); continue
      }
      if (this.transport.packedEpoch !== undefined) {
        const next = this.queue[1]
        if (!next && age < 80) return
        if (next && Math.abs(next.sourceStartMs - packet.sourceEndMs) < 1 && packet.durationMs + next.durationMs <= 100) {
          const pcm = new Uint8Array(packet.pcm.byteLength + next.pcm.byteLength)
          pcm.set(new Uint8Array(packet.pcm)); pcm.set(new Uint8Array(next.pcm), packet.pcm.byteLength)
          packet = {...packet, pcm: pcm.buffer, durationMs: packet.durationMs + next.durationMs, sourceEndMs: next.sourceEndMs}
          count = 2
        }
      }
      if (!this.transport.send({...packet, sequence: this.sequence + 1, captureId: this.captureId,
        captureAgeMs: Math.max(packet.captureAgeMs, age), droppedInputMs: this.droppedMs || 0})) return
      this.sequence++; this.queue.splice(0, count); this.queuedMs -= packet.durationMs
      if (this.droppedMs) {this.report('capture_input_gap', {droppedInputMs: this.droppedMs, sourceStartMs: packet.sourceStartMs}); this.droppedMs = 0}
    }
  }
  tick() {
    if (!this.desired) return
    const now = this.now()
    if (now >= this.nextProgressAt) {
      this.nextProgressAt = now + 1000
      this.report('capture_progress', {generatedAudioMs: this.generatedAudioMs, droppedAudioMs: this.droppedAudioMs,
        queuedAudioMs: this.queuedMs, ...this.transport?.details()})
    }
    if (this.ready && this.recoveryReadyAt !== undefined) for (const seconds of [5, 10]) {
      if (now - this.recoveryReadyAt >= seconds * 1000 && !this.recoverySnapshots.has(seconds)) {
        this.recoverySnapshots.add(seconds)
        this.report('capture_recovery_after', {recoveryAt: this.recoveryAt || 0, recoveryElapsedMs: seconds * 1000,
          generatedAudioMs: this.generatedAudioMs, droppedAudioMs: this.droppedAudioMs,
          queuedAudioMs: this.queuedMs, ...this.transport?.details()})
      }
    }
    if (this.retryAt && now >= this.retryAt) {
      const transport = this.retryScope === 'transport'; this.retryAt = 0
      void this.connect(transport)
    }
    if (now - this.lastSampleAt > PIPELINE_SETTINGS.sampleGapMs && !this.sampleWarning) {
      this.sampleWarning = true
      this.report('capture_source_stalled', {sampleAgeMs: now - this.lastSampleAt})
      this.notify?.({type: 'source-stalled'})
    }
    if (!this.ready || !this.transport || !this.socket?.connected) return
    this.transport.check(); this.drain()
    // ACKs can keep arriving while upload throughput remains below real time.
    // A successful probe alone cannot repair that growing queue.
    if (this.queuedMs >= PIPELINE_SETTINGS.backlogMs) {
      this.backlogSince ??= now
      if (now - this.backlogSince >= PIPELINE_SETTINGS.backlogRecoveryMs) {
        this.report('capture_backlog_recovery', {queuedAudioMs: this.queuedMs,
          ...this.transport.details()})
        this.recover('capture_transport_backlog', 'transport')
        return
      }
    } else this.backlogSince = null
    if (!this.ready || now < this.probeAt || this.probePending) return
    const progress = this.transport.details()
    if (progress.lastAckAgeMs < T.acknowledgementMs && progress.outstandingAudioMs < T.probeThresholdMs) return
    this.probeAt = now + T.probeMs; const epoch = this.epoch
    this.probePending = epoch
    this.socket.timeout(2000).emit('transcription:capture-probe', {
      sessionId: this.config.request.sessionId, captureId: this.captureId,
    }, (error, data) => {
      if (this.probePending === epoch) this.probePending = null
      if (!this.desired || epoch !== this.epoch) return
      if (error) {
        this.failedProbes++
        if (this.failedProbes >= 2 && this.transport.details().lastAckAgeMs >= T.unresponsiveMs)
          this.recover('capture_transport_unresponsive', 'transport')
      } else if (!data?.ok) this.recover('provider_not_running', 'provider')
      else {
        this.failedProbes = 0
        if (data.sequence > 0) this.transport.acknowledge(data)
        this.report('capture_progress_probe', {serverAudioMs: data.serverAudioMs, sequence: data.sequence})
      }
    })
  }
  stop({preserveText = true} = {}) {
    this.desired = false; this.epoch++; this.retryAt = 0; this.ready = false
    this.timers.clearInterval(this.timer)
    this.socket?.emit('transcription:stop', {sessionId: this.config?.request.sessionId, captureId: this.captureId, preserveText})
    this.transport?.close(); this.socket?.disconnect(); this.queue = []; this.queuedMs = 0
  }
}
