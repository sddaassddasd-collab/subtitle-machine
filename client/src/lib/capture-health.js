// Persist compact diagnostics independently of the audio connection. Never PCM,
// transcripts or keys. Session storage also survives a reload after a failure.
const fields = new Set(['runId', 'captureId', 'reason', 'cause', 'stage', 'status', 'message', 'attempt',
  'sampleAgeMs', 'ackAgeMs', 'captureAgeMs', 'transportType', 'transportVersion', 'version',
  'maximumInFlightMs', 'acknowledgementMs', 'maximumBufferedBytes', 'maximumQueuedPackets',
  'reportMs', 'reconnectMs', 'packetMs', 'cumulativeAckMs', 'inFlightPackets', 'inFlightAudioMs',
  'oldestAckAgeMs', 'engineQueuedPackets', 'engineQueuedBytes', 'webSocketBufferedBytes',
  'rttMs', 'maxRttMs', 'sentPackets', 'acknowledgedPackets', 'delayedAckMs', 'delayedForMs',
  'lastAckAgeMs', 'serverNetworkAgeMs', 'serverAudioMs', 'serverAckDelayMs', 'retryAfterMs',
  'sourceId', 'sourceStartMs', 'sourceEndMs', 'droppedInputMs', 'expiredReceipts', 'sequence', 'congestionMs', 'probeMs', 'unresponsiveMs',
  'outstandingAudioMs', 'wireBytes', 'pcmBytes', 'probeThresholdMs', 'maximumOutstandingAudioMs'])
export class CaptureHealthOutbox {
  constructor(sessionId, {storage, fetcher = (...args) => globalThis.fetch(...args), now = Date.now, id = () => crypto.randomUUID()} = {}) {
    this.sessionId = sessionId; this.storage = storage; this.fetcher = fetcher; this.now = now; this.id = id
    this.key = `capture-health:${sessionId}`; this.events = []; this.nextAt = 0
    try {this.events = JSON.parse(storage?.getItem(this.key) || '[]').filter(e => now() - e.occurredAt < 86400000).slice(-256)} catch { /* unavailable storage */ }
  }
  persist() {try {this.storage?.setItem(this.key, JSON.stringify(this.events))} catch { /* retain memory copy */ }}
  add(data) {
    const at = this.now()
    const event = {eventId: this.id(), occurredAt: Number.isFinite(data.occurredAt) && Math.abs(data.occurredAt - at) < 86400000 ? data.occurredAt : at}
    for (const [key, value] of Object.entries(data)) {
      if (!fields.has(key)) continue
      if (typeof value === 'string') event[key] = value.slice(0, 400)
      else if (typeof value === 'number' && Number.isFinite(value)) event[key] = value
    }
    this.events.push(event); this.events = this.events.slice(-256); this.persist()
    void this.flush()
  }
  async flush() {
    if (this.busy || !this.events.length || this.now() < this.nextAt) return
    this.busy = true; const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const response = await this.fetcher(`/api/session/${encodeURIComponent(this.sessionId)}/follow-history/capture-health`, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal,
        body: JSON.stringify({events: this.events.slice(0, 64)}),
      })
      if (!response.ok) throw new Error('health unavailable')
      const {accepted} = await response.json(), ids = new Set(accepted || [])
      this.events = this.events.filter(e => !ids.has(e.eventId)); this.persist()
      this.nextAt = this.now() + (ids.size ? 0 : 2000)
    } catch { this.nextAt = this.now() + 2000 }
    finally {clearTimeout(timer); this.busy = false}
  }
}
