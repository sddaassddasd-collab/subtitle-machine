const PCM_CAPTURE_SETTINGS = Object.freeze({version: 2, sampleRate: 24000, packetMs: 40, acknowledgementMs: 100});

// Socket.IO transports Buffer as binary. Only a cumulative receipt is returned;
// an error is reported immediately and never hidden behind the ACK timer.
function registerPcmCapture(socket, receive) {
  let pending, timer, acknowledgedAt = 0;
  const flush = () => {
    clearTimeout(timer); timer = null;
    if (pending) {socket.emit('transcription:audio-ack', pending); pending = null; acknowledgedAt = Date.now();}
  };
  socket.on('transcription:audio-pcm', (data = {}) => {
    if (!data || typeof data !== 'object') return;
    const {pcm, durationMs, sequence, captureId} = data;
    const reply = result => {
      pending = {...result, sequence, captureId};
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
    receive({...data, audio: pcm}, reply);
  });
  socket.on('disconnect', () => {clearTimeout(timer); timer = null; pending = null;});
}
module.exports = {registerPcmCapture, PCM_CAPTURE_SETTINGS};
