export const CAPTURE_TRANSPORT_LIMITS = Object.freeze({version: 3, maximumInFlightMs: 4000,
  acknowledgementMs: 4000, delayedAckMs: 1000, maximumBufferedBytes: 65536, maximumQueuedPackets: 64,
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
    this.receiveAck = ack => this.acknowledge(ack)
    socket.on('transcription:audio-ack', this.receiveAck)
  }
  details(now = this.now()) {
    const first = this.pending.values().next().value
    return {transportVersion: CAPTURE_TRANSPORT_LIMITS.version, ...socketTransportDetails(this.socket),
      inFlightPackets: this.pending.size, inFlightAudioMs: this.audioMs,
      oldestAckAgeMs: first ? Math.max(0, now - first.at) : 0,
      lastAckAgeMs: this.lastAckAt === null ? 0 : Math.max(0, now - this.lastAckAt),
      serverNetworkAgeMs: this.serverNetworkAgeMs, serverAudioMs: this.serverAudioMs, serverAckDelayMs: this.serverAckDelayMs,
      rttMs: this.rttMs, maxRttMs: this.maxRttMs,
      sentPackets: this.sentPackets, acknowledgedPackets: this.acknowledgedPackets}
  }
  check() {
    if (this.closed || this.blocked) return false
    const now = this.now(), details = this.details(now)
    const reason = !this.socket.connected ? 'capture_transport_disconnected'
      : details.oldestAckAgeMs >= CAPTURE_TRANSPORT_LIMITS.acknowledgementMs ? 'capture_transport_timeout'
        : details.engineQueuedPackets > CAPTURE_TRANSPORT_LIMITS.maximumQueuedPackets ||
          details.engineQueuedBytes + details.webSocketBufferedBytes > CAPTURE_TRANSPORT_LIMITS.maximumBufferedBytes
          ? 'capture_transport_backlog' : null
    if (reason) return this.block(reason, details)
    this.reportDelay(now)
    if (now - this.reportAt >= CAPTURE_TRANSPORT_LIMITS.reportMs) {
      this.reportAt = now; this.onReport?.({reason: 'capture_transport', ...details})
    }
    return true
  }
  reportDelay(now = this.now()) {
    if (this.closed || this.blocked) return
    const details = this.details(now)
    const delayed = details.oldestAckAgeMs >= CAPTURE_TRANSPORT_LIMITS.delayedAckMs ||
      this.rttMs >= CAPTURE_TRANSPORT_LIMITS.delayedAckMs || this.serverNetworkAgeMs >= CAPTURE_TRANSPORT_LIMITS.delayedAckMs
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
    const queue = this.details(), packetBytes = (packet.pcm?.byteLength || 0) + 1024
    if (this.audioMs + packet.durationMs > CAPTURE_TRANSPORT_LIMITS.maximumInFlightMs)
      return this.block('capture_receipt_window_full')
    if (queue.engineQueuedPackets >= CAPTURE_TRANSPORT_LIMITS.maximumQueuedPackets ||
      queue.engineQueuedBytes + queue.webSocketBufferedBytes + packetBytes > CAPTURE_TRANSPORT_LIMITS.maximumBufferedBytes)
      return this.block('capture_transport_backlog')
    this.captureId ??= packet.captureId
    const record = {at: this.now(), durationMs: packet.durationMs}
    this.pending.set(packet.sequence, record); this.audioMs += record.durationMs; this.sentPackets++
    try {
      this.socket.emit('transcription:audio-pcm', packet)
    } catch { return this.block('capture_transport_rejected') }
    return true
  }
  acknowledge(ack) {
    if (this.closed || !ack || ack.captureId !== this.captureId || !this.pending.has(ack.sequence)) return
    const record = this.pending.get(ack.sequence)
    for (const [sequence, packet] of this.pending) if (sequence <= ack.sequence) {
      this.pending.delete(sequence); this.audioMs -= packet.durationMs; this.acknowledgedPackets++
    }
    this.rttMs = Math.max(0, this.now() - record.at); this.maxRttMs = Math.max(this.maxRttMs, this.rttMs)
    this.lastAckAt = this.now()
    if (Number.isFinite(ack.networkAgeMs)) this.serverNetworkAgeMs = Math.max(0, ack.networkAgeMs)
    if (Number.isFinite(ack.serverAudioMs)) this.serverAudioMs = Math.max(0, ack.serverAudioMs)
    if (Number.isFinite(ack.acknowledgedAt) && Number.isFinite(ack.receivedAt))
      this.serverAckDelayMs = Math.max(0, ack.acknowledgedAt - ack.receivedAt)
    this.onAck?.(ack)
    if (ack.ok === false) this.block(ack.recoverable ? ack.recoveryReason || 'capture_transport_rejected' : 'capture_transport_rejected')
    else this.reportDelay()
  }
  close() {
    this.closed = true; this.pending.clear(); this.audioMs = 0
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
