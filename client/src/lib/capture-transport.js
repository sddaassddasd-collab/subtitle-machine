export const CAPTURE_TRANSPORT_LIMITS = Object.freeze({version: 2, maximumInFlightMs: 1000,
  acknowledgementMs: 1500, maximumBufferedBytes: 65536, maximumQueuedPackets: 64,
  reportMs: 5000, reconnectMs: 8000, packetMs: 40, cumulativeAckMs: 100})

export function socketTransportDetails(socket) {
  const engine = socket?.io?.engine, queue = engine?.writeBuffer || []
  return {transportType: engine?.transport?.name || 'unknown',
    engineQueuedPackets: queue.length,
    engineQueuedBytes: queue.slice(0, CAPTURE_TRANSPORT_LIMITS.maximumQueuedPackets + 1)
      .reduce((size, packet) => size + (typeof packet.data === 'string' ? packet.data.length : packet.data?.byteLength || 0), 0),
    webSocketBufferedBytes: engine?.transport?.ws?.bufferedAmount || 0}
}

// An independent audio socket and cumulative ACKs bound pending PCM without
// per-packet request/response callbacks on the control channel.
export class CaptureTransport {
  constructor(socket, {onAck, onBlocked, onReport, now = () => performance.now()} = {}) {
    this.socket = socket; this.onAck = onAck; this.onBlocked = onBlocked; this.onReport = onReport; this.now = now
    this.pending = new Map(); this.audioMs = 0; this.sentPackets = 0; this.acknowledgedPackets = 0
    this.maxRttMs = 0; this.rttMs = 0; this.reportAt = now(); this.closed = false; this.blocked = false
    this.receiveAck = ack => this.acknowledge(ack)
    socket.on('transcription:audio-ack', this.receiveAck)
  }
  details(now = this.now()) {
    const first = this.pending.values().next().value
    return {transportVersion: CAPTURE_TRANSPORT_LIMITS.version, ...socketTransportDetails(this.socket),
      inFlightPackets: this.pending.size, inFlightAudioMs: this.audioMs,
      oldestAckAgeMs: first ? Math.max(0, now - first.at) : 0,
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
    if (now - this.reportAt >= CAPTURE_TRANSPORT_LIMITS.reportMs) {
      this.reportAt = now; this.onReport?.({reason: 'capture_transport', ...details})
    }
    return true
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
    if (this.audioMs + packet.durationMs > CAPTURE_TRANSPORT_LIMITS.maximumInFlightMs ||
      queue.engineQueuedPackets >= CAPTURE_TRANSPORT_LIMITS.maximumQueuedPackets ||
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
    this.onAck?.(ack)
    if (ack.ok === false) this.block(ack.recoverable ? ack.recoveryReason || 'capture_transport_rejected' : 'capture_transport_rejected')
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
