/** Encode PCM16 samples exactly like the browser recorder's `encodeWave`, for offline provider checks. */

/**
 * @param samples - mono samples in [-1, 1].
 * @param sampleRate - canonical recordings are 16 kHz.
 * @returns a canonical 44-byte-header little-endian WAV.
 */
export function encodeWave(samples, sampleRate = 16000) {
  const pcm = Buffer.alloc(samples.length * 2)
  for (const [index, sample] of samples.entries()) {
    pcm.writeInt16LE(Math.max(-1, Math.min(1, sample)) * 32767, index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * Read the PCM payload of any PCM16 WAV produced by another encoder.
 * @param bytes - complete WAV file.
 * @returns mono samples resampled to 16 kHz.
 */
export function decodeWave(bytes) {
  let offset = 12
  let rate
  let data
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    if (id === 'fmt ') rate = bytes.readUInt32LE(offset + 12)
    if (id === 'data') data = bytes.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + (size % 2)
  }
  if (rate === undefined || data === undefined) throw new Error('not a PCM16 WAV file')
  const samples = new Float32Array(Math.round((data.length / 2) * (16_000 / rate)))
  for (let index = 0; index < samples.length; index++) {
    const source = Math.floor((index * rate) / 16_000) * 2
    samples[index] = (data.readInt16LE(source) ?? 0) / 32767
  }
  return samples
}
