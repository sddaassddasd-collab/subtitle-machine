// Lossless PCM wire format. Browser/server copies are checked for compatibility
// so either package can deploy with an independent Render Root Directory. Each 64-sample block
// uses fixed-width deltas, or raw PCM when that is smaller. No codec, sample
// rate or provider-audio changes; silence and quiet input need far fewer bytes.
export const AUDIO_WIRE = 'delta-pcm-v1'
const HEADER = 40, BLOCK = 64, MAGIC = 0x534d

export function encodeAudioPacket(packet, epoch) {
  const pcm = new Int16Array(packet.pcm), packed = [], put = value => packed.push(value & 255)
  let previous = 0
  for (let from = 0; from < pcm.length; from += BLOCK) {
    const count = Math.min(BLOCK, pcm.length - from), codes = []
    let maximum = 0
    for (let i = 0; i < count; i++) {
      const value = pcm[from + i], delta = value - previous
      const code = delta < 0 ? -delta * 2 - 1 : delta * 2
      codes.push(code); maximum = Math.max(maximum, code); previous = value
    }
    const bits = maximum ? Math.ceil(Math.log2(maximum + 1)) : 0
    put(Math.min(16, bits))
    if (bits >= 16) {
      for (let i = 0; i < count; i++) {put(pcm[from + i]); put(pcm[from + i] >> 8)}
    } else {
      let accumulator = 0, held = 0
      for (const code of codes) {
        accumulator |= code << held; held += bits
        while (held >= 8) {put(accumulator); accumulator >>>= 8; held -= 8}
      }
      if (held) put(accumulator)
    }
  }
  const compressed = packed.length < pcm.byteLength
  const bytes = new Uint8Array(HEADER + (compressed ? packed.length : pcm.byteLength)), view = new DataView(bytes.buffer)
  view.setUint16(0, MAGIC, true); view.setUint8(2, 1); view.setUint8(3, compressed ? 1 : 0)
  view.setUint32(4, packet.sequence, true); view.setFloat64(8, packet.capturedAt, true)
  view.setFloat64(16, packet.sourceEndMs, true); view.setFloat32(24, packet.captureAgeMs || 0, true)
  view.setUint32(28, Math.min(0xffffffff, Math.max(0, Math.round(packet.droppedInputMs || 0))), true)
  view.setUint16(32, pcm.length, true); view.setUint32(36, epoch >>> 0, true)
  if (compressed) bytes.set(packed, HEADER)
  else for (let i = 0; i < pcm.length; i++) view.setInt16(HEADER + i * 2, pcm[i], true)
  return bytes.buffer
}

export function decodeAudioPacket(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  if (bytes.length < HEADER || bytes.length > HEADER + 4800) throw new Error('invalid_audio_wire')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint16(32, true)
  if (view.getUint16(0, true) !== MAGIC || view.getUint8(2) !== 1 || view.getUint8(3) > 1 || !count || count > 2400)
    throw new Error('invalid_audio_wire')
  const packet = {sequence: view.getUint32(4, true), capturedAt: view.getFloat64(8, true),
    sourceEndMs: view.getFloat64(16, true), captureAgeMs: view.getFloat32(24, true),
    droppedInputMs: view.getUint32(28, true), epoch: view.getUint32(36, true), durationMs: count / 24}
  if (!packet.sequence || !Number.isFinite(packet.capturedAt) || !Number.isFinite(packet.sourceEndMs) ||
    !Number.isFinite(packet.captureAgeMs) || packet.captureAgeMs < 0 || packet.sourceEndMs < packet.durationMs - 1)
    throw new Error('invalid_audio_wire')
  const pcm = new Int16Array(count)
  let offset = HEADER, previous = 0
  if (view.getUint8(3) === 0) {
    if (bytes.length !== HEADER + count * 2) throw new Error('invalid_audio_wire')
    for (let i = 0; i < count; i++) pcm[i] = view.getInt16(offset + i * 2, true)
    offset = bytes.length
  } else for (let from = 0; from < count; from += BLOCK) {
    if (offset >= bytes.length) throw new Error('invalid_audio_wire')
    const bits = bytes[offset++], size = Math.min(BLOCK, count - from)
    const length = bits === 16 ? size * 2 : Math.ceil(size * bits / 8)
    if (bits > 16 || offset + length > bytes.length) throw new Error('invalid_audio_wire')
    let accumulator = 0, held = 0, read = offset
    for (let i = 0; i < size; i++) {
      if (bits === 16) previous = view.getInt16(offset + i * 2, true)
      else {
        while (held < bits) {accumulator |= bytes[read++] << held; held += 8}
        const code = accumulator & ((1 << bits) - 1)
        accumulator >>>= bits; held -= bits
        previous += code & 1 ? -(code + 1) / 2 : code / 2
        if (previous < -32768 || previous > 32767) throw new Error('invalid_audio_wire')
      }
      pcm[from + i] = previous
    }
    offset += length
  }
  if (offset !== bytes.length) throw new Error('invalid_audio_wire')
  return {...packet, pcm: pcm.buffer, sourceStartMs: packet.sourceEndMs - packet.durationMs}
}
