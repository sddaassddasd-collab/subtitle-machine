import {captureStage} from './capture-transport.js'

const WORKLET_URL = new URL('../worklets/mic-capture-processor.js', import.meta.url)

// The page owns only this microphone lifetime. Network/provider epochs live in
// the Worker and never call stop() or getUserMedia().
export class CaptureSession {
  constructor({environment = globalThis, createWorker = () => new Worker(new URL('../workers/capture-worker.js', import.meta.url), {type: 'module'}),
    makeId = () => crypto.randomUUID()} = {}) {
    this.env = environment; this.createWorker = createWorker; this.makeId = makeId; this.generation = 0
    this.desired = false
  }
  async start(config) {
    if (this.starting) return false
    this.desired = true; this.starting = true; this.options = {autoFollow: config.request.autoFollow}
    const generation = ++this.generation
    const active = () => this.desired && generation === this.generation
    let media, context, source, node, silence
    const releasePending = () => {
      if (context === this.audioContext) return
      node?.disconnect(); source?.disconnect(); silence?.disconnect()
      void context?.close().catch(() => {})
      media?.getTracks().forEach(track => track.stop())
    }
    try {
      if (!this.audioContext || this.audioContext.state === 'closed' || this.mediaStream?.getAudioTracks().every(track => track.readyState === 'ended')) {
        this.releaseSource()
        const permission = this.env.navigator.mediaDevices.getUserMedia({audio: {
          echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: {ideal: 2},
        }})
        const lateSafe = permission.then(value => {
          if (!active()) {value.getTracks().forEach(track => track.stop()); throw new Error('收音啟動已取消')}
          return value
        })
        media = await captureStage(lateSafe, 'microphone_permission', 10000, this.report)
        if (!active()) {releasePending(); return false}
        const AudioContext = this.env.AudioContext || this.env.webkitAudioContext
        if (!AudioContext) throw new Error('瀏覽器不支援 AudioContext')
        context = new AudioContext()
        await captureStage(context.resume(), 'audio_context', 3000, this.report)
        if (!active()) {releasePending(); return false}
        if (!context.audioWorklet || !this.env.AudioWorkletNode)
          throw new Error('此瀏覽器缺少獨立音訊收音功能，請使用最新版 Chrome 或 Edge')
        await captureStage(context.audioWorklet.addModule(WORKLET_URL.href), 'audio_worklet', 5000, this.report)
        if (!active()) {releasePending(); return false}
        source = context.createMediaStreamSource(media)
        silence = context.createGain(); silence.gain.value = 0
        node = new this.env.AudioWorkletNode(context, 'mic-capture-processor', {numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1})
        source.connect(node); node.connect(silence); silence.connect(context.destination)
        this.mediaStream = media; this.audioContext = context; this.sourceNode = source
        this.captureNode = node; this.silenceNode = silence; this.sourceId = this.makeId()
        const resume = () => {void this.resume()}
        this.resumeListener = resume
        for (const event of ['pageshow', 'focus', 'online']) this.env.addEventListener(event, resume)
        this.env.document.addEventListener('visibilitychange', resume)
        context.addEventListener('statechange', resume)
        for (const track of media.getAudioTracks()) track.addEventListener?.('ended', () => {
          if (this.desired && this.mediaStream === media) {
            this.report?.({reason: 'capture_source_ended'})
            this.stop()
            this.onEvent?.({type: 'state', status: 'source-error', message: '音訊輸入裝置已停止，請確認裝置後重新啟動收音。'})
          }
        })
        node.onprocessorerror = () => {
          if (this.desired && this.captureNode === node) {
            this.report?.({reason: 'capture_source_processor_error'}); this.stop()
            this.onEvent?.({type: 'state', status: 'source-error', message: '音訊處理已停止，請重新啟動收音。'})
          }
        }
      }
      this.config = config
      this.replaceWorker(config, generation)
      return true
    } catch (error) {
      releasePending()
      if (active()) {this.stop(); throw error}
      return false
    } finally {if (generation === this.generation) this.starting = false}
  }
  replaceWorker(config, generation) {
    const old = this.worker
    // Graceful stop runs on the audio connection before it disconnects. The
    // server's capture generation fence also rejects an old stop delivered late.
    if (old) this.shutdownWorker(old)
    const worker = this.createWorker(); this.worker = worker
    this.captureId = ''; this.startedAt = Date.now()
    worker.onmessage = ({data}) => {
      if (!this.desired || this.worker !== worker || generation !== this.generation) return
      if (data.type === 'epoch') this.captureId = data.captureId
      if (data.type === 'report') this.report?.(data)
      if (data.type === 'state') {
        this.starting = false
        if (data.status === 'fatal') {this.stop(); this.onEvent?.(data); return}
      }
      if (data.type === 'source-stalled') void this.resume()
      this.onEvent?.(data)
    }
    worker.onerror = () => {
      if (this.worker !== worker || !this.desired) return
      this.report?.({reason: 'capture_worker_failed'})
      this.stop()
      this.onEvent?.({type: 'state', status: 'source-error', message: '收音工作已停止，請重新啟動收音。'})
    }
    const channel = new this.env.MessageChannel()
    this.captureNode.port.postMessage({type: 'connect', port: channel.port1}, [channel.port1])
    const trackSettings = this.mediaStream.getAudioTracks()[0]?.getSettings?.() || {}
    const audio = Object.fromEntries(['sampleRate', 'channelCount', 'echoCancellation', 'noiseSuppression', 'autoGainControl']
      .filter(key => key in trackSettings).map(key => [key, trackSettings[key]]))
    worker.postMessage({type: 'start', port: channel.port2, config: {...config,
      clock: this.clock(), sourceId: this.sourceId, inputRate: this.audioContext.sampleRate,
      clientInfo: {...config.clientInfo, captureGeneration: Date.now() * 1000 + generation,
        audio: {contextSampleRate: this.audioContext.sampleRate, ...audio}},
    }}, [channel.port2])
  }
  clock() {return {wallTime: Date.now(), contextTime: this.audioContext?.currentTime || 0}}
  async resume() {
    const context = this.audioContext
    if (!this.desired || !context || this.resuming) return
    if (context.state !== 'suspended') return
    this.resuming = true
    try {
      await context.resume()
      if (this.desired && this.audioContext === context) {
        this.worker?.postMessage({type: 'clock', clock: this.clock()})
        this.report?.({reason: 'capture_source_resumed'})
      }
    } catch { /* A browser may require a user gesture; the source stays owned. */ }
    finally {this.resuming = false}
  }
  request(reason, scope) {
    if (!this.desired || !this.worker) return false
    // Capture-stalled snapshots are observations, not instructions to tear down
    // a microphone. The Worker independently checks its direct audio port.
    if (reason === 'capture_stalled') return false
    this.worker.postMessage({type: 'recover', reason, scope: scope || (reason.startsWith('capture_transport') ? 'transport' : 'provider')})
    return true
  }
  setControlSocketId(controlSocketId) {
    if (this.config) this.config.clientInfo.controlSocketId = controlSocketId
    this.worker?.postMessage({type: 'control', controlSocketId})
  }
  shutdownWorker(worker, preserveText = true) {
    try {worker.postMessage({type: 'stop', preserveText})}
    catch {worker.terminate(); return}
    // Give the worker's stop message time to be sent; never leave its retry
    // timers alive when leaving a page or switching configuration.
    const timer = setTimeout(() => worker.terminate(), 1000)
    timer.unref?.()
  }
  releaseSource() {
    const context = this.audioContext, resume = this.resumeListener
    if (resume) {
      for (const event of ['pageshow', 'focus', 'online']) this.env.removeEventListener(event, resume)
      this.env.document.removeEventListener('visibilitychange', resume)
      context?.removeEventListener('statechange', resume)
    }
    this.captureNode?.port.postMessage({type: 'disconnect'})
    this.captureNode?.disconnect(); this.sourceNode?.disconnect(); this.silenceNode?.disconnect()
    void context?.close().catch(() => {})
    this.mediaStream?.getTracks().forEach(track => track.stop())
    this.mediaStream = this.audioContext = this.captureNode = this.sourceNode = this.silenceNode = null
    this.resumeListener = null
  }
  stop({preserveText = true} = {}) {
    this.desired = false; this.starting = false; this.generation++
    if (this.worker) this.shutdownWorker(this.worker, preserveText)
    this.worker = null; this.releaseSource()
  }
  cancel() {this.stop()}
}
