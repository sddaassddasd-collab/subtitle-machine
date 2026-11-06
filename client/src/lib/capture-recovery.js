export const CAPTURE_LIMITS = Object.freeze({maximumAgeMs: 250, sampleGapMs: 3000, ackGapMs: 5000,
  maximumAttempts: 3, stableMs: 30000})

// endTime is measured by the audio thread, before a busy UI receives its message.
export function captureAgeMs(contextTime, endTime) {
  return Number.isFinite(contextTime) && Number.isFinite(endTime) ? Math.max(0, (contextTime - endTime) * 1000) : 0
}

// Capture intent belongs to this page, never localStorage. Explicit stops and
// unmounts invalidate retries, including an asynchronous start already in flight.
export class CaptureRecovery {
  constructor() { this.cancel() }
  cancel() { this.desired = false; this.pending = false; this.inFlight = false; this.exhausted = false; this.generation = (this.generation || 0) + 1 }
  arm(options) {
    this.cancel(); this.desired = true; this.options = options; this.attempts = 0; this.stableAt = 0
  }
  request(reason, now = Date.now()) {
    if (!this.desired || this.pending || this.inFlight) return false
    if (this.stableAt && now - this.stableAt >= CAPTURE_LIMITS.stableMs) this.attempts = 0
    if (this.attempts >= CAPTURE_LIMITS.maximumAttempts) { this.desired = false; this.exhausted = true; return false }
    this.reason = reason; this.pending = true; this.retryAt = now + Math.min(500 * 2 ** this.attempts, 4000)
    return true
  }
  take(connected, now = Date.now()) {
    if (!this.desired || !this.pending || this.inFlight || !connected || now < this.retryAt) return null
    this.pending = false; this.inFlight = true; this.attempts++
    return {...this.options, forceRestart: true, preserveTextOnRestart: true, recovering: true,
      recovery: {reason: this.reason, attempt: this.attempts}, generation: this.generation}
  }
  complete(generation, ok, now = Date.now()) {
    if (generation !== this.generation || !this.desired) return
    this.inFlight = false
    if (ok) this.stableAt = now
    else this.request(this.reason, now)
  }
}
