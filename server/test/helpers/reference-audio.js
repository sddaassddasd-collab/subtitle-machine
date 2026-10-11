const phrases = [[260, 550, 950, 420, 1300, 760, 350, 1700], [2300, 3100, 1800, 2700, 3800, 2100, 3300, 2500]];
function phrasePcm(sequence, sampleRate = 16000, {speed = 1, amplitude = 0.2, pitch = 1, silence = 0} = {}) {
  const duration = sequence.length * 0.18 * speed + silence;
  const pcm = Buffer.alloc(Math.ceil(duration * sampleRate) * 2);
  for (let i = 0; i < pcm.length / 2; i++) {
    const time = i / sampleRate, item = Math.floor(time / speed / 0.18);
    if (item >= sequence.length) continue;
    const frequency = sequence[item] * pitch;
    const phase = (time / speed / 0.18) % 1;
    const envelope = Math.min(1, phase * 15, (1 - phase) * 15);
    const value = amplitude * envelope * (Math.sin(2 * Math.PI * frequency * time) + 0.3 * Math.sin(4 * Math.PI * frequency * time));
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), i * 2);
  }
  return pcm;
}

module.exports = {phrasePcm, phrases};
