#!/usr/bin/env node
/**
 * Inspect the installed DSH app.asar from the outside, with no dependencies.
 *
 * Everything the find bar assumes about the Host — DOM attributes, theme token
 * names, which events carry searchable text — has to come from the build that
 * is actually installed, not from documentation. That read-only surface is what
 * this one CLI provides.
 *
 * Subcommands:
 *   find <ext>              list entries whose path ends with <ext>
 *   grep <literal>          show every entry containing <literal>, with context
 *   tokens                  list every `--dsw-*` name the app defines
 *   tokens --verify <file>  check each `var(--dsw-*)` in <file> is defined
 *   read <entry>            print one entry to stdout
 *
 * usage: node tools/host-inventory.mjs <subcommand> [...]
 *
 * The asar layout is an 8-byte pickle prefix, a UInt32LE whole-pickle size at
 * byte 4, a UInt32LE JSON length at byte 12, the JSON tree at byte 16, then the
 * payloads — so payload byte 0 sits at `8 + u32@4`. Reading from `8 + u32@12`
 * instead (a mistake this repo has already made once) shifts every file by the
 * header pickle's padding and prepends the previous file's tail.
 */
import { readFileSync } from 'node:fs'

const ASAR = 'C:/Users/Hanoc/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'

/** Parse the archive directory into `[path, entry]` pairs plus the payload base. */
function openArchive() {
  const buf = readFileSync(ASAR)
  const headerSize = buf.readUInt32LE(4)
  const jsonLength = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + jsonLength).toString('utf8'))
  const entries = []
  const walk = (node, prefix) => {
    if (!node.files) return
    for (const [name, child] of Object.entries(node.files)) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (child.files) walk(child, path)
      else entries.push([path, child])
    }
  }
  walk(header, '')
  return { buf, entries, dataStart: 8 + headerSize }
}

/** Read one entry's bytes as UTF-8; `null` when it is packed elsewhere. */
function readEntry(buf, dataStart, entry) {
  if (entry.unpacked) return null
  const start = dataStart + Number(entry.offset)
  return buf.subarray(start, start + Number(entry.size)).toString('utf8')
}

/** Text-bearing entries worth scanning; skips binaries and huge bundles. */
function isText(path, entry, budget = 4_000_000) {
  return !entry.unpacked && Number(entry.size) <= budget && /\.(cjs|css|js|mjs|ts|tsx?|json|md)$/.test(path)
}

const [, , command, ...rest] = process.argv
const { buf, entries, dataStart } = openArchive()

if (command === 'find') {
  const suffix = (rest[0] ?? '.css').startsWith('.') ? rest[0] : `.${rest[0]}`
  const limit = Number.parseInt(rest[1] ?? '40', 10)
  let shown = 0
  for (const [path, entry] of entries) {
    if (!path.endsWith(suffix)) continue
    console.log(`${String(entry.size).padStart(9)}  ${path}`)
    if (++shown >= limit) break
  }
  console.log(`--- ${shown} entries ending with ${suffix}`)
} else if (command === 'grep') {
  const needle = rest[0]
  const maxHits = Number.parseInt(rest[1] ?? '20', 10)
  if (!needle) {
    console.error('usage: node tools/host-inventory.mjs grep <literal> [maxHits]')
    process.exit(2)
  }
  let hits = 0
  for (const [path, entry] of entries) {
    if (hits >= maxHits) break
    if (entry.unpacked || Number(entry.size) > 8_000_000) continue
    const text = readEntry(buf, dataStart, entry)
    if (text === null) continue
    for (let at = text.indexOf(needle); at !== -1 && hits < maxHits; at = text.indexOf(needle, at + needle.length)) {
      hits += 1
      const from = Math.max(0, at - 90)
      const to = Math.min(text.length, at + needle.length + 90)
      console.log(`${path}\n    …${text.slice(from, to).replace(/\s+/g, ' ')}…\n`)
    }
  }
  console.log(`--- ${hits} hit(s) for ${JSON.stringify(needle)}`)
} else if (command === 'tokens') {
  const defined = new Map()
  for (const [path, entry] of entries) {
    if (!isText(path, entry)) continue
    const text = readEntry(buf, dataStart, entry)
    if (text === null) continue
    const site = path.replace('dsh/node_modules/@deepseek-ai/', '')
    // A declaration (`--x:`) and a runtime write (`setProperty('--x'`) are both
    // real definitions; a bare `var(--x)` reference is not.
    for (const match of text.matchAll(/(--d(?:sw|sh)-[a-z0-9-]+)\s*:|setProperty\(\s*['"](--d(?:sw|sh)-[a-z0-9-]+)['"]/g)) {
      const name = match[1] ?? match[2]
      if (!defined.has(name)) defined.set(name, site)
    }
  }
  const verifyIndex = rest.indexOf('--verify')
  if (verifyIndex === -1) {
    for (const name of [...defined.keys()].sort()) console.log(`${name}  (${defined.get(name)})`)
    console.log(`--- ${defined.size} defined --dsw-* / --dsh-* names`)
  } else {
    const file = rest[verifyIndex + 1]
    const source = readFileSync(file, 'utf8')
    // Two ways to read a custom property without CSS: `var(--x)` inside a
    // stylesheet string, and `getPropertyValue('--x')` at runtime. Both make
    // the same silent-fallback assumption, so both must be checked.
    const wanted = new Set([
      ...[...source.matchAll(/var\((--d(?:sw|sh)-[a-z0-9-]+)/g)].map(match => match[1]),
      ...[...source.matchAll(/getPropertyValue\(\s*['"](--d(?:sw|sh)-[a-z0-9-]+)['"]/g)].map(match => match[1]),
    ])
    let missing = 0
    for (const name of [...wanted].sort()) {
      if (defined.has(name)) console.log(`DEFINED    ${name}  (${defined.get(name)})`)
      else {
        missing += 1
        console.log(`UNDEFINED  ${name}`)
      }
    }
    console.log(`--- ${wanted.size} names read by ${file}, ${missing} undefined`)
    if (missing > 0) process.exit(1)
  }
} else if (command === 'read') {
  const path = rest[0]
  const entry = entries.find(([candidate]) => candidate === path)
  if (!entry) {
    console.error(`not found: ${path}`)
    process.exit(1)
  }
  const text = readEntry(buf, dataStart, entry[1])
  if (text === null) {
    console.error(`unpacked, read from disk: ${path}`)
    process.exit(1)
  }
  process.stdout.write(text)
} else {
  console.error('usage: node tools/host-inventory.mjs <find|grep|tokens|read> [...]')
  process.exit(2)
}
