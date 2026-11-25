#!/usr/bin/env node
/**
 * Read an Electron asar archive, without dependencies.
 *
 * Electron's asar layout: an 8-byte pickle prefix, a 4-byte UInt32LE header
 * length, then a JSON directory tree, then the concatenated file payloads.
 * Each entry's `offset` is relative to the start of the payload section.
 *
 * `verify.mjs` uses this to read the Host's shipped source at check time, so
 * every claim about host behaviour is proved against the installed build
 * instead of against a copy that may have drifted.
 */
import { readFileSync } from 'node:fs'

/**
 * Directory tree entries, keyed by `/`-separated path.
 *
 * Layout: `u32@0` is the size-pickle payload (always 4); `u32@4` is the whole
 * header pickle size, so payloads start at `8 + u32@4`; inside the pickle,
 * `u32@12` is the JSON string length and the JSON begins at byte 16. Reading
 * the data section from `8 + u32@12` instead silently shifts every file by the
 * tail of its predecessor — the bug this comment exists to prevent.
 */
function indexTree(buf) {
  const headerSize = buf.readUInt32LE(4)
  const jsonLength = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + jsonLength).toString('utf8'))
  const files = new Map()
  const walk = (node, prefix) => {
    if (!node.files) return
    for (const [name, child] of Object.entries(node.files)) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (child.files) walk(child, path)
      else files.set(path, child)
    }
  }
  walk(header, '')
  return { files, dataStart: 8 + headerSize }
}

/**
 * Open an archive once and read many entries out of it.
 *
 * Reading one entry at a time re-reads the whole file, which is fine for a
 * single lookup and hopeless for a scan of twenty thousand entries.
 * @param {string} asarPath - path of the `.asar` archive.
 */
export function openAsar(asarPath) {
  const buf = readFileSync(asarPath)
  const { files, dataStart } = indexTree(buf)
  return {
    /** Every packed entry as `[path, entry]`, in archive order. */
    entries: () => [...files.entries()],
    /** One entry's bytes as UTF-8, or `null` when it is unpacked or missing. */
    read(entryPath) {
      const entry = files.get(entryPath)
      if (entry === undefined) throw new Error(`asar entry not found: ${entryPath}`)
      if (entry.unpacked) return null
      const start = dataStart + Number(entry.offset)
      return buf.subarray(start, start + Number(entry.size)).toString('utf8')
    },
  }
}

/**
 * Read one entry as UTF-8 text.
 * @param {string} asarPath - path of the `.asar` archive.
 * @param {string} entryPath - `/`-separated path of the entry inside it.
 * @returns {string} the entry's bytes decoded as UTF-8.
 * @throws when the archive or the entry does not exist.
 */
export function readAsarFile(asarPath, entryPath) {
  const archive = readFileSync(asarPath)
  const { files, dataStart } = indexTree(archive)
  const entry = files.get(entryPath)
  if (entry === undefined) throw new Error(`asar entry not found: ${entryPath}`)
  if (entry.unpacked) throw new Error(`asar entry is unpacked, read it from disk: ${entryPath}`)
  const start = dataStart + Number(entry.offset)
  return archive.subarray(start, start + Number(entry.size)).toString('utf8')
}

/** Whether the archive contains the entry. */
export function hasAsarFile(asarPath, entryPath) {
  return indexTree(readFileSync(asarPath)).files.has(entryPath)
}
