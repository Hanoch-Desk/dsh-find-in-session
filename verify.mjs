#!/usr/bin/env node
/**
 * Proof harness for `@local/dsh-find-in-session`.
 *
 * Every check below is anchored to something outside this repository:
 *
 *   - the Host's own shipped source, read out of the installed app.asar, so a
 *     claim about Host behaviour is checked against the build that runs today;
 *   - real session logs written by DSH itself, decoded and replayed through the
 *     Host's own extraction and matching code, so "the plugin agrees with the
 *     Host" is measured on real data instead of on fixtures I invented;
 *   - arithmetic that has a right answer (WCAG contrast ratios, key sets).
 *
 * Run: node verify.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import vm from 'node:vm'

import { readAsarFile } from './tools/asar-read.mjs'
import { decompressAllFrames } from './tools/zstd-frames.mjs'

const ROOT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')
const ASAR = 'C:\\Users\\Hanoc\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const SESSION_QUERY_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-session-query/lib/index.js'
const CHAT_VIEW_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/src/client/chat/ChatView.tsx'
const SESSIONS_ROOT = 'C:\\Users\\Hanoc\\.dsh\\sessions'

const results = []
let failures = 0

/**
 * Record one assertion.
 * @param {string} name - what is being proved.
 * @param {boolean} ok - outcome.
 * @param {string} detail - the measured value, or why it failed.
 * @param {string} prover - which external thing makes this authoritative.
 */
function check(name, ok, detail, prover) {
  results.push({ name, ok, detail, prover })
  if (!ok) failures += 1
}

/** Load the pure-function region (and dictionaries) out of client.js. */
function loadClientContracts() {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const start = source.indexOf('// #region pure-contracts')
  const end = source.indexOf('// #endregion pure-contracts')
  if (start < 0 || end < 0) throw new Error('pure-contracts region not found in client.js')
  const contracts = source.slice(start, end + '// #endregion pure-contracts'.length)

  const dictStart = source.indexOf('const zh = {')
  const dictEnd = source.indexOf('const styles =', dictStart)
  if (dictStart < 0 || dictEnd < 0) throw new Error('dictionary block not found in client.js')
  const dictionaries = source.slice(dictStart, dictEnd)

  const sandbox = { console }
  vm.createContext(sandbox)
  vm.runInContext(
    `${contracts}\n${dictionaries}\nthis.__client = { compileQueryPattern, matchSpans, escapePatternPart, inputIntent, shouldLoadOlder, countParts, noteKey, countText, HIGHLIGHT_TOKENS, MATCH_PAINT_LIMIT, HISTORY_MAX_ROUNDS, zh, en }`,
    sandbox,
  )
  return { source, client: sandbox.__client }
}

/** Load the Host's own extraction + filter code out of the installed asar. */
function loadHostPipeline() {
  const bundle = readAsarFile(ASAR, SESSION_QUERY_ENTRY)
  const regionStart = bundle.indexOf('//#region lib/types/extraction.js')
  const regionEnd = bundle.indexOf('//#endregion', regionStart)
  if (regionStart < 0 || regionEnd < 0) throw new Error('host extraction region not found')
  const extraction = bundle.slice(regionStart, regionEnd)

  const filterStart = bundle.indexOf('function compileSessionTextFilter')
  const filterEnd = bundle.indexOf('function sessionPredicate', filterStart)
  if (filterStart < 0 || filterEnd < 0) throw new Error('host compileSessionTextFilter not found')
  const filter = bundle.slice(filterStart, filterEnd)

  const sandbox = {
    console,
    SessionQueryError: class SessionQueryError extends Error {
      constructor(message, code) {
        super(message)
        this.code = code
      }
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(
    `${extraction}\n${filter}\nthis.__host = { extractSessionEventText, compileSessionTextFilter }`,
    sandbox,
  )
  return { bundle, host: sandbox.__host }
}

/** Largest real session log, decoded to events. */
function loadRealEvents() {
  if (!existsSync(SESSIONS_ROOT)) return { events: [], path: null }
  let best = null
  const stack = [SESSIONS_ROOT]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const info = statSync(full)
      if (info.isDirectory()) stack.push(full)
      else if (name === 'session.v4.jsonl.zstd' && (best === null || info.size > best.size)) {
        best = { path: full, size: info.size }
      }
    }
  }
  if (best === null) return { events: [], path: null }
  const { text } = decompressAllFrames(readFileSync(best.path))
  const events = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* a torn final line is not this harness's business */
    }
  }
  return { events, path: best.path }
}

/** WCAG 2.x relative luminance of a #rrggbb colour. */
function luminance(hex) {
  const value = hex.replace('#', '')
  const channel = offset => {
    const raw = Number.parseInt(value.slice(offset, offset + 2), 16) / 255
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/** WCAG contrast ratio between two #rrggbb colours. */
function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ── 1. Matching semantics agree with the Host ────────────────────────────────
const { source: clientSource, client } = loadClientContracts()
const { host } = loadHostPipeline()

const PROBES = [
  'hello',
  'Hello World',
  'hello   world',
  ' hello\tworld ',
  'a.b',
  '.*',
  '[unclosed',
  '中文 检索',
  'seq 13',
  'TypeError: boom',
]
let semanticMismatch = []
for (const probe of PROBES) {
  const mine = client.compileQueryPattern(probe)
  // The Host throws only for blank filters; every probe here is non-blank.
  const theirs = host.compileSessionTextFilter(probe)
  if (mine.source !== theirs.source || mine.flags !== theirs.flags) {
    semanticMismatch.push(`${JSON.stringify(probe)}: ${mine.source}/${mine.flags} vs ${theirs.source}/${theirs.flags}`)
  }
}
check(
  'D1 查询编译与宿主 compileSessionTextFilter 逐字等价',
  semanticMismatch.length === 0,
  semanticMismatch.length === 0
    ? `${PROBES.length} 组探针（含正则元字符、中文、制表符）编译出的 source/flags 完全一致`
    : semanticMismatch.join(' | '),
  '宿主 asar 内 dsh-session-query/lib/index.js 的 compileSessionTextFilter',
)

check(
  'D1 空查询不抛错（宿主是过滤器契约，查找框必须安静）',
  client.compileQueryPattern('   ') === null &&
    (() => {
      try {
        host.compileSessionTextFilter('   ')
        return false
      } catch (error) {
        return error.code === 'SESSION_QUERY_INVALID_FILTER'
      }
    })(),
  '插件返回 null；宿主抛 SESSION_QUERY_INVALID_FILTER，差异是有意的',
  '同上，异常分支取 SESSION_QUERY_INVALID_FILTER',
)

check(
  'D1 大小写不敏感',
  client.compileQueryPattern('HeLLo').test('say hello') === true &&
    client.compileQueryPattern('hello').test('say HELLO') === true,
  '两种方向都命中',
  '宿主 flags = iu',
)

check(
  'D1 空白弹性（旧实现 indexOf 做不到，这是 D1 的原始缺陷）',
  client.compileQueryPattern('hello world').test('hello\t\t world') === true &&
    client.compileQueryPattern('hello world').test('hello\nworld') === true &&
    client.compileQueryPattern('hello world').test('helloworld') === false,
  '制表符与换行跨过；无空白则不命中',
  '宿主把用户空白折成 \\s+',
)

check(
  'D1 字面量安全（用户输入不产生正则语义）',
  client.compileQueryPattern('.*').test('anything') === false &&
    client.compileQueryPattern('a.b').test('axb') === false &&
    client.compileQueryPattern('a.b').test('a.b') === true,
  '.* 与 a.b 都只按字面匹配',
  '宿主对每段做正则转义',
)

const singleSpan = client.matchSpans('say hello world', client.compileQueryPattern('hello world'))
check(
  'D1 跨空白匹配仍产生单一区段',
  singleSpan.length === 1 && singleSpan[0].start === 4 && singleSpan[0].end === 15,
  JSON.stringify(singleSpan),
  '区间用于 DOM Range，必须是一个连续区段',
)

// ── 2. Real session logs: Host pipeline vs plugin, same answers ──────────────
const { events, path: sessionPath } = loadRealEvents()
if (events.length === 0) {
  check('D1 真实会话日志对照', false, '未找到任何 session.v4.jsonl.zstd', '宿主自己写的会话日志')
} else {
  const docs = []
  for (const event of events) {
    const text = host.extractSessionEventText(event)
    if (text !== '') docs.push(text)
  }
  check(
    'D1 宿主抽取器跑通真实日志',
    docs.length > 100,
    `${sessionPath} → ${events.length} 事件，${docs.length} 条可搜文本`,
    '宿主自己的 extractSessionEventText',
  )

  const QUERIES = ['hello', 'DeepSeek  Harness', 'deepseek\tharness', 'the', 'seq', '工具 调用', 'plugin:translator']
  let divergent = []
  let totalHits = 0
  const started = performance.now()
  for (const query of QUERIES) {
    const hostRe = host.compileSessionTextFilter(query)
    const mine = client.compileQueryPattern(query)
    for (const doc of docs) {
      const hostHit = hostRe.test(doc) ? 1 : 0
      const mineSpans = client.matchSpans(doc, mine).length
      totalHits += mineSpans
      if (hostHit !== (mineSpans > 0 ? 1 : 0)) {
        divergent.push(`${JSON.stringify(query)} @ ${JSON.stringify(doc.slice(0, 40))}`)
        break
      }
    }
  }
  const elapsed = performance.now() - started
  check(
    'D1 逐条文档与宿主判定一致（真实日志）',
    divergent.length === 0,
    divergent.length === 0
      ? `${QUERIES.length} 条查询 × ${docs.length} 条文档无分歧，共 ${totalHits} 处命中`
      : divergent.join(' | '),
    '同一批真实事件文本分别喂给宿主正则与插件正则',
  )
  check(
    'D5 单次全量匹配性能预算（${QUERIES.length} 条查询 × 全部文档 < 2000ms）',
    elapsed < 2000,
    `${elapsed.toFixed(1)}ms`,
    'performance.now 实测，不是估计',
  )
}

// ── 3. Counting honesty (D2) ─────────────────────────────────────────────────
const hasSilentTruncation = /new Highlight\(\.\.\.\s*ranges\.slice\(0,\s*MATCH_PAINT_LIMIT\)/.test(clientSource)
check(
  'D2 高亮不再静默截断（slice 被具名变量 + 计数承接）',
  !hasSilentTruncation && /const paintedRanges = ranges\.slice\(0, MATCH_PAINT_LIMIT\)/u.test(clientSource),
  hasSilentTruncation ? '发现静默截断写法' : 'paintedRanges 具名接管，painted 被记录',
  '源码内联断言（对旧实现 4000 静默丢弃的直接反例）',
)

check(
  'D2 截断状态被显式发布为 capped',
  /painting:\s*!canHighlight\(\)\s*\?\s*'unsupported'\s*:\s*painted < ranges\.length \? 'capped' : 'ok'/u.test(
    clientSource,
  ),
  'painted < total → capped；无 Highlight API → unsupported',
  'report() 的返回值决定 UI 文案',
)

const cappedState = { history: 'idle', painting: 'capped', total: 5000, painted: 4000, position: 1 }
check(
  'D2 capped 时计数文案分开报“命中总数 / 实际高亮数”',
  client.countParts(cappedState).key === 'find.capped' &&
    client.countParts(cappedState).params.painted === 4000 &&
    client.countParts(cappedState).params.total === 5000,
  JSON.stringify(client.countParts(cappedState)),
  '总数与已绘制数不混成一个数字',
)

check(
  'D2 侧栏计数在 capped 时带 +',
  client.countText(cappedState) === '5000+' && client.countText({ ...cappedState, painting: 'ok' }) === '5000',
  `${client.countText(cappedState)} / ${client.countText({ ...cappedState, painting: 'ok' })}`,
  '侧栏与查找条对同一状态给出同一事实',
)

check(
  'D2 无 Highlighter 支持时明确说“无法高亮”而不是假装 0 命中',
  client.noteKey({ history: 'idle', painting: 'unsupported', total: 12 }) === 'find.unsupported',
  client.noteKey({ history: 'idle', painting: 'unsupported', total: 12 }),
  'painting=unsupported 分支',
)

// ── 4. Paging is delegated to the Host, never re-implemented (D3) ────────────
const chatView = readAsarFile(ASAR, CHAT_VIEW_ENTRY)
const hostHistoryContract = /data-chat-history=\{historyLoadStatus\}/u.test(chatView) &&
  /onClick=\{scroll\.loadEarlier\}/u.test(chatView) &&
  /disabled=\{!hasMore\}/u.test(chatView)
check(
  'D3 宿主仍提供 [data-chat-history] + loadEarlier 按钮（插件依赖的契约还在）',
  hostHistoryContract,
  hostHistoryContract ? 'ChatView.tsx 三处特征齐全' : '宿主契约已变，插件必须跟着改',
  '安装包内 dsh-client-ui-chat/src/client/chat/ChatView.tsx',
)

check(
  'D3 插件点击宿主按钮，而不是自己发明分页',
  /box\.querySelector\('button'\)/u.test(clientSource) && /button\.click\(\)/u.test(clientSource),
  'expand() 里 querySelector(button) + click()',
  '宿主 loadEarlier 的副作用由宿主负责',
)

check(
  'D3 插件没有绕过宿主直接调 loadOlder / loadThrough',
  !/\bloadOlder\s*\(/u.test(clientSource) && !/\bloadThrough\s*\(/u.test(clientSource),
  'client.js 中不存在这两个调用',
  '任何自造分页都会与宿主的补页/重分页逻辑冲突',
)

check(
  'D3 只在宿主空闲或报错时才请求下一页',
  client.shouldLoadOlder({ present: true, disabled: false, status: 'idle', rounds: 0 }) === true &&
    client.shouldLoadOlder({ present: true, disabled: false, status: 'loading', rounds: 0 }) === false &&
    client.shouldLoadOlder({ present: true, disabled: false, status: 'pendingConsumption', rounds: 0 }) === false &&
    client.shouldLoadOlder({ present: true, disabled: true, status: 'idle', rounds: 0 }) === false &&
    client.shouldLoadOlder({ present: true, disabled: false, status: 'idle', rounds: client.HISTORY_MAX_ROUNDS }) ===
      false,
  'idle/error 放行；loading、pendingConsumption、按钮禁用、超出轮数全部拒绝',
  '宿主 historyLoadStatus 词表（use-chat-scroll.ts 实测值）',
)

// ── 5. Theme tokens, contrast, IME, a11y (D4) ────────────────────────────────
const tokens = client.HIGHLIGHT_TOKENS
const everyTokenDualMode = Object.values(tokens).every(
  modes => typeof modes === 'object' && /^#[0-9a-f]{6}$/iu.test(modes.light) && /^#[0-9a-f]{6}$/iu.test(modes.dark),
)
check(
  'D4 高亮色全部注册为深浅双模主题令牌',
  Object.keys(tokens).length === 4 && everyTokenDualMode,
  `${Object.keys(tokens).length} 个令牌，light/dark 齐全`,
  'theme.overrideTokens 契约要求 { light, dark }，裸字符串会抛 teaching error',
)

const highlightRules = [...clientSource.matchAll(/\*::highlight\([^)]*\)\{([^}]*)\}/gu)].map(match => match[1])
check(
  'D4 ::highlight 规则只引用令牌，不写死颜色',
  highlightRules.length === 2 &&
    highlightRules.every(rule => /var\(--dfis-[a-z-]+/u.test(rule)) &&
    highlightRules.every(rule => !/(?<!var\(--dfis-[a-z-]{3,30},)(#[0-9a-f]{3,8})\b(?![^)]*\))/iu.test(rule)),
  `${highlightRules.length} 条规则全部走 var(--dfis-*)`,
  '旧实现里 #ffb020 是唯一不受主题控制的颜色',
)

const contrastReport = []
let contrastOk = true
for (const suffix of ['match', 'active']) {
  const bg = tokens[`--dfis-${suffix}-bg`]
  const fg = tokens[`--dfis-${suffix}-fg`]
  for (const mode of ['light', 'dark']) {
    const ratio = contrast(bg[mode], fg[mode])
    contrastReport.push(`${suffix}/${mode} ${ratio.toFixed(2)}`)
    if (ratio < 4.5) contrastOk = false
  }
}
check(
  'D4 高亮前景/背景对比度全部 ≥ 4.5（WCAG AA 正文）',
  contrastOk,
  contrastReport.join('，'),
  'WCAG 2.x 相对亮度公式，可独立复算',
)

check(
  'D4 IME 组词期间的回车/Esc 不会被当成跳转或关闭',
  client.inputIntent({ key: 'Enter' }, true) === null &&
    client.inputIntent({ key: 'Escape' }, true) === null &&
    client.inputIntent({ key: 'Enter', isComposing: true }, false) === null &&
    client.inputIntent({ key: 'Enter', keyCode: 229 }, false) === null,
  'composing 标记 / isComposing / keyCode 229 三条通道都被拦下',
  '中文输入法选词时物理按下的是同一个 Enter 键',
)

check(
  'D4 键盘意图矩阵正确（Enter/F3 下一处，Shift 反向，Esc 关闭）',
  client.inputIntent({ key: 'Enter' }, false) === 'next' &&
    client.inputIntent({ key: 'F3' }, false) === 'next' &&
    client.inputIntent({ key: 'Enter', shiftKey: true }, false) === 'previous' &&
    client.inputIntent({ key: 'F3', shiftKey: true }, false) === 'previous' &&
    client.inputIntent({ key: 'Escape' }, false) === 'close' &&
    client.inputIntent({ key: 'a' }, false) === null,
  'Enter/F3/Shift+Enter/Shift+F3/Escape 全对，普通字符不拦截',
  '函数是纯的，逐条可验',
)

const a11y = {
  roleSearch: /role:\s*'search'/u.test(clientSource),
  roleStatus: /role:\s*'status'/u.test(clientSource),
  countDescribed: /'aria-describedby':\s*COUNT_ID/u.test(clientSource),
  keyShortcuts: /'aria-keyshortcuts':\s*'Enter Shift\+Enter Escape F3'/u.test(clientSource),
  entryShortcut: /'aria-keyshortcuts':\s*'Control\+F Meta\+F'/u.test(clientSource),
  busy: /'aria-busy':\s*state\.history === 'loading'/u.test(clientSource),
}
check(
  'D4 无障碍语义齐备（search 角色 / status 播报 / describedby / 快捷键声明 / busy）',
  Object.values(a11y).every(Boolean),
  JSON.stringify(a11y),
  'ARIA 属性可直接被辅助技术读取，也可静态核对',
)

// ── 6. Area lock + dictionaries + docs (D5) ──────────────────────────────────
const slotRegistrations = [...clientSource.matchAll(/ctx\.slots\.register\(\{\s*name:\s*'([^']+)',\s*id:\s*'([^']+)'/gu)]
check(
  '面积锁定：仍然只有查找条与侧栏入口两个注册点',
  slotRegistrations.length === 2 &&
    slotRegistrations[0][2] === 'find-in-session.bar' &&
    slotRegistrations[1][2] === 'find-in-session.entry',
  slotRegistrations.map(match => `${match[1]}#${match[2]}`).join(' , ') || '未匹配到注册点',
  '与 v1.0.0 的注册面完全相同，只加深不扩大',
)

check(
  '面积锁定：没有新增设置页/面板/第二个搜索框',
  !/settings\.|panel\.|openRightbar|window\.open|iframe/u.test(clientSource),
  '无设置、无面板、无新窗口 API',
  '用户要求“更深入而不是更大”',
)

const usedKeys = new Set([...clientSource.matchAll(/'(find\.[a-zA-Z]+)'/gu)].map(match => match[1]))
const zhMissing = [...usedKeys].filter(key => !(key in client.zh))
const enMissing = [...usedKeys].filter(key => !(key in client.en))
const zhExtra = Object.keys(client.zh).filter(key => !usedKeys.has(key))
check(
  'D5 文案单一数据源：每个用到的键在中英字典里都存在',
  zhMissing.length === 0 && enMissing.length === 0,
  `用到 ${usedKeys.size} 个键；缺 zh: [${zhMissing}]，缺 en: [${enMissing}]；未使用: [${zhExtra}]`,
  '键集合是静态可枚举的，缺一个就会在界面上露出原键名',
)

const zhJson = JSON.parse(readFileSync(join(ROOT, 'locale/zh.json'), 'utf8'))
const enJson = JSON.parse(readFileSync(join(ROOT, 'locale/en.json'), 'utf8'))
const detailTargets = [zhJson.meta.detail, enJson.meta.detail].filter(value => typeof value === 'string')
check(
  'D5 locale 元数据声明了详情文档，且文件真的存在',
  detailTargets.length === 2 && detailTargets.every(target => existsSync(join(ROOT, target))),
  detailTargets.map(target => `${target}${existsSync(join(ROOT, target)) ? '' : '(缺失)'}`).join(' , '),
  'dsh-plugin-detail 只认 locale meta.detail 指向的包内文件',
)

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
check(
  'D5 打包清单包含 docs 与主题依赖',
  (pkg.files ?? []).includes('docs/*') && (pkg.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-ui-theme'),
  `files 有 docs/*: ${(pkg.files ?? []).includes('docs/*')}；inject theme: ${(pkg.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-ui-theme')}`,
  '缺 docs/* 则详情页看不到图；缺 theme 则 ctx.theme 为 undefined',
)

const previewOk = existsSync(join(ROOT, 'docs/preview.svg')) &&
  /<svg[\s\S]*<\/svg>/u.test(readFileSync(join(ROOT, 'docs/preview.svg'), 'utf8'))
check('D5 预览图存在且是合法 SVG', previewOk, previewOk ? 'docs/preview.svg 可解析' : '缺失或不是 SVG', 'dsh-plugin-detail 的图片白名单包含 .svg')

// ── Report ───────────────────────────────────────────────────────────────────
const width = results.reduce((max, item) => Math.max(max, item.name.length), 0)
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`)
  console.log(`      ${item.detail}`)
  console.log(`      证明者: ${item.prover}`)
}
console.log('')
console.log(`${results.length - failures}/${results.length} 通过${failures === 0 ? ' — 全绿' : `，${failures} 项失败`}`)
void width
process.exit(failures === 0 ? 0 : 1)
