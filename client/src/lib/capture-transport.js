export const CAPTURE_TRANSPORT_LIMITS = Object.freeze({version: 1, maximumInFlightMs: 1000,
  acknowledgementMs: 1500, maximumBufferedBytes: 65536, maximumQueuedPackets: 64,
  reportMs: 5000, reconnectMs: 8000})

export function socketTransportDetails(socket) {
  const engine = socket?.io?.engine, queue = engine?.writeBuffer || []
  return {transportType: engine?.transport?.name || 'unknown',
    engineQueuedPackets: queue.length,
    engineQueuedBytes: queue.slice(0, CAPTURE_TRANSPORT_LIMITS.maximumQueuedPackets + 1)
      .reduce((size, packet) => size + (typeof packet.data === 'string' ? packet.data.length : packet.data?.byteLength || 0), 0),
    webSocketBufferedBytes: engine?.transport?.ws?.bufferedAmount || 0}
}

// No PCM queue: reserve a bounded number of unacknowledged milliseconds before
// handing anything to Socket.IO. A full queue requires a fresh capture clock;
// silently dropping samples and then continuing would compress that clock.
export class CaptureTransport {
  constructor(socket, {onAck, onBlocked, onReport, now = () => performance.now()} = {}) {
    this.socket = socket; this.onAck = onAck; this.onBlocked = onBlocked; this.onReport = onReport; this.now = now
    this.pending = new Map(); this.audioMs = 0; this.sentPackets = 0; this.acknowledgedPackets = 0
    this.maxRttMs = 0; this.rttMs = 0; this.reportAt = now(); this.closed = false; this.blocked = false
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
    const reason = !this.socket.connected ? 'control_disconnected'
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
    const queue = this.details(), packetBytes = JSON.stringify(packet).length + 32
    if (this.audioMs + packet.durationMs > CAPTURE_TRANSPORT_LIMITS.maximumInFlightMs ||
      queue.engineQueuedPackets >= CAPTURE_TRANSPORT_LIMITS.maximumQueuedPackets ||
      queue.engineQueuedBytes + queue.webSocketBufferedBytes + packetBytes > CAPTURE_TRANSPORT_LIMITS.maximumBufferedBytes)
      return this.block('capture_transport_backlog')
    const record = {at: this.now(), durationMs: packet.durationMs}
    this.pending.set(packet.sequence, record); this.audioMs += record.durationMs; this.sentPackets++
    try {
      this.socket.emit('transcription:audio', packet, ack => {
        if (this.closed || !this.pending.delete(packet.sequence)) return
        this.audioMs -= record.durationMs; this.acknowledgedPackets++
        this.rttMs = Math.max(0, this.now() - record.at); this.maxRttMs = Math.max(this.maxRttMs, this.rttMs)
        this.onAck?.(ack)
        if (ack?.ok === false && !ack.recoverable) this.block('capture_transport_rejected')
      })
    } catch { return this.block('capture_transport_rejected') }
    return true
  }
  close() { this.closed = true; this.pending.clear(); this.audioMs = 0 }
}

export function needsCaptureConnectionReset(reason) {
  return ['stale_capture', 'audio_ack_timeout', 'provider_backpressure'].includes(reason) ||
    String(reason || '').startsWith('capture_transport_')
}

// Reset the physical transport too: reopening only the microphone leaves old
// reliable emits in Engine.IO/native WebSocket queues. Control listeners stay
// attached and rejoin normally on the fresh connection.
export function reconnectCaptureSocket(socket, canceled = () => false) {
  return new Promise((resolve, reject) => {
    let timer
    const cleanup = () => {clearTimeout(timer); socket.off('connect', connected); socket.off('connect_error', failed)}
    const connected = () => {cleanup(); resolve(!canceled())}
    const failed = error => {cleanup(); reject(error instanceof Error ? error : new Error('收音傳輸連線重建失敗'))}
    socket.on('connect', connected); socket.on('connect_error', failed)
    timer = setTimeout(() => failed(new Error('收音傳輸連線重建逾時')), CAPTURE_TRANSPORT_LIMITS.reconnectMs)
    try {
      const engine = socket.io?.engine
      socket.disconnect()
      engine?.transport?.close()
      if (canceled()) {cleanup(); resolve(false); return}
      socket.connect()
    } catch (error) {failed(error)}
  })
}
