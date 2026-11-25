#!/usr/bin/env node
/**
 * Extract files out of an Electron asar archive without any dependency.
 *
 * Electron's asar layout: an 8-byte pickle prefix, a 4-byte UInt32LE header
 * length, then a JSON directory tree, then the concatenated file payloads.
 * Each entry's `offset` is relative to the start of the payload section.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ASAR = 'C:\\Users\\Hanoc\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'

/**
 * Flatten the asar directory tree into a path -> entry map.
 *
 * `u32@0` is the size-pickle payload (always 4); `u32@4` is the whole header
 * pickle size, so payloads start at `8 + u32@4`. `u32@12` is only the JSON
 * string length — using it shifts every entry by the tail of its predecessor.
 */
function indexTree(buf) {
  const headerSize = buf.readUInt32LE(4)
  const jsonLength = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + jsonLength).toString('utf8'))
  const dataStart = 8 + headerSize

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
  return { files, dataStart }
}

const archive = readFileSync(ASAR)
const { files, dataStart } = indexTree(archive)

const [, , outDir, ...paths] = process.argv
if (!outDir) {
  console.error('usage: asar-extract.mjs <outDir> <path...>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

let missing = 0
for (const path of paths) {
  const entry = files.get(path)
  if (entry === undefined) {
    console.error(`MISSING ${path}`)
    missing += 1
    continue
  }
  if (entry.unpacked) {
    const unpacked = join(dirname(ASAR) + '.unpacked', path)
    const text = readFileSync(unpacked, 'utf8')
    const out = join(outDir, path.replace(/[/\\]/g, '__'))
    writeFileSync(out, text)
    console.log(`UNPACKED ${entry.size}\t${out}`)
    continue
  }
  const text = archive
    .subarray(dataStart + Number(entry.offset), dataStart + Number(entry.offset) + Number(entry.size))
    .toString('utf8')
  const out = join(outDir, path.replace(/[/\\]/g, '__'))
  writeFileSync(out, text)
  console.log(`${entry.size}\t${out}`)
}
process.exit(missing === 0 ? 0 : 1)
