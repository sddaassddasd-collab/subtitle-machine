const TRANSPORT_SETTINGS = Object.freeze({version: 2, reportMs: 5000, stallMs: 5000,
  maximumPacketAgeMs: 1000, networkWarningMs: 1000, sustainedNetworkAgeMs: 3000,
  networkHoldMs: 5000, extremeNetworkAgeMs: 10000,
  maximumBufferedMs: 2000, sampleRate: 24000, bytesPerSample: 2});

class TranscriptionHealth {
  constructor(now = Date.now()) {
    this.startedAt = this.fromAt = this.lastTick = now; this.lastPacketAt = null; this.offset = Infinity;
    this.cpu = process.cpuUsage(); this.reset();
  }
  reset() { this.packets = this.audioMs = this.maxBufferBytes = this.maxReceiveGapMs = this.maxNetworkAgeMs = this.maxCaptureAgeMs = this.maxLoopDelayMs = 0; }
  receive(packet, now = Date.now()) {
    if (this.lastPacketAt !== null) this.maxReceiveGapMs = Math.max(this.maxReceiveGapMs, now - this.lastPacketAt);
    this.lastPacketAt = now; this.packets++; this.audioMs += packet.durationMs || 0;
    let networkAgeMs = 0;
    if (Number.isFinite(packet.capturedAt)) {
      const offset = now - packet.capturedAt;
      // Relative clock offset, not an assumption that client/server clocks agree.
      this.offset = Math.min(this.offset, offset);
      networkAgeMs = Math.max(0, offset - this.offset);
    }
    this.maxNetworkAgeMs = Math.max(this.maxNetworkAgeMs, networkAgeMs);
    if (Number.isFinite(packet.captureAgeMs)) this.maxCaptureAgeMs = Math.max(this.maxCaptureAgeMs, packet.captureAgeMs);
    return networkAgeMs;
  }
  networkDecision(ageMs, now = Date.now()) {
    // Receive jitter is not audio-thread backlog. One delayed packet must not
    // tear down a healthy capture, especially when the queue is catching up.
    if (ageMs >= TRANSPORT_SETTINGS.sustainedNetworkAgeMs) this.behindSince ??= now;
    else this.behindSince = null;
    const stop = ageMs >= TRANSPORT_SETTINGS.extremeNetworkAgeMs ||
      (this.behindSince !== null && now - this.behindSince >= TRANSPORT_SETTINGS.networkHoldMs);
    const delayed = ageMs >= TRANSPORT_SETTINGS.networkWarningMs;
    const changed = this.networkDelayed !== delayed;
    this.networkDelayed = delayed;
    return {stop, changed, delayed, networkAgeMs: ageMs, behindMs: this.behindSince === null ? 0 : now - this.behindSince};
  }
  tick(bufferBytes = 0, now = Date.now()) {
    this.maxLoopDelayMs = Math.max(this.maxLoopDelayMs, now - this.lastTick - 1000);
    this.lastTick = now; this.maxBufferBytes = Math.max(this.maxBufferBytes, bufferBytes);
    if (now - this.fromAt < TRANSPORT_SETTINGS.reportMs) return null;
    const cpu = process.cpuUsage(), memory = process.memoryUsage();
    const result = {fromAt: this.fromAt, toAt: now, packets: this.packets, receivedAudioMs: this.audioMs,
      maxReceiveGapMs: this.maxReceiveGapMs, maxNetworkAgeMs: this.maxNetworkAgeMs,
      maxCaptureAgeMs: this.maxCaptureAgeMs, maxEventLoopDelayMs: this.maxLoopDelayMs,
      providerBufferedBytes: bufferBytes, maxProviderBufferedBytes: this.maxBufferBytes,
      packetAgeMs: now - (this.lastPacketAt ?? this.fromAt),
      cpuPercent: 100 * (cpu.user - this.cpu.user + cpu.system - this.cpu.system) / ((now - this.fromAt) * 1000),
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed};
    this.fromAt = now; this.cpu = cpu; this.reset(); return result;
  }
}
module.exports = {TranscriptionHealth, TRANSPORT_SETTINGS};
