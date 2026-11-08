const {decodeAudioPacket} = require('./capture-wire.mjs');
const PCM_CAPTURE_SETTINGS = Object.freeze({version: 5, sampleRate: 24000, packetMs: 40, acknowledgementMs: 100});

// Socket.IO transports Buffer as binary. Only a cumulative receipt is returned;
// an error is reported immediately and never hidden behind the ACK timer.
function registerPcmCapture(socket, receive) {
  let pending, timer, acknowledgedAt = 0;
  const flush = () => {
    clearTimeout(timer); timer = null;
    if (pending) {socket.emit('transcription:audio-ack', {...pending, acknowledgedAt: Date.now()}); pending = null; acknowledgedAt = Date.now();}
  };
  const receivePacket = (data = {}) => {
    if (!data || typeof data !== 'object') return;
    const {pcm, durationMs, sequence, captureId} = data;
    const receivedAt = Date.now();
    const reply = result => {
      pending = {...result, sequence, captureId, receivedAt};
      if (result.ok !== true || Date.now() - acknowledgedAt >= PCM_CAPTURE_SETTINGS.acknowledgementMs) flush();
      else if (!timer) {
        timer = setTimeout(flush, PCM_CAPTURE_SETTINGS.acknowledgementMs - (Date.now() - acknowledgedAt));
        timer.unref?.();
      }
    };
    if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > 4800 ||
      !Number.isSafeInteger(sequence) || sequence < 1 || typeof captureId !== 'string' || !captureId || captureId.length > 100 ||
      !Number.isFinite(durationMs) || Math.abs(durationMs - pcm.length / 48) > 1) {
      reply({ok: false, reason: 'invalid_pcm_packet'}); return;
    }
    if (data.sourceId !== undefined && (typeof data.sourceId !== 'string' || !data.sourceId || data.sourceId.length > 100 ||
      !Number.isFinite(data.sourceStartMs) || data.sourceStartMs < -1 || !Number.isFinite(data.sourceEndMs) ||
      Math.abs(data.sourceEndMs - data.sourceStartMs - durationMs) > 1)) {
      reply({ok: false, reason: 'invalid_source_clock'}); return;
    }
    receive({...data, audio: pcm}, reply);
  };
  socket.on('transcription:audio-pcm', receivePacket);
  socket.on('transcription:audio-packed', bytes => {
    const capture = socket.data?.capture;
    if (!capture || !Buffer.isBuffer(bytes)) return;
    let packet;
    try {packet = decodeAudioPacket(bytes);}
    catch {
      const sequence = bytes.length >= 8 ? bytes.readUInt32LE(4) : 0;
      socket.emit('transcription:audio-ack', {ok: false, reason: 'invalid_audio_wire', sequence, captureId: capture.captureId});
      return;
    }
    if (packet.epoch !== (capture.captureGeneration >>> 0)) return;
    const samples = new Int16Array(packet.pcm);
    let sum = 0, peak = 0, clippedSamples = 0;
    for (const value of samples) {
      const sample = value / 32768, amplitude = Math.abs(sample);
      sum += sample * sample; peak = Math.max(peak, amplitude);
      if (amplitude >= .99) clippedSamples++;
    }
    receivePacket({...packet, pcm: Buffer.from(packet.pcm), sessionId: capture.sessionId,
      captureId: capture.captureId, sourceId: capture.sourceId,
      level: Math.sqrt(sum / samples.length), quality: {peak, clippedSamples, samples: samples.length}});
  });
  socket.on('disconnect', () => {clearTimeout(timer); timer = null; pending = null;});
}
module.exports = {registerPcmCapture, PCM_CAPTURE_SETTINGS};
