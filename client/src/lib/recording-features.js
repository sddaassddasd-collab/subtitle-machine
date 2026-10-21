// Keep the RFA1 representation identical to server/src/acoustic-follow.js.
const SAMPLE_RATE = 16000;
const FRAME_MS = 40;
const HOP = SAMPLE_RATE * FRAME_MS / 1000;
const WINDOW = 400;
const FFT_SIZE = 512;
const DIMENSIONS = 24;
const VERSION = 1;
const windowWeights = Float32Array.from({length: WINDOW}, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WINDOW - 1)));
const mel = hz => 2595 * Math.log10(1 + hz / 700);
const hz = value => 700 * (10 ** (value / 2595) - 1);
const melBins = Array.from({length: DIMENSIONS + 2}, (_, i) =>
  Math.floor((FFT_SIZE + 1) * hz(mel(80) + i / (DIMENSIONS + 1) * (mel(7600) - mel(80))) / SAMPLE_RATE));
const twiddles = new Map();
for (let size = 2; size <= FFT_SIZE; size <<= 1) twiddles.set(size,
  Array.from({length: size / 2}, (_, j) => [Math.cos(-2 * Math.PI * j / size), Math.sin(-2 * Math.PI * j / size)]));

function spectrum(samples) {
  const real = new Float64Array(FFT_SIZE), imaginary = new Float64Array(FFT_SIZE);
  let rms = 0;
  for (let i = 0; i < WINDOW; i++) {
    const value = samples[i] || 0;
    rms += value * value;
    real[i] = (value - 0.97 * (samples[i - 1] || 0)) * windowWeights[i];
  }
  for (let i = 1, j = 0; i < FFT_SIZE; i++) {
    let bit = FFT_SIZE >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j], real[i]];
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    for (let offset = 0; offset < FFT_SIZE; offset += size) {
      for (let j = 0; j < size / 2; j++) {
        const other = offset + j + size / 2, first = offset + j;
        const [cos, sin] = twiddles.get(size)[j];
        const r = real[other] * cos - imaginary[other] * sin;
        const im = real[other] * sin + imaginary[other] * cos;
        real[other] = real[first] - r; imaginary[other] = imaginary[first] - im;
        real[first] += r; imaginary[first] += im;
      }
    }
  }
  const feature = new Float32Array(DIMENSIONS);
  let mean = 0;
  for (let band = 0; band < DIMENSIONS; band++) {
    const [left, center, right] = melBins.slice(band, band + 3);
    let energy = 0;
    for (let bin = left; bin < right; bin++) {
      const weight = bin < center ? (bin - left) / Math.max(1, center - left) : (right - bin) / Math.max(1, right - center);
      energy += weight * (real[bin] ** 2 + imaginary[bin] ** 2);
    }
    feature[band] = Math.log(1e-9 + energy);
    mean += feature[band] / DIMENSIONS;
  }
  let norm = 0;
  for (let i = 0; i < DIMENSIONS; i++) { feature[i] -= mean; norm += feature[i] ** 2; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIMENSIONS; i++) feature[i] /= norm;
  return { feature, rms: Math.sqrt(rms / WINDOW) };
}

export function extractFeatures(pcm) {
  const bytes = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  if (!(pcm instanceof Int16Array)) throw new Error('PCM 音訊格式不正確');
  const sampleCount = pcm.length;
  const count = Math.max(0, Math.floor((sampleCount - WINDOW) / HOP) + 1);
  const matrix = new Float32Array(count * (DIMENSIONS + 1));
  const samples = new Float32Array(WINDOW);
  const peaks = new Array(Math.min(1600, Math.max(1, Math.ceil(sampleCount / SAMPLE_RATE * 4)))).fill(0);
  for (let i = 0; i < sampleCount; i++) {
    const value = Math.abs(bytes.getInt16(i * 2, true) / 32768);
    const bin = Math.min(peaks.length - 1, Math.floor(i / sampleCount * peaks.length));
    peaks[bin] = Math.max(peaks[bin], value);
  }
  for (let frame = 0; frame < count; frame++) {
    for (let j = 0; j < WINDOW; j++) samples[j] = bytes.getInt16((frame * HOP + j) * 2, true) / 32768;
    const {feature, rms} = spectrum(samples);
    matrix.set(feature, frame * (DIMENSIONS + 1));
    matrix[frame * (DIMENSIONS + 1) + DIMENSIONS] = rms;
  }
  const features = new Uint8Array(24 + matrix.byteLength);
  features.set([82, 70, 65, 49]);
  const header = new DataView(features.buffer);
  [VERSION, SAMPLE_RATE, FRAME_MS, DIMENSIONS, count].forEach((value, i) => header.setUint32(4 + i * 4, value, true));
  features.set(new Uint8Array(matrix.buffer), 24);
  return { features: features.buffer,
    duration: sampleCount / SAMPLE_RATE, frameCount: count, frameMs: FRAME_MS, version: VERSION,
    peaks: peaks.map(value => Math.round(value * 10000) / 10000) };
}
