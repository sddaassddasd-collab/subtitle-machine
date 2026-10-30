// Small, deterministic acoustic frontend and bounded online subsequence DTW.
// No ASR request runs on this path. Heavy work is executed in a worker thread.
const SAMPLE_RATE = 16000;
const FRAME_MS = 40;
const HOP = SAMPLE_RATE * FRAME_MS / 1000;
const WINDOW = 400;
const FFT_SIZE = 512;
const DIMENSIONS = 24;
const VERSION = 1;
const MIN_CONFIDENCE = 0.80;
const MIN_MARGIN = 0.035;
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

function extractFeatures(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length % 2) throw new Error('PCM 音訊格式不正確');
  const sampleCount = pcm.length / 2;
  const count = Math.max(0, Math.floor((sampleCount - WINDOW) / HOP) + 1);
  const matrix = new Float32Array(count * (DIMENSIONS + 1));
  const samples = new Float32Array(WINDOW);
  const peaks = new Array(Math.min(1600, Math.max(1, Math.ceil(sampleCount / SAMPLE_RATE * 4)))).fill(0);
  for (let i = 0; i < sampleCount; i++) {
    const value = Math.abs(pcm.readInt16LE(i * 2) / 32768);
    const bin = Math.min(peaks.length - 1, Math.floor(i / sampleCount * peaks.length));
    peaks[bin] = Math.max(peaks[bin], value);
  }
  for (let frame = 0; frame < count; frame++) {
    for (let j = 0; j < WINDOW; j++) samples[j] = pcm.readInt16LE((frame * HOP + j) * 2) / 32768;
    const {feature, rms} = spectrum(samples);
    matrix.set(feature, frame * (DIMENSIONS + 1));
    matrix[frame * (DIMENSIONS + 1) + DIMENSIONS] = rms;
  }
  const header = Buffer.alloc(24);
  header.write('RFA1'); header.writeUInt32LE(VERSION, 4); header.writeUInt32LE(SAMPLE_RATE, 8);
  header.writeUInt32LE(FRAME_MS, 12); header.writeUInt32LE(DIMENSIONS, 16); header.writeUInt32LE(count, 20);
  return { features: Buffer.concat([header, Buffer.from(matrix.buffer)]),
    duration: sampleCount / SAMPLE_RATE, frameCount: count, frameMs: FRAME_MS, version: VERSION,
    peaks: peaks.map(value => Math.round(value * 10000) / 10000) };
}

function decodeFeatures(buffer) {
  if (!buffer || buffer.length < 24 || buffer.toString('ascii', 0, 4) !== 'RFA1' ||
    buffer.readUInt32LE(4) !== VERSION || buffer.readUInt32LE(8) !== SAMPLE_RATE ||
    buffer.readUInt32LE(12) !== FRAME_MS || buffer.readUInt32LE(16) !== DIMENSIONS) throw new Error('錄音特徵版本不相容，請重新匯入');
  const count = buffer.readUInt32LE(20);
  if (buffer.length !== 24 + count * (DIMENSIONS + 1) * 4) throw new Error('錄音特徵資料不完整');
  const bytes = buffer.subarray(24);
  return { count, matrix: new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
}

class StreamingFeatures {
  constructor(sampleRate = 24000) { this.sampleRate = sampleRate; this.reset(); }
  reset() { this.pending = []; this.nextSample = 0; this.sourceOffset = 0; this.frameOffset = 0; this.previousSample = 0; }
  push(pcm, endMs) {
    const sourceLength = pcm.length / 2, ratio = this.sampleRate / SAMPLE_RATE;
    // Keep the fractional resampling phase across packets (also handles 44.1 kHz).
    while (this.nextSample < this.sourceOffset + sourceLength - 1) {
      const position = this.nextSample - this.sourceOffset;
      const local = Math.floor(position), fraction = position - local;
      const first = local < 0 ? this.previousSample : pcm.readInt16LE(local * 2) / 32768;
      const second = pcm.readInt16LE((local + 1) * 2) / 32768;
      this.pending.push(first * (1 - fraction) + second * fraction);
      this.nextSample += ratio;
    }
    this.previousSample = sourceLength ? pcm.readInt16LE((sourceLength - 1) * 2) / 32768 : this.previousSample;
    this.sourceOffset += sourceLength;
    const frames = [];
    while (this.pending.length >= HOP) {
      const result = spectrum(this.pending);
      this.pending.splice(0, HOP);
      this.frameOffset += HOP;
      const remainingMs = this.pending.length / SAMPLE_RATE * 1000;
      frames.push({...result, endMs: endMs - remainingMs});
    }
    return frames;
  }
}

function distance(a, matrix, frame) {
  const offset = frame * (DIMENSIONS + 1);
  if (matrix[offset + DIMENSIONS] < 0.0008) return 0.9;
  let dot = 0;
  for (let i = 0; i < DIMENSIONS; i++) dot += a[i] * matrix[offset + i];
  return Math.max(0, 1 - dot);
}

function subsequenceDtw(live, reference, first, last) {
  const length = last - first;
  if (!length || live.length < 8) return null;
  let previous = new Float64Array(length + 1), current = new Float64Array(length + 1);
  let starts = Int32Array.from({length: length + 1}, (_, i) => i), nextStarts = new Int32Array(length + 1);
  for (let i = 0; i < live.length; i++) {
    current.fill(Infinity);
    for (let j = 1; j <= length; j++) {
      const cost = distance(live[i].feature, reference.matrix, first + j - 1);
      const diagonal = previous[j - 1], vertical = previous[j] + 0.025, horizontal = current[j - 1] + 0.025;
      if (diagonal <= vertical && diagonal <= horizontal) {
        current[j] = diagonal + cost; nextStarts[j] = starts[j - 1];
      } else if (vertical <= horizontal) {
        current[j] = vertical + cost; nextStarts[j] = starts[j];
      } else { current[j] = horizontal + cost; nextStarts[j] = nextStarts[j - 1]; }
    }
    [previous, current] = [current, previous]; [starts, nextStarts] = [nextStarts, starts];
  }
  let best = null;
  for (let j = 1; j <= length; j++) {
    const span = j - starts[j];
    if (span < live.length * 0.35 || span > live.length * 2.8) continue;
    const error = previous[j] / live.length;
    if (!best || error < best.error) best = {error, frame: first + j - 1, startFrame: first + starts[j]};
  }
  return best;
}

class AcousticFollower {
  constructor(features, segments) {
    this.reference = decodeFeatures(features);
    this.segments = segments;
    this.reset(0);
  }
  reset(currentIndex) { this.currentIndex = currentIndex; this.live = []; this.frames = 0; this.quietFrames = 0; this.support = null; this.lastPosition = null; this.lastVerified = null; }
  advance(currentIndex) {
    if (currentIndex !== this.currentIndex + 1) { this.reset(currentIndex); return; }
    this.currentIndex = currentIndex;
    // Keep continuous PCM/features, but never carry support for an expired cue.
    if (this.lastPosition?.index < currentIndex) this.lastPosition = null;
    if (this.lastVerified?.index < currentIndex) this.lastVerified = null;
    if (this.support && !this.segments.some(s => s.lineId === this.support.lineId && s.index >= currentIndex)) this.support = null;
  }
  feed(frame, currentIndex) {
    if (currentIndex !== this.currentIndex) this.reset(currentIndex);
    if (frame.rms < 0.001) {
      this.frames = 0;
      this.support = null;
      if (++this.quietFrames >= 3) this.live = [];
      const last = this.lastVerified, segment = this.segments.find(s => s.lineId === last?.lineId);
      if (this.quietFrames >= 3 && last && !last.completed && last.progress >= 0.9 && last.confidence >= 0.9 &&
        segment && segment.end - last.referenceSeconds <= 0.121) {
        this.lastVerified = {...last, progress: 1, completed: true, referenceSeconds: segment.end, audioEndMs: frame.endMs};
        return this.lastVerified;
      }
      return null;
    }
    this.quietFrames = 0;
    this.live.push(frame);
    if (this.live.length > 40) this.live.shift();
    if (++this.frames % 4 !== 0 || this.live.length < 12) return null;
    const candidates = [];
    let eligibleSegments = 0;
    for (const segment of this.segments) {
      if (segment.index < currentIndex || segment.index > currentIndex + 4) continue;
      eligibleSegments++;
      const first = Math.max(0, Math.floor(segment.start * 1000 / FRAME_MS));
      const last = Math.min(this.reference.count, Math.ceil(segment.end * 1000 / FRAME_MS));
      // Limit search to a moving 12-second window for unusually long cues.
      const center = this.lastPosition?.lineId === segment.lineId ? this.lastPosition.referenceSeconds * 1000 / FRAME_MS : first;
      const from = Math.max(first, Math.floor(center - 75));
      const to = Math.min(last, Math.max(from + 300, Math.ceil(center + 200)));
      let match = null;
      for (const length of [12, 24, 40].filter(length => length <= this.live.length)) {
        const candidate = subsequenceDtw(this.live.slice(-length), this.reference, from, to);
        if (candidate && (!match || candidate.error < match.error)) match = {...candidate, liveLength: length};
      }
      if (match) candidates.push({...match, ...segment, referenceSeconds: (match.frame + 1) * FRAME_MS / 1000});
    }
    candidates.sort((a, b) => a.error - b.error);
    const best = candidates[0], runner = candidates[1];
    const confidence = best ? Math.max(0, 1 - best.error) : 0;
    const margin = runner ? runner.error - best.error : null;
    const requiredSupport = best?.status === 'review' || confidence < 0.84 ? 3 : 2;
    const diagnostics = {minimumConfidence: MIN_CONFIDENCE, minimumMargin: MIN_MARGIN, margin,
      liveFrames: this.live.length, eligibleSegments, candidateCount: candidates.length, requiredSupport,
      candidates: candidates.slice(0, 3).map(candidate => ({index: candidate.index, lineId: candidate.lineId,
        segmentStatus: candidate.status, confidence: Math.max(0, 1 - candidate.error), referenceSeconds: candidate.referenceSeconds}))};
    // Lower scores are provisional; repeated material still needs a clear lead.
    if (!best || confidence < MIN_CONFIDENCE || (runner && margin < MIN_MARGIN)) {
      this.support = null;
      return {status: 'searching', reason: !best ? eligibleSegments ? 'no_acoustic_match' : 'no_usable_segments'
        : confidence < MIN_CONFIDENCE ? 'below_threshold' : 'ambiguous', index: best?.index,
        segmentStatus: best?.status, referenceSeconds: best?.referenceSeconds,
        confidence, audioEndMs: frame.endMs, diagnostics: {...diagnostics, supportCount: 0}};
    }
    const consistent = this.support?.lineId === best.lineId && best.frame >= this.support.frame - 2;
    this.support = {lineId: best.lineId, frame: best.frame, count: consistent ? this.support.count + 1 : 1};
    const progress = Math.min(1, Math.max(0, (best.referenceSeconds - best.start) / (best.end - best.start)));
    const confirmed = this.support.count >= requiredSupport;
    const result = {status: confirmed ? 'verified' : 'candidate', lineId: best.lineId, index: best.index,
      reason: confirmed ? 'matched' : 'awaiting_support', segmentStatus: best.status,
      diagnostics: {...diagnostics, supportCount: this.support.count},
      progress, completed: confirmed && best.referenceSeconds >= best.end - 0.08,
      confidence: Math.max(0, 1 - best.error), referenceSeconds: best.referenceSeconds,
      audioEndMs: frame.endMs, audioStartMs: this.live[this.live.length - best.liveLength].endMs - FRAME_MS };
    this.lastPosition = result;
    if (confirmed) this.lastVerified = result;
    return result;
  }
}

module.exports = {SAMPLE_RATE, FRAME_MS, DIMENSIONS, VERSION, extractFeatures, decodeFeatures, StreamingFeatures, AcousticFollower};
