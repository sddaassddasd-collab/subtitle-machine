import {encodeAudioPacket} from './capture-wire.mjs'

export const CAPTURE_TRANSPORT_LIMITS = Object.freeze({version: 7, maximumAdaptiveOutstandingMs: 12000, progressStallMs: 20000, maximumInFlightMs: 4000,
  acknowledgementMs: 4000, delayedAckMs: 1000, maximumBufferedBytes: 65536, maximumQueuedPackets: 64,
  congestionMs: 2000, probeMs: 2000, probeThresholdMs: 2000, maximumOutstandingAudioMs: 4000, unresponsiveMs: 10000,
  reportMs: 5000, reconnectMs: 8000, packetMs: 40, cumulativeAckMs: 100})

export function socketTransportDetails(socket) {
  const engine = socket?.io?.engine, queue = engine?.writeBuffer || []
  return {transportType: engine?.transport?.name || 'unknown',
    engineQueuedPackets: queue.length,
    engineQueuedBytes: queue.slice(0, CAPTURE_TRANSPORT_LIMITS.maximumQueuedPackets + 1)
      .reduce((size, packet) => size + (typeof packet.data === 'string' ? packet.data.length : packet.data?.byteLength || 0), 0),
    webSocketBufferedBytes: engine?.transport?.ws?.bufferedAmount || 0}
}

// Pending records contain receipt metadata, not PCM. A slow receipt does not
// prove that audio is still queued for sending. Bound the real send buffers
// separately and allow transient round-trip delays without restarting ASR.
export class CaptureTransport {
  constructor(socket, {onAck, onBlocked, onReport, now = () => performance.now()} = {}) {
    this.socket = socket; this.onAck = onAck; this.onBlocked = onBlocked; this.onReport = onReport; this.now = now
    this.pending = new Map(); this.audioMs = 0; this.sentPackets = 0; this.acknowledgedPackets = 0
    this.maxRttMs = 0; this.rttMs = 0; this.reportAt = now(); this.closed = false; this.blocked = false
    this.lastAckAt = null; this.serverNetworkAgeMs = null; this.serverAudioMs = null; this.serverAckDelayMs = null
    this.createdAt = now(); this.lastSequence = 0; this.lastAckSequence = 0; this.expiredReceipts = 0
    this.totalAudioMs = 0; this.acknowledgedAudioMs = 0; this.wireBytes = 0; this.pcmBytes = 0
    this.uploadWindowMs = CAPTURE_TRANSPORT_LIMITS.maximumOutstandingAudioMs
    this.creditEnds = new Map()
    this.receiveAck = ack => this.acknowledge(ack)
    socket.on('transcription:audio-ack', this.receiveAck)
  }
  details(now = this.now()) {
    const first = this.pending.values().next().value
    return {transportVersion: CAPTURE_TRANSPORT_LIMITS.version, ...socketTransportDetails(this.socket),
      inFlightPackets: this.pending.size, inFlightAudioMs: this.audioMs,
      oldestAckAgeMs: first ? Math.max(0, now - first.at) : 0,
      lastAckAgeMs: Math.max(0, now - (this.lastAckAt ?? this.firstSentAt ?? now)), expiredReceipts: this.expiredReceipts,
      serverNetworkAgeMs: this.serverNetworkAgeMs, serverAudioMs: this.serverAudioMs, serverAckDelayMs: this.serverAckDelayMs,
      rttMs: this.rttMs, maxRttMs: this.maxRttMs,
      sentPackets: this.sentPackets, acknowledgedPackets: this.acknowledgedPackets,
      uploadWindowMs: this.uploadWindowMs, sentAudioMs: this.totalAudioMs, receivedAudioMs: this.receivedAudioMs,
      providerSubmittedAudioMs: this.providerSubmittedAudioMs, recognizedAudioMs: this.recognizedAudioMs,
      outstandingAudioMs: Math.max(0, this.totalAudioMs - this.acknowledgedAudioMs), wireBytes: this.wireBytes, pcmBytes: this.pcmBytes}
  }
  check() {
    if (this.closed || this.blocked) return false
    const now = this.now(), details = this.details(now)
    if (!this.socket.connected) return this.block('capture_transport_disconnected', details)
    const congested = details.engineQueuedPackets >= CAPTURE_TRANSPORT_LIMITS.maximumQueuedPackets ||
      details.engineQueuedBytes + details.webSocketBufferedBytes >= CAPTURE_TRANSPORT_LIMITS.maximumBufferedBytes
    if (congested) {
      if (this.congestedAt === undefined) {
        this.congestedAt = now
        this.onReport?.({reason: 'capture_transport_congested', ...details})
      }
      if (now - this.congestedAt >= CAPTURE_TRANSPORT_LIMITS.congestionMs &&
        now - (this.lastAckAt ?? this.firstSentAt ?? this.createdAt) >= CAPTURE_TRANSPORT_LIMITS.progressStallMs)
        return this.block('capture_transport_backlog', details)
      return false
    }
    this.congestedAt = undefined
    // Expiring diagnostic observations does not restart capture. Outstanding
    // upload credit remains accounted separately until reception is confirmed.
    for (const [sequence, record] of this.pending) {
      if (now - record.at < CAPTURE_TRANSPORT_LIMITS.acknowledgementMs) break
      this.pending.delete(sequence); this.audioMs -= record.durationMs; this.expiredReceipts++
    }
    this.reportDelay(now)
    if (now - this.reportAt >= CAPTURE_TRANSPORT_LIMITS.reportMs) {
      this.reportAt = now; this.onReport?.({reason: 'capture_transport', ...details})
    }
    return true
  }
  reportDelay(now = this.now()) {
    if (this.closed || this.blocked) return
    const details = this.details(now)
    const recentReceipt = this.rttSampleAt !== undefined && now - this.rttSampleAt < CAPTURE_TRANSPORT_LIMITS.acknowledgementMs
    const recentNetworkSample = this.networkSampleAt !== undefined && now - this.networkSampleAt < CAPTURE_TRANSPORT_LIMITS.acknowledgementMs
    const delayed = details.oldestAckAgeMs >= CAPTURE_TRANSPORT_LIMITS.delayedAckMs ||
      (this.lastSequence > this.lastAckSequence && details.lastAckAgeMs >= CAPTURE_TRANSPORT_LIMITS.delayedAckMs) ||
      (recentReceipt && this.rttMs >= CAPTURE_TRANSPORT_LIMITS.delayedAckMs) ||
      (recentNetworkSample && this.serverNetworkAgeMs >= CAPTURE_TRANSPORT_LIMITS.delayedAckMs)
    if (delayed === Boolean(this.delayed)) return
    if (delayed) this.delayedAt = now
    this.delayed = delayed
    this.onReport?.({reason: delayed ? 'capture_transport_delayed' : 'capture_transport_recovered',
      cause: 'receipt_delay', delayedForMs: Math.max(0, now - this.delayedAt), ...details})
  }
  block(reason, details = this.details()) {
    if (this.closed || this.blocked) return false
    this.blocked = true
    this.onReport?.({reason: 'capture_transport_blocked', cause: reason, ...details})
    this.onBlocked?.(reason)
    return false
  }
  send(packet) {
    if (!this.check()) return false
    // Receipt history may expire, but end-to-end upload credit never does. This
    // bounds PCM hidden in OS/TCP/proxy buffers that bufferedAmount cannot see.
    if (this.totalAudioMs - this.acknowledgedAudioMs + packet.durationMs > this.uploadWindowMs) {
      if (!this.flowControlled) {this.flowControlled = true; this.onReport?.({reason: 'capture_flow_control', ...this.details()})}
      return false
    }
    if (this.flowControlled) {this.flowControlled = false; this.onReport?.({reason: 'capture_flow_resumed', ...this.details()})}
    const wire = this.packedEpoch !== undefined ? encodeAudioPacket(packet, this.packedEpoch) : null
    const queue = this.details(), packetBytes = wire ? wire.byteLength + 96 : (packet.pcm?.byteLength || 0) + 1024
    if (queue.engineQueuedPackets >= CAPTURE_TRANSPORT_LIMITS.maximumQueuedPackets ||
      queue.engineQueuedBytes + queue.webSocketBufferedBytes + packetBytes > CAPTURE_TRANSPORT_LIMITS.maximumBufferedBytes)
      return false
    this.captureId ??= packet.captureId
    this.totalAudioMs += packet.durationMs
    const record = {sourceStartMs: packet.sourceStartMs, sourceEndMs: packet.sourceEndMs, generatedAt: packet.capturedAt, queuedAt: packet.queuedAt, at: this.now(), durationMs: packet.durationMs, audioEndMs: this.totalAudioMs}
    this.creditEnds.set(packet.sequence, record)
    this.pending.set(packet.sequence, record); this.audioMs += record.durationMs; this.sentPackets++
    this.firstSentAt ??= this.now()
    this.lastSequence = packet.sequence
    this.pcmBytes += packet.pcm?.byteLength || 0; this.wireBytes += wire ? wire.byteLength : packet.pcm?.byteLength || 0
    try {
      if (wire) this.socket.emit('transcription:audio-packed', wire)
      else this.socket.emit('transcription:audio-pcm', packet)
    } catch { return this.block('capture_transport_rejected') }
    return true
  }
  acknowledge(ack) {
    if (this.closed || this.blocked || !ack || ack.captureId !== this.captureId ||
      !Number.isSafeInteger(ack.sequence) || ack.sequence <= this.lastAckSequence || ack.sequence > this.lastSequence) return
    const record = this.pending.get(ack.sequence)
    const timingRecord = record || this.creditEnds.get(ack.sequence)
    // Delayed receipts must not cap throughput below real time. Keep a bounded
    // window large enough for measured round trips, including expired samples.
    if (timingRecord && ack.ok === true) {
      const latencyMs = Math.max(0, this.now() - timingRecord.at)
      this.uploadWindowMs = Math.max(this.uploadWindowMs, Math.min(CAPTURE_TRANSPORT_LIMITS.maximumAdaptiveOutstandingMs,
        Math.ceil(latencyMs * 1.5 + 1000)))
    }
    const credit = this.creditEnds.get(ack.sequence)
    if (credit !== undefined) this.acknowledgedAudioMs = credit.audioEndMs
    for (const sequence of this.creditEnds.keys()) if (sequence <= ack.sequence) this.creditEnds.delete(sequence)
    for (const [sequence, packet] of this.pending) if (sequence <= ack.sequence) {
      this.pending.delete(sequence); this.audioMs -= packet.durationMs
    }
    this.acknowledgedPackets += ack.sequence - this.lastAckSequence
    this.lastAckSequence = ack.sequence
    if (record) {this.rttMs = Math.max(0, this.now() - record.at); this.rttSampleAt = this.now()}
    this.maxRttMs = Math.max(this.maxRttMs, this.rttMs)
    this.lastAckAt = this.now()
    if (Number.isFinite(ack.networkAgeMs)) {
      this.serverNetworkAgeMs = Math.max(0, ack.networkAgeMs); this.networkSampleAt = this.now()
    }
    for (const field of ['receivedAudioMs', 'providerSubmittedAudioMs', 'recognizedAudioMs'])
      if (Number.isFinite(ack[field])) this[field] = Math.max(0, ack[field])
    if (Number.isFinite(ack.serverAudioMs)) this.serverAudioMs = Math.max(0, ack.serverAudioMs)
    if (Number.isFinite(ack.acknowledgedAt) && Number.isFinite(ack.receivedAt))
      this.serverAckDelayMs = Math.max(0, ack.acknowledgedAt - ack.receivedAt)
    if (timingRecord && this.now() >= (this.nextChainAt || 0)) {
      const record = timingRecord
      this.nextChainAt = this.now() + 1000
      const finishedAt = this.now(), received = ack.serverReceivedAt, replied = ack.acknowledgedAt
      const clock = Number.isFinite(received) && Number.isFinite(replied)
        ? {clockOffsetMs: ((received - record.at) + (replied - finishedAt)) / 2,
          clockUncertaintyMs: Math.max(0, (finishedAt - record.at - (replied - received)) / 2)} : {}
      this.onReport?.({reason: 'capture_packet_timing', packetSequence: ack.sequence, sequence: ack.sequence, streamId: ack.streamId, providerStreamId: ack.providerStreamId,
        sourceStartMs: record.sourceStartMs, sourceEndMs: record.sourceEndMs,
        clientAckReceivedAt: finishedAt, generatedAt: record.generatedAt, queuedAt: record.queuedAt, sentAt: record.at,
        queueWaitMs: Math.max(0, record.at - (record.queuedAt ?? record.at)), ...clock,
        serverReceivedAt: ack.serverReceivedAt, providerSubmittedAt: ack.providerSubmittedAt,
        acknowledgedAt: ack.acknowledgedAt, receivedAudioMs: ack.receivedAudioMs,
        providerSubmittedAudioMs: ack.providerSubmittedAudioMs, recognizedAudioMs: ack.recognizedAudioMs})
    }
    this.onAck?.(ack)
    if (ack.ok === false) this.block(ack.recoveryReason || ack.reason || 'capture_transport_rejected')
    else this.reportDelay()
  }
  close() {
    if (!this.closed && this.creditEnds.size) {
      const records = [...this.creditEnds.values()]
      this.onReport?.({reason: 'capture_unacknowledged_range', cause: 'connection_closed',
        sourceStartMs: records[0].sourceStartMs, sourceEndMs: records.at(-1).sourceEndMs,
        outstandingAudioMs: this.totalAudioMs - this.acknowledgedAudioMs})
    }
    this.closed = true; this.pending.clear(); this.creditEnds.clear(); this.audioMs = 0
    this.socket.off('transcription:audio-ack', this.receiveAck)
  }
}

export function connectCaptureSocket(socket, canceled = () => false) {
  return new Promise((resolve, reject) => {
    let timer
    const cleanup = () => {clearTimeout(timer); socket.off('connect', connected); socket.off('connect_error', failed)}
    const connected = () => {cleanup(); resolve(!canceled())}
    const failed = error => {cleanup(); reject(error instanceof Error ? error : new Error('收音傳輸連線重建失敗'))}
    socket.on('connect', connected); socket.on('connect_error', failed)
    timer = setTimeout(() => failed(new Error('收音傳輸連線逾時')), CAPTURE_TRANSPORT_LIMITS.reconnectMs)
    try {
      if (canceled()) {cleanup(); resolve(false); return}
      if (socket.connected) connected()
      else socket.connect()
    } catch (error) {failed(error)}
  })
}

export function captureStage(promise, stage, timeoutMs, report) {
  report?.({reason: 'capture_setup', stage, status: 'started'})
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`收音啟動逾時（${stage}）`)), timeoutMs)
  })]).then(value => {
    report?.({reason: 'capture_setup', stage, status: 'ready'}); return value
  }, error => {
    report?.({reason: 'capture_setup', stage, status: 'failed', message: error?.message}); throw error
  }).finally(() => clearTimeout(timer))
}

// Compact close diagnostics only: never persist packet payloads or error URLs.
export function observeCaptureConnection(socket, now = Date.now) {
  const engine = socket.io?.engine, ws = engine?.transport?.ws
  let lastPacketAt, lastHeartbeatAt, closeCode
  const packet = value => {lastPacketAt = now(); if (['ping', 'pong'].includes(value?.type)) lastHeartbeatAt = now()}
  const closed = event => {if (Number.isFinite(event?.code)) closeCode = event.code}
  engine?.on?.('packet', packet); engine?.on?.('packetCreate', packet)
  ws?.addEventListener?.('close', closed)
  return {
    snapshot: () => ({socketCloseCode: closeCode,
      lastSocketPacketAgeMs: lastPacketAt === undefined ? undefined : Math.max(0, now() - lastPacketAt),
      lastHeartbeatAgeMs: lastHeartbeatAt === undefined ? undefined : Math.max(0, now() - lastHeartbeatAt)}),
    close() {engine?.off?.('packet', packet); engine?.off?.('packetCreate', packet); ws?.removeEventListener?.('close', closed)},
  }
}
