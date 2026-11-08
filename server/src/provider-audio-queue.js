// Queue only under real provider pressure. Normal live audio stays immediate.
const PROVIDER_QUEUE_SETTINGS = Object.freeze({version: 1, highWaterBytes: 48000,
  maximumQueuedMs: 12000, stallMs: 20000, tickMs: 20, catchUpRate: 1.25});
class ProviderAudioQueue {
  constructor({bufferedBytes, submit, fail, report = () => {}, now = Date.now, timers = globalThis}) {
    Object.assign(this, {bufferedBytes, submit, fail, report, now, timers});
    this.queue = []; this.queuedMs = 0; this.closed = false; this.nextSendAt = 0;
  }
  details() {return {providerQueuedAudioMs: this.queuedMs,
    providerQueueAgeMs: this.queue.length ? Math.max(0, this.now() - this.queue[0].at) : 0,
    providerBufferedBytes: this.bufferedBytes()};}
  enqueue(packet) {
    if (this.closed) return false;
    if (!this.queue.length && this.bufferedBytes() < PROVIDER_QUEUE_SETTINGS.highWaterBytes && this.now() >= this.nextSendAt) {
      this.submit(packet); return true;
    }
    if (this.queuedMs + packet.durationMs > PROVIDER_QUEUE_SETTINGS.maximumQueuedMs) {
      this.abort('provider_queue_full'); return false;
    }
    this.queue.push({...packet, at: this.now()}); this.queuedMs += packet.durationMs;
    if (!this.timer) {
      this.lastProgressAt = this.now(); this.report('provider_queue_waiting', this.details());
      this.timer = this.timers.setInterval(() => this.drain(), PROVIDER_QUEUE_SETTINGS.tickMs);
      this.timer.unref?.();
    }
    return true;
  }
  drain() {
    if (this.closed) return;
    const now = this.now();
    if (this.queue.length && now - this.lastProgressAt >= PROVIDER_QUEUE_SETTINGS.stallMs) {
      this.abort('provider_queue_stalled'); return;
    }
    if (!this.queue.length || this.bufferedBytes() >= PROVIDER_QUEUE_SETTINGS.highWaterBytes || now < this.nextSendAt) return;
    const packet = this.queue.shift(); this.queuedMs -= packet.durationMs;
    this.nextSendAt = now + packet.durationMs / PROVIDER_QUEUE_SETTINGS.catchUpRate;
    this.lastProgressAt = now;
    this.submit(packet);
    if (!this.queue.length && !this.closed) {
      this.timers.clearInterval(this.timer); this.timer = null;
      this.report('provider_queue_drained', this.details());
    }
  }
  abort(reason) {const details = this.details(); this.close(); this.report(reason, details); this.fail(reason, details);}
  close() {
    if (!this.closed && this.queue.length) this.report('provider_queue_abandoned', {
      ...this.details(), sourceStartMs: this.queue[0].sourceStartMs,
      sourceEndMs: this.queue.at(-1).sourceEndMs,
      firstPacketSequence: this.queue[0].packetSequence, lastPacketSequence: this.queue.at(-1).packetSequence});
    this.closed = true; this.timers.clearInterval(this.timer); this.timer = null; this.queue = []; this.queuedMs = 0;}
}
module.exports = {ProviderAudioQueue, PROVIDER_QUEUE_SETTINGS};
