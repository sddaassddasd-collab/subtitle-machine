export const CAPTURE_LIMITS = Object.freeze({maximumAgeMs: 250, sampleGapMs: 3000, ackGapMs: 5000,
  maximumAttempts: 3, stableMs: 30000, setupTimeoutMs: 12000})

// endTime is measured by the audio thread, before a busy UI receives its message.
export function captureAgeMs(contextTime, endTime) {
  return Number.isFinite(contextTime) && Number.isFinite(endTime) ? Math.max(0, (contextTime - endTime) * 1000) : 0
}

// Capture intent belongs to this page, never localStorage. Explicit stops and
// unmounts invalidate retries, including an asynchronous start already in flight.
export class CaptureRecovery {
  constructor() { this.cancel() }
  cancel(cause = 'operator_or_context') {
    if (this.desired) this.report?.({reason: 'recovery_cancelled', cause, attempt: this.attempts || 0})
    this.desired = false; this.pending = false; this.inFlight = false; this.exhausted = false
    this.afterFlightReason = null; this.generation = (this.generation || 0) + 1
    this.reconnecting = false
  }
  arm(options) {
    this.cancel('new_capture_intent'); this.desired = true; this.options = options; this.attempts = 0; this.stableAt = 0
    this.lastTransport = null
  }
  request(reason, now = Date.now()) {
    if (!this.desired || this.pending) return false
    if (this.inFlight) { this.afterFlightReason = reason; return false }
    if (this.stableAt && now - this.stableAt >= CAPTURE_LIMITS.stableMs) { this.attempts = 0; this.stableAt = 0 }
    if (this.attempts >= CAPTURE_LIMITS.maximumAttempts) {
      this.desired = false; this.exhausted = true
      this.report?.({reason: 'recovery_exhausted', cause: reason, attempt: this.attempts}); return false
    }
    this.reason = reason; this.pending = true; this.retryAt = now + Math.min(500 * 2 ** this.attempts, 4000)
    this.report?.({reason: 'recovery_scheduled', cause: reason, attempt: this.attempts + 1})
    return true
  }
  take(_connected, now = Date.now()) {
    // Connecting belongs to the timed attempt; offline retries must not wait forever.
    if (!this.desired || !this.pending || this.inFlight || now < this.retryAt) return null
    this.pending = false; this.inFlight = true; this.attempts++
    this.startedAt = now
    this.report?.({reason: 'recovery_attempt', cause: this.reason, attempt: this.attempts})
    return {...this.options, forceRestart: true, preserveTextOnRestart: true, recovering: true,
      recovery: {reason: this.reason, attempt: this.attempts, ...(this.lastTransport ? {transport: this.lastTransport} : {})}, generation: this.generation}
  }
  complete(generation, ok, now = Date.now()) {
    if (generation !== this.generation || !this.desired) return
    this.inFlight = false
    this.report?.({reason: ok ? 'recovery_ready' : 'recovery_failed', cause: this.reason, attempt: this.attempts})
    const again = this.afterFlightReason; this.afterFlightReason = null
    if (ok && !again) this.stableAt = now
    else this.request(again || this.reason, now)
  }
  expire(now = Date.now()) {
    if (!this.desired || !this.inFlight || now - this.startedAt < CAPTURE_LIMITS.setupTimeoutMs) return false
    // Invalidate the unfinished promise before a later attempt can start.
    this.generation++; this.inFlight = false; this.afterFlightReason = null
    this.report?.({reason: 'recovery_timeout', cause: 'capture_setup_timeout', attempt: this.attempts})
    this.request('capture_setup_timeout', now)
    return true
  }
}
