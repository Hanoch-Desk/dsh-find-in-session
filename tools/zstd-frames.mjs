/**
 * Decode a concatenated-multi-frame zstd file (DSH writes session logs as a
 * sequence of independently compressed frames appended to one .zstd file).
 *
 * Node's built-in zstd only decodes the FIRST frame of a buffer, so we split
 * the file on zstd frame magic and decode each candidate slice, merging slices
 * whenever a decompression attempt fails (a frame may legitimately contain the
 * magic byte sequence inside its compressed payload).
 */
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Byte offsets where a zstd frame magic appears. */
function magicOffsets(buf) {
  const offsets = []
  let at = 0
  for (;;) {
    const found = buf.indexOf(MAGIC, at)
    if (found < 0) return offsets
    offsets.push(found)
    at = found + MAGIC.length
  }
}

/**
 * Decompress every frame of a concatenated zstd buffer.
 * @param {Buffer} buf
 * @returns {{ text: string, frames: number, bytes: number }}
 */
export function decompressAllFrames(buf) {
  const offsets = magicOffsets(buf)
  if (offsets.length === 0) throw new Error('no zstd frame magic found')

  const parts = []
  let frames = 0
  let start = offsets[0]
  let candidate = 1

  while (start < buf.length) {
    // Grow the slice until it decodes as exactly one frame, then advance.
    let end = candidate < offsets.length ? offsets[candidate] : buf.length
    let decoded = null
    for (;;) {
      const slice = buf.subarray(start, end)
      try {
        decoded = zstdDecompressSync(slice)
        break
      } catch (cause) {
        if (candidate + 1 >= offsets.length && end === buf.length) throw cause
        candidate += 1
        end = candidate < offsets.length ? offsets[candidate] : buf.length
        if (end <= start) throw cause
      }
    }
    parts.push(decoded)
    frames += 1
    start = end
    candidate += 1
    if (end >= buf.length) break
  }

  return { text: Buffer.concat(parts).toString('utf8'), frames, bytes: buf.length }
}
