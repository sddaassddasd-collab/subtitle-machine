const clamp = (value, low, high) => Math.max(low, Math.min(high, value))

// Original-file seconds are the public clock. Only bounded, decoded PCM buffers
// reach Web Audio; HTMLMediaElement's approximate MP3 seek index is never used.
export class RecordingPlayback {
  constructor({decoderFactory, contextFactory = () => new AudioContext(), onUpdate = () => {},
    blockSeconds = 20, cacheBlocks = 3} = {}) {
    this.decoderFactory = decoderFactory; this.contextFactory = contextFactory; this.onUpdate = onUpdate
    this.blockSeconds = blockSeconds; this.cacheBlocks = cacheBlocks
    this.cache = new Map(); this.pending = new Map(); this.nodes = new Set()
    this.generation = 0; this.duration = 0; this.position = 0; this.volume = 1
    this.playing = false; this.loading = false; this.disposed = false; this.error = ''
  }
  get currentTime() {
    if (!this.playing || !this.anchor) return this.position
    return clamp(this.anchor.position + Math.max(0, this.context.currentTime - this.anchor.time),
      this.anchor.position, this.scheduledFrame / this.sampleRate)
  }
  get snapshot() {
    const preparing = this.playing && (!this.anchor || this.context.currentTime >= this.contextEnd)
    return {duration: this.duration, currentTime: this.currentTime, playing: this.playing,
      preparing, loading: this.loading, available: this.duration > 0 && !this.loading && !this.disposed,
      volume: this.volume, error: this.error}
  }
  notify() { if (!this.disposed) this.onUpdate(this.snapshot) }
  async open(source) {
    this.loading = true; this.notify()
    try {
      this.decoder = this.decoderFactory(source)
      const metadata = await this.decoder.ready
      if (this.disposed) return
      this.duration = metadata.duration; this.sampleRate = metadata.sampleRate
      this.totalFrames = Math.round(this.duration * this.sampleRate)
      this.endFrame = this.totalFrames; this.loading = false; this.notify()
    } catch (error) { if (!this.disposed) { this.loading = false; this.error = error.message; this.notify() } }
  }
  interrupt() {
    this.position = this.currentTime; this.generation++; this.playing = false
    clearInterval(this.timer); this.timer = null
    for (const node of this.nodes) { node.onended = null; node.stop(); node.disconnect() }
    this.nodes.clear(); this.anchor = null
    this.decoder?.cancel(); this.pending.clear()
  }
  pause() { this.interrupt(); this.notify() }
  seek(seconds, {autoplay = this.playing, end = this.duration} = {}) {
    if (!Number.isFinite(seconds) || !this.snapshot.available) return Promise.resolve(false)
    if (autoplay && seconds < Math.min(end, this.duration)) return this.play(seconds, end)
    this.interrupt()
    this.position = Math.round(clamp(seconds, 0, this.duration) * this.sampleRate) / this.sampleRate
    this.endFrame = Math.round(clamp(end, this.position, this.duration) * this.sampleRate)
    this.error = ''; this.notify()
    return Promise.resolve(true)
  }
  async play(from = this.currentTime, to = this.endFrame / this.sampleRate) {
    if (!this.snapshot.available || !Number.isFinite(from) || !Number.isFinite(to)) return false
    let first = Math.round(clamp(from, 0, this.duration) * this.sampleRate)
    let last = Math.round(clamp(to, 0, this.duration) * this.sampleRate)
    if (last <= first) {
      if (arguments.length) return false
      if (first >= this.totalFrames) first = 0
      last = this.totalFrames
    }
    this.interrupt()
    this.position = first / this.sampleRate; this.scheduledFrame = first; this.endFrame = last
    this.playing = true; this.error = ''
    const generation = this.generation
    try {
      // Resume synchronously with the user's click, before awaiting worker decoding.
      if (!this.context) {
        this.context = this.contextFactory()
        this.gain = this.context.createGain(); this.gain.gain.value = this.volume
        this.gain.connect(this.context.destination)
      }
      const resumed = this.context.resume()
      this.notify()
      await resumed
      if (generation !== this.generation || this.disposed) return false
      this.timer = setInterval(() => {
        if (this.anchor && this.context.currentTime >= this.contextEnd && this.scheduledFrame >= this.endFrame)
          this.finish()
        else this.notify()
      }, 80)
      await this.fill(generation)
      return generation === this.generation && !this.disposed
    } catch (error) { this.fail(error, generation); return false }
  }
  async buffer(index, generation) {
    if (this.cache.has(index)) {
      const value = this.cache.get(index)
      this.cache.delete(index); this.cache.set(index, value)
      return value
    }
    if (this.pending.has(index)) return this.pending.get(index)
    const request = (async () => {
      const decoded = await this.decoder.decode(index * this.blockSeconds, Math.min(this.duration, (index + 1) * this.blockSeconds))
      if (generation !== this.generation || this.disposed) throw new DOMException('試聽位置已變更', 'AbortError')
      const arrays = decoded.channels.map(channel => new Float32Array(channel))
      const audio = this.context.createBuffer(arrays.length, arrays[0].length, decoded.sampleRate)
      arrays.forEach((channel, i) => audio.copyToChannel(channel, i))
      const value = {audio, firstFrame: Math.round(decoded.start * this.sampleRate)}
      this.cache.set(index, value)
      while (this.cache.size > this.cacheBlocks) this.cache.delete(this.cache.keys().next().value)
      return value
    })()
    this.pending.set(index, request)
    try { return await request }
    finally { if (this.pending.get(index) === request) this.pending.delete(index) }
  }
  async fill(generation) {
    if (this.filling === generation) return
    this.filling = generation
    try {
      // At most two scheduled blocks plus a small LRU cache, regardless of file length.
      while (this.playing && generation === this.generation && this.nodes.size < 2 && this.scheduledFrame < this.endFrame) {
        const index = Math.floor(this.scheduledFrame / (this.blockSeconds * this.sampleRate))
        const block = await this.buffer(index, generation)
        if (!this.playing || generation !== this.generation || this.disposed) return
        const last = Math.min(this.endFrame, block.firstFrame + block.audio.length)
        const length = last - this.scheduledFrame
        if (length <= 0) throw new Error('解碼片段的時間範圍不一致，已停止試聽')
        if (!this.anchor || this.context.currentTime >= this.contextEnd) {
          // A slow decode freezes the file clock at the end of available sound.
          // Re-anchor on recovery instead of silently skipping audio during the wait.
          this.anchor = {position: this.scheduledFrame / this.sampleRate, time: this.context.currentTime + 0.025}
          this.contextEnd = this.anchor.time
        }
        const node = this.context.createBufferSource()
        node.buffer = block.audio; node.connect(this.gain)
        node.onended = () => {
          node.disconnect(); this.nodes.delete(node)
          if (generation !== this.generation || this.disposed) return
          if (!this.nodes.size && this.scheduledFrame >= this.endFrame) this.finish()
          else void this.fill(generation)
        }
        this.nodes.add(node)
        node.start(this.contextEnd, (this.scheduledFrame - block.firstFrame) / this.sampleRate, length / this.sampleRate)
        this.contextEnd += length / this.sampleRate
        this.scheduledFrame = last
        this.notify()
      }
    } catch (error) { this.fail(error, generation) }
    finally { if (this.filling === generation) this.filling = null }
  }
  finish() {
    const position = this.endFrame / this.sampleRate
    this.interrupt(); this.position = position; this.notify()
  }
  fail(error, generation) {
    if (generation !== this.generation || this.disposed) return
    this.interrupt(); this.error = error.message || '無法播放錄音，請重新連結原音檔'; this.notify()
  }
  setVolume(value) {
    this.volume = clamp(Number(value) || 0, 0, 1)
    if (this.gain) this.gain.gain.value = this.volume
    this.notify()
  }
  dispose() {
    this.interrupt(); this.disposed = true; this.decoder?.close(); this.cache.clear()
    this.gain?.disconnect()
    void this.context?.close().catch(() => {})
  }
}
