// Resample/mix off the UI thread so uploading a rehearsal cannot stall live capture.
self.onmessage = ({data}) => {
  try {
    const {channels, sampleRate, duration} = data;
    const length = Math.floor(duration * 16000), ratio = sampleRate / 16000;
    const pcm = new Int16Array(length);
    for (let i = 0; i < length; i++) {
      const first = Math.floor(i * ratio), last = Math.min(channels[0].length, Math.max(first + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = first; j < last; j++) for (const channel of channels) sum += channel[j];
      const value = Math.max(-1, Math.min(1, sum / ((last - first) * channels.length)));
      pcm[i] = Math.round(value * (value < 0 ? 32768 : 32767));
    }
    self.postMessage({pcm: pcm.buffer}, [pcm.buffer]);
  } catch { self.postMessage({error: '音訊解碼失敗，請改用 WAV 或 MP3'}); }
};
