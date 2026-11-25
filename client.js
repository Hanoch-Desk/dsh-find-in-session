window.__ModuleLoader__.load({
  id: '@local/dsh-find-in-session',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Browser-side locale namespace owned by this bundle. */
    const NS = 'find-in-session'
    /** Identity of the stylesheet this bundle injects. */
    const STYLE_KEY = '@local/dsh-find-in-session/find-bar.css'
    const MATCH_HIGHLIGHT = 'dfis-match'
    const ACTIVE_HIGHLIGHT = 'dfis-active'
    /** Above DSH's own overlay entries (z-index 20) and below app dialogs. */
    const BAR_Z_INDEX = 40
    const SEARCH_DEBOUNCE_MS = 20
    /**
     * Chromium commits an IME candidate with `compositionend` *before* the
     * confirming `keydown`, and that keydown reports `isComposing === false`.
     * Without a short grace window the Enter that only accepts the candidate
     * would jump to the next match — and be `preventDefault`ed, sometimes
     * discarding the commit — for every phrase typed through an IME.
     */
    const IME_COMMIT_GUARD_MS = 60
    /** How long the count is allowed to settle before it is announced. */
    const ANNOUNCE_DELAY_MS = 500

    // #region pure-contracts
    /**
     * `new Highlight(...ranges)` costs one argument per match, so the paint
     * layer stops here. The number shown to people is always the real match
     * count; matches past this limit are labelled, never silently dropped.
     */
    const MATCH_PAINT_LIMIT = 4000
    /** One older-history page per round; the loop gives up after this many. */
    const HISTORY_MAX_ROUNDS = 8
    /** How long one older-history page may take before the loop gives up. */
    const HISTORY_SETTLE_MS = 2500

    /**
     * Highlight colours, registered as theme tokens so the marks follow the
     * active light/dark scheme instead of being the only hard-coded colours in
     * the file. Every pair is checked for WCAG AA contrast by `verify.mjs`.
     */
    const HIGHLIGHT_TOKENS = {
      '--dfis-match-bg': { light: '#fff3bf', dark: '#4a3f14' },
      '--dfis-match-fg': { light: '#1b1b1b', dark: '#f5efd0' },
      '--dfis-active-bg': { light: '#ffb020', dark: '#c98a12' },
      '--dfis-active-fg': { light: '#1b1b1b', dark: '#12100a' },
    }

    /** Escape one whitespace-free run so it is matched literally. */
    function escapePatternPart(part) {
      return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    }

    /**
     * Query semantics, kept identical to the Host's own session text filter
     * (`compileSessionTextFilter` in `@deepseek-ai/dsh-session-query`):
     * case-insensitive, whitespace-flexible between runs, literal otherwise.
     *
     * The Host throws on a blank filter because it is a filter contract; a
     * find box must stay quiet instead, so a blank query compiles to `null`.
     *
     * @param {string} query - raw text from the input.
     * @returns {RegExp | null} pattern, or `null` for a blank query.
     */
    function compileQueryPattern(query) {
      const trimmed = query.trim()
      if (trimmed === '') return null
      const pattern = trimmed.split(/\s+/u).map(escapePatternPart).join('\\s+')
      return new RegExp(pattern, 'iu')
    }

    /**
     * Match spans of `pattern` inside `text`, in reading order.
     * @param {string} text
     * @param {RegExp} pattern
     * @returns {Array<{ start: number, end: number }>}
     */
    function matchSpans(text, pattern) {
      const scan = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
      const spans = []
      for (let found = scan.exec(text); found !== null; found = scan.exec(text)) {
        // The Host filter can never match empty (every run is non-empty), but a
        // zero-length match would spin this loop, so step past one defensively.
        if (found[0].length === 0) {
          scan.lastIndex += 1
          continue
        }
        spans.push({ start: found.index, end: found.index + found[0].length })
      }
      return spans
    }

    /**
     * What one key press on the find input means.
     * @param {{ key: string, shiftKey?: boolean, isComposing?: boolean, keyCode?: number }} event
     * @param {boolean} composing - the input is inside an IME composition.
     * @param {number | undefined} committedAt - when the last composition ended.
     * @param {number | undefined} now - current time, for the commit guard.
     * @returns {'next' | 'previous' | 'close' | null}
     */
    function inputIntent(event, composing, committedAt, now) {
      const typing = composing === true || event.isComposing === true || event.keyCode === 229
      if (typing) return null
      // The Enter that commits an IME candidate arrives after `compositionend`
      // with `isComposing === false`; treat a same-moment Enter as part of the
      // commit instead of as "next match" (see IME_COMMIT_GUARD_MS).
      const confirmOnly =
        event.key === 'Enter' &&
        typeof committedAt === 'number' &&
        typeof now === 'number' &&
        now - committedAt < IME_COMMIT_GUARD_MS
      if (confirmOnly) return null
      if (event.key === 'Enter' || event.key === 'F3') return event.shiftKey === true ? 'previous' : 'next'
      if (event.key === 'Escape') return 'close'
      return null
    }

    /**
     * Whether one more older-history page may be requested. The Host owns
     * history: it renders `[data-chat-history=<status>]` around its own
     * "load earlier" button and disables that button at the start of the
     * session, so the only correct move is to click it and wait.
     * @param {{ present: boolean, disabled: boolean, status: string | null, rounds: number }} input
     */
    function shouldLoadOlder(input) {
      if (!input.present) return false
      if (input.disabled) return false
      if (input.rounds >= HISTORY_MAX_ROUNDS) return false
      const status = input.status
      return status === 'idle' || status === 'error'
    }

    /**
     * The count label for one search state.
     * @param {{ history: string, painting: string, total: number, painted: number, position: number }} state
     */
    function countParts(state) {
      if (state.history === 'loading' && state.total === 0) return { key: 'find.searching', params: {} }
      if (state.total === 0) return { key: 'find.empty', params: {} }
      if (state.painting === 'capped') {
        return { key: 'find.capped', params: { position: state.position, total: state.total, painted: state.painted } }
      }
      return { key: 'find.count', params: { position: state.position, total: state.total } }
    }

    /**
     * The secondary note beside the count, or `null` when there is nothing a
     * person needs to be told. Each branch is a different epistemic state and
     * must not be collapsed into another one: "no older history exists", "we
     * stopped before we ran out", and "this page has no conversation at all"
     * are three different answers to the same question.
     * @param {{ history: string, painting: string, total: number, inConversation: boolean }} state
     */
    function noteKey(state) {
      if (state.inConversation === false) return 'find.noConversation'
      if (state.history === 'loading' && state.total > 0) return 'find.searching'
      if (state.painting === 'unsupported') return 'find.unsupported'
      if (state.history === 'budget' && state.total === 0) return 'find.budgetExhausted'
      if (state.history === 'exhausted' && state.total === 0) return 'find.historyStart'
      return null
    }

    /**
     * Parameters for the note returned by `noteKey`. Only the budget branch has
     * any: it has to name how many pages were tried, because "we stopped after 8
     * pages" and "this is the start of the conversation" are different answers.
     * @param {{ rounds: number }} state
     */
    function noteParams(state) {
      return { rounds: state.rounds }
    }

    /** Match count shown on the sidebar entry ('' when there is none). */
    function countText(state) {
      if (state.total === 0) return ''
      return state.painting === 'capped' ? `${state.total}+` : String(state.total)
    }
    // #endregion pure-contracts

    const zh = {
      'find.placeholder': '在会话中查找',
      'find.count': '{position}/{total}',
      'find.empty': '无匹配',
      'find.searching': '正在搜索更早内容…',
      'find.capped': '{position}/{total}，已高亮 {painted} 处',
      'find.unsupported': '当前浏览器不支持高亮，仅定位',
      'find.historyStart': '已到会话开头',
      'find.budgetExhausted': '已向前翻 {rounds} 页仍未找到，判定停止',
      'find.noConversation': '当前页面没有会话',
      'find.previous': '上一处（Shift+Enter）',
      'find.next': '下一处（Enter）',
      'find.close': '关闭（Esc）',
      'find.sidebar': '会话内查找',
      'find.sidebarHint': '在会话中查找并定位，可继续搜索尚未加载的历史',
    }
    const en = {
      'find.placeholder': 'Find in conversation',
      'find.count': '{position}/{total}',
      'find.empty': 'No results',
      'find.searching': 'Searching earlier messages…',
      'find.capped': '{position}/{total}, highlighting {painted}',
      'find.unsupported': 'Highlighting is unavailable; jumping only',
      'find.historyStart': 'Reached the start of the conversation',
      'find.budgetExhausted': 'Stopped after {rounds} earlier pages with no match',
      'find.noConversation': 'This page has no conversation',
      'find.previous': 'Previous match (Shift+Enter)',
      'find.next': 'Next match (Enter)',
      'find.close': 'Close (Esc)',
      'find.sidebar': 'Find in conversation',
      'find.sidebarHint': 'Find and jump within the conversation, including history not loaded yet',
    }

    const styles = `
.dfis-bar{position:fixed;z-index:${BAR_Z_INDEX};display:flex;align-items:center;gap:4px;padding:5px 6px;box-sizing:border-box;max-width:calc(100vw - 24px);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:var(--dsw-radius-md,12px);box-shadow:var(--dsw-elevation-panel,0 0 0 .5px rgba(0,0,0,.14),0 3px 8px 0 rgba(0,0,0,.03),0 0 16px 0 rgba(0,0,0,.02));font-family:var(--dsw-font-family,system-ui);color:var(--dsw-alias-label-primary,#1a1a1a);pointer-events:auto;-webkit-app-region:no-drag;app-region:no-drag}
.dfis-bar *{-webkit-app-region:no-drag;app-region:no-drag}
.dfis-input{flex:1 1 170px;width:auto;min-width:0;padding:2px 4px;border:0;outline:0;background:transparent;font-family:inherit;font-size:13px;line-height:18px;color:inherit}
.dfis-input::placeholder{color:var(--dsw-alias-label-secondary,#61666b)}
.dfis-count{flex:none;min-width:46px;text-align:center;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums;white-space:nowrap}
.dfis-note{flex:0 1 auto;min-width:0;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b)}
.dfis-button{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}
.dfis-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dfis-button:disabled{color:var(--dsw-alias-label-tertiary,#81858c);cursor:default}
.dfis-button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:1px}
.dfis-separator{width:.5px;height:16px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.14));flex:none}
.dfis-entry{display:inline-flex;align-items:center;gap:8px;width:100%;height:32px;margin:0;padding:0 9px;border:0;border-inline:3px solid transparent;border-radius:var(--dsw-radius-md,12px);background:transparent;color:var(--dsw-alias-label-primary,#1a1a1a);font-family:inherit;font-size:14px;cursor:pointer}
.dfis-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dfis-entry[data-active]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dfis-entry:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:-2px}
.dfis-entryLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfis-entryCount{flex:none;margin-left:auto;color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
.dfis-rail{width:36px;height:36px;padding:0;border-inline:0;border-radius:var(--dsw-radius-md,12px);justify-content:center}
.dfis-entryHost{display:flex;width:100%}
.dfis-entryHost[data-rail]{width:36px;justify-content:center}
.dfis-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
*::highlight(${MATCH_HIGHLIGHT}){background-color:var(--dfis-match-bg,#fff3bf);color:var(--dfis-match-fg,#1b1b1b)}
*::highlight(${ACTIVE_HIGHLIGHT}){background-color:var(--dfis-active-bg,#ffb020);color:var(--dfis-active-fg,#1b1b1b)}
`

    /** Elements whose text never participates in a search. */
    const SKIP_SELECTOR = [
      '[data-chat-turn-spacer]',
      '[data-chat-history]',
      '[data-text-interaction-surface]',
      '[data-find-in-session]',
      '[aria-hidden="true"]',
      'button',
      'script',
      'style',
      'textarea',
      'input',
      'select',
      'option',
    ].join(',')

    /** Whether the browser exposes the CSS Custom Highlight API. */
    function canHighlight() {
      return typeof CSS !== 'undefined' && CSS !== null && typeof CSS.highlights !== 'undefined'
    }

    /**
     * The outermost transcript surfaces (`[data-chat-flow]`), which is where the
     * conversation column marks its flow. `ChatGroupSeat` repeats the attribute
     * on nested groups, so only the topmost matches are returned.
     */
    function columnRoots() {
      const all = Array.from(document.querySelectorAll('[data-chat-flow]'))
      const roots = all.filter(element => !all.some(other => other !== element && other.contains(element)))
      if (roots.length > 0) return roots
      return Array.from(document.querySelectorAll('[data-chat-node-key]'))
    }

    /**
     * Search units inside one column: one per rendered chat node, so a match can
     * span inline markup inside a single message but never leaks across messages.
     */
    function blocksOf(column) {
      const nodes = Array.from(column.querySelectorAll('[data-chat-node-key]'))
      if (nodes.length === 0) return Array.from(column.children)
      return nodes.filter(element => {
        for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
          if (parent.hasAttribute('data-chat-node-key')) return false
          if (parent === column) return true
        }
        return true
      })
    }

    /** Visible text nodes of one block, in document order. */
    function textNodesOf(block) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      const nodes = []
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.data.trim() === '') continue
        const host = node.parentElement
        if (host === null || !block.contains(host)) continue
        if (host.closest(SKIP_SELECTOR) !== null) continue
        nodes.push(node)
      }
      return nodes
    }

    /** The span of one text node inside the block's concatenated string. */
    function locate(spans, index) {
      for (const span of spans) {
        if (index >= span.start && index < span.end) return span
      }
      return null
    }

    /** Every range matching `pattern` inside one block. */
    function rangesIn(block, pattern) {
      const nodes = textNodesOf(block)
      if (nodes.length === 0) return []
      let text = ''
      const spans = []
      for (const node of nodes) {
        spans.push({ node, start: text.length, end: text.length + node.data.length })
        text += node.data
      }
      const ranges = []
      for (const span of matchSpans(text, pattern)) {
        const first = locate(spans, span.start)
        const last = locate(spans, span.end - 1)
        if (first === null || last === null) continue
        const range = document.createRange()
        range.setStart(first.node, span.start - first.start)
        range.setEnd(last.node, span.end - 1 - last.start + 1)
        ranges.push(range)
      }
      return ranges
    }

    /** Ranges for the whole loaded transcript, in reading order. */
    function collect(pattern) {
      const ranges = []
      for (const column of columnRoots()) {
        for (const block of blocksOf(column)) {
          for (const range of rangesIn(block, pattern)) ranges.push(range)
        }
      }
      return ranges
    }

    /**
     * Owns the match list, the two highlight layers, and scrolling of the active
     * match. Kept outside React so the shortcut can drive it without re-rendering.
     */
    function createEngine() {
      let ranges = []
      let active = -1
      let painted = 0

      const clearHighlights = () => {
        if (!canHighlight()) return
        CSS.highlights.delete(MATCH_HIGHLIGHT)
        CSS.highlights.delete(ACTIVE_HIGHLIGHT)
      }

      const elementOf = range => {
        const host = range.startContainer
        return host.nodeType === Node.ELEMENT_NODE ? host : host.parentElement
      }

      /**
       * Rect of the match itself. Measuring the parent element instead is a no-op
       * for centring: a message can be hundreds of pixels tall, so "centre the
       * element" asks for a scroll position the box cannot reach.
       */
      const rectOf = range => {
        const direct = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null
        if (direct !== null && direct.width + direct.height > 0) return direct
        const element = elementOf(range)
        if (element === null) return null
        const fallback = element.getBoundingClientRect()
        return fallback.width + fallback.height > 0 ? fallback : null
      }

      /**
       * Every scroll box between the match and the conversation, innermost first.
       * A reply can hold its own scroller (tall code block, tool output); moving
       * only the outer one leaves the match clipped inside the inner one, which is
       * why some matches never appeared to move. Outer boxes move after inner ones.
       */
      const scrollBoxesOf = element => {
        const boxes = []
        for (let node = element.parentElement; node !== null && node !== document.body; node = node.parentElement) {
          const style = window.getComputedStyle(node)
          const scrollable = style.overflowY === 'auto' || style.overflowY === 'scroll'
          if (!scrollable) continue
          if (node.scrollHeight - node.clientHeight < 2) continue
          boxes.push(node)
        }
        return boxes.reverse()
      }

      const centerIn = (box, rect) => {
        const frame = box.getBoundingClientRect()
        const delta = rect.top - frame.top - (frame.height - rect.height) / 2
        if (Math.abs(delta) < 1) return
        const target = box.scrollTop + delta
        // `scroll-behavior: smooth` in the app stylesheet would turn a plain
        // scrollTop assignment into an animation, so ask for `instant` explicitly.
        if (typeof box.scrollTo === 'function') box.scrollTo({ top: target, behavior: 'instant' })
        if (Math.abs(box.scrollTop - target) >= 1) box.scrollTop = target
      }

      /**
       * A folded row keeps its text mounted under `hidden="until-found"`, which is
       * how the transcript stays searchable while collapsed. Such content has no
       * layout box at all, so a match inside one measures 0x0 and used to be
       * stepped over in silence: only the matches outside folds appeared to move.
       */
      const foldedAncestorsOf = element => {
        const folded = []
        for (let node = element; node !== null && node !== document.body; node = node.parentElement) {
          if (node.getAttribute('hidden') === 'until-found') folded.push(node)
        }
        return folded.reverse()
      }

      /**
       * Ask the viewport to unfold every row between the match and the column.
       * The scrollport itself hears `beforematch` as a reading intent, which stops
       * it from snapping back to the tail while the revealed match is scrolled to.
       */
      const expandFolded = element => {
        const folded = foldedAncestorsOf(element)
        if (folded.length === 0) return false
        const scroller = element.closest('[data-conversation-scroll]')
        if (scroller !== null) scroller.dispatchEvent(new Event('beforematch'))
        for (const node of folded) node.dispatchEvent(new Event('beforematch'))
        return true
      }

      /**
       * Put `range` in the middle of the conversation, synchronously. Returns false
       * when the match has no box at all (collapsed tool output), so callers can
       * step over it instead of appearing to ignore the key press.
       *
       * `scrollIntoView` is used first because it is the only call that unwinds
       * nested scroll boxes correctly (a reply can hold its own scroller, and
       * moving only the conversation leaves the match clipped inside it). It
       * centres the *element*, though, which is wrong for a tall message, so the
       * range is then re-measured and nudged to sit in the middle of the viewport.
       */
      const reveal = range => {
        let rect = rectOf(range)
        if (rect === null) return false
        const element = elementOf(range)
        if (element === null) return false

        if (typeof element.scrollIntoView === 'function') {
          element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
          rect = rectOf(range)
          if (rect === null) return true
        }

        const boxes = scrollBoxesOf(element)
        if (boxes.length === 0) return true
        const outer = boxes[boxes.length - 1]
        const frame = outer.getBoundingClientRect()
        const inside = rect.top >= frame.top + 4 && rect.bottom <= frame.bottom - 4
        if (inside) return true
        centerIn(outer, rect)
        return true
      }

      /**
       * Repaint the whole match layer, and remember how many matches the paint
       * layer could actually hold. The count published to the bar is
       * `ranges.length`, so a capped paint is visible as `painted < total`.
       */
      const paintMatches = () => {
        if (!canHighlight()) {
          painted = 0
          return
        }
        CSS.highlights.delete(MATCH_HIGHLIGHT)
        painted = 0
        if (ranges.length === 0) return
        const paintedRanges = ranges.slice(0, MATCH_PAINT_LIMIT)
        CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...paintedRanges))
        painted = paintedRanges.length
      }

      /**
       * Expanding a folded row is driven by React and then animated by a height
       * transition, so the match has no final geometry in this tick. Wait until
       * the scrollport stops resizing (or 600ms), then scroll once, so the landing
       * is not off by the height that was still growing when it was measured.
       */
      let settleFrame = null

      const revealAfterExpand = range => {
        if (settleFrame !== null) cancelAnimationFrame(settleFrame)
        const startedAt = Date.now()
        let lastHeight = -1
        let stable = 0
        const tick = () => {
          settleFrame = null
          if (active < 0 || active >= ranges.length || ranges[active] !== range) return
          const element = elementOf(range)
          if (element === null) return
          const boxes = scrollBoxesOf(element)
          const box = boxes.length > 0 ? boxes[boxes.length - 1] : null
          const height = box === null ? -2 : box.scrollHeight
          if (height !== lastHeight) {
            lastHeight = height
            stable = 0
          } else {
            stable += 1
          }
          if (stable < 2 && Date.now() - startedAt < 600) {
            settleFrame = requestAnimationFrame(tick)
            return
          }
          reveal(range)
        }
        settleFrame = requestAnimationFrame(tick)
      }

      // Repaint just the focused match and reveal it. One range per step, so
      // holding Enter does not rebuild the whole highlight layer each time.
      const paintActive = () => {
        if (active < 0 || active >= ranges.length) {
          if (canHighlight()) CSS.highlights.delete(ACTIVE_HIGHLIGHT)
          return false
        }
        const range = ranges[active]
        if (canHighlight()) {
          CSS.highlights.delete(ACTIVE_HIGHLIGHT)
          CSS.highlights.set(ACTIVE_HIGHLIGHT, new Highlight(range))
        }
        const element = elementOf(range)
        if (element !== null && expandFolded(element)) {
          revealAfterExpand(range)
          return true
        }
        return reveal(range)
      }

      const wrap = value => ((value % ranges.length) + ranges.length) % ranges.length

      /** Focus `start`, stepping `step`-wise past matches that have no box. */
      const focusFrom = (start, step) => {
        let candidate = wrap(start)
        for (let tries = 0; tries < ranges.length; tries += 1) {
          active = candidate
          if (paintActive()) return
          candidate = wrap(candidate + step)
        }
        active = wrap(start)
        paintActive()
      }

      /** What the bar needs to know about the last search. */
      const report = () => ({
        total: ranges.length,
        painted,
        painting: !canHighlight() ? 'unsupported' : painted < ranges.length ? 'capped' : 'ok',
      })

      return {
        /** Number of matches from the last search. */
        get size() {
          return ranges.length
        },
        /** Number of matches the paint layer could hold. */
        get painted() {
          return painted
        },
        /** Zero-based index of the focused match, or -1. */
        get index() {
          return active
        },
        /** Recompute matches for `query` and focus the first visible one. */
        search(query) {
          const pattern = compileQueryPattern(query)
          ranges = pattern === null ? [] : collect(pattern)
          active = -1
          paintMatches()
          if (ranges.length === 0) {
            clearHighlights()
            return report()
          }
          focusFrom(0, 1)
          return report()
        },
        /** Focus a match by index, wrapping at both ends, and reveal it. */
        focus(index, step) {
          if (ranges.length === 0) {
            active = -1
            clearHighlights()
            return
          }
          focusFrom(index, step === undefined ? 1 : step)
        },
        /** Drop matches and every highlight. */
        clear() {
          if (settleFrame !== null) {
            cancelAnimationFrame(settleFrame)
            settleFrame = null
          }
          ranges = []
          active = -1
          painted = 0
          clearHighlights()
        },
      }
    }

    /** Is there a conversation on screen at all? The bar is frame-wide. */
    function conversationPresent() {
      return document.querySelector('[data-chat-flow]') !== null || document.querySelector('[data-chat-node-key]') !== null
    }

    /** Bar visibility plus the search it currently shows; subscribable by React. */
    function createController(services) {
      const { timer } = services
      const engine = createEngine()
      let state = {
        open: false,
        query: '',
        position: 0,
        total: 0,
        painted: 0,
        painting: 'ok',
        history: 'idle',
        /** How many earlier pages the last expand attempt asked for. */
        rounds: 0,
        inConversation: true,
        /** Bumped when Ctrl+F should re-focus the existing field. */
        focusRequest: 0,
      }
      const listeners = new Set()
      const pollHandles = new Set()
      let expandToken = 0
      let focusReturn = null
      /**
       * True between clicking the Host's "load earlier" button and the Host
       * reflecting it in `data-chat-history`; the attribute alone cannot tell
       * a fresh click from an idle transcript.
       */
      let roundInFlight = false

      const publish = patch => {
        state = { ...state, ...patch }
        for (const listener of [...listeners]) listener()
      }

      const reportPatch = report => ({
        total: report.total,
        painted: report.painted,
        painting: report.painting,
      })

      /** One single-shot timer, tracked so `dispose()` can drop every pending one. */
      const later = (callback, delay) => {
        const handle = timer.timeout(() => {
          pollHandles.delete(handle)
          callback()
        }, delay)
        pollHandles.add(handle)
        return handle
      }

      /**
       * Resolve once the Host stops loading an older page: its status attribute
       * leaves `loading`/`pendingConsumption`, the control disappears (start of
       * session), or the settle budget runs out. Polling rather than observing
       * because the Host mutates a single attribute and a frame of latency is
       * cheaper than an observer that must be torn down on every search.
       */
      const waitForHistory = token => new Promise(resolve => {
        const startedAt = Date.now()
        const tick = () => {
          if (expandToken !== token) {
            resolve()
            return
          }
          const box = document.querySelector('[data-chat-history]')
          const status = box === null ? null : box.getAttribute('data-chat-history')
          const busy = status === 'loading' || status === 'pendingConsumption'
          if (!busy || Date.now() - startedAt >= HISTORY_SETTLE_MS) {
            resolve()
            return
          }
          later(tick, 50)
        }
        later(tick, 50)
      })

      /**
       * Ask the Host for older pages until the query finds something (or the
       * session starts), and keep the cursor on the match it was on. This is the
       * deep part of the feature: a match that exists only in unloaded history is
       * still reachable, and the paging is the Host's own control, not a second
       * paging implementation.
       */
      const expand = async (query, mode) => {
        if (query.trim() === '') return
        const token = ++expandToken
        const anchor = engine.index
        let rounds = 0
        while (expandToken === token) {
          const box = document.querySelector('[data-chat-history]')
          const button = box === null ? null : box.querySelector('button')
          const status = box === null ? null : box.getAttribute('data-chat-history')
          if (status === 'loading' || status === 'pendingConsumption') {
            await waitForHistory(token)
            if (expandToken !== token) return
            continue
          }
          if (!shouldLoadOlder({ present: box !== null, disabled: button === null || button.disabled === true, status, rounds })) {
            // Three different answers, three different strings: no control at
            // all means the session starts here; a still-enabled control after
            // the round budget means we stopped early and do not know.
            if (box === null) publish({ history: 'exhausted', rounds })
            else if (rounds >= HISTORY_MAX_ROUNDS) publish({ history: 'budget', rounds })
            else publish({ history: 'idle', rounds })
            return
          }
          publish({ history: 'loading', rounds })
          rounds += 1
          roundInFlight = true
          button.click()
          await waitForHistory(token)
          roundInFlight = false
          if (expandToken !== token) return
          const before = state.total
          const report = engine.search(query)
          const delta = report.total - before
          publish({ ...reportPatch(report), history: 'idle', rounds, position: report.total === 0 ? 0 : engine.index + 1 })
          if (delta > 0) {
            if (mode === 'previous' && anchor >= 0) {
              // Older matches are prepended, so the match chronologically before
              // the anchor sits at `anchor + delta - 1`.
              engine.focus(anchor + delta - 1, 1)
              publish({ position: engine.index + 1 })
            }
            return
          }
        }
        if (expandToken === token) publish({ history: 'exhausted' })
      }

      /**
       * A round that was abandoned can still leave the Host mid-page: the
       * click was already dispatched, and once that page lands nothing
       * re-runs the search, so the count stays wrong forever. A search that
       * starts while a page is in flight therefore waits for it and re-runs
       * once. `roundInFlight` covers the gap between the click and the Host
       * publishing `loading`, where the status attribute still reads `idle`.
       */
      const settle = token => new Promise(resolve => {
        const startedAt = Date.now()
        const tick = () => {
          if (expandToken !== token) {
            resolve()
            return
          }
          const box = document.querySelector('[data-chat-history]')
          const status = box === null ? null : box.getAttribute('data-chat-history')
          const busy = roundInFlight || status === 'loading' || status === 'pendingConsumption'
          if (!busy || Date.now() - startedAt >= HISTORY_SETTLE_MS) {
            resolve()
            return
          }
          later(tick, 50)
        }
        later(tick, 50)
      })

      const resync = query => {
        const box = document.querySelector('[data-chat-history]')
        const status = box === null ? null : box.getAttribute('data-chat-history')
        const busy = roundInFlight || status === 'loading' || status === 'pendingConsumption'
        if (!busy) return
        const token = ++expandToken
        const anchor = engine.index
        const before = state.total
        publish({ history: 'loading' })
        void (async () => {
          await settle(token)
          if (expandToken !== token) return
          const report = engine.search(query)
          if (report.total === 0) {
            publish({ ...reportPatch(report), history: 'idle', position: 0 })
            void expand(query, 'any')
            return
          }
          // Older matches are prepended, so the followed match shifts by the
          // number of matches that appeared before it.
          const delta = report.total - before
          engine.focus(anchor < 0 ? 0 : anchor + delta, 1)
          publish({ ...reportPatch(report), history: 'idle', position: engine.index + 1 })
        })()
      }

      const run = query => {
        expandToken += 1
        const present = conversationPresent()
        const report = present ? engine.search(query) : { total: 0, painted: 0, painting: 'ok' }
        publish({
          query,
          history: 'idle',
          inConversation: present,
          ...reportPatch(report),
          position: report.total === 0 ? 0 : engine.index + 1,
        })
        if (!present || report.total > 0) {
          if (present) resync(query)
          return
        }
        void expand(query, 'any')
      }

      /** Text selected inside the transcript, so opening the bar can seed it. */
      const selectedText = () => {
        const selection = window.getSelection()
        if (selection === null || selection.isCollapsed) return null
        const text = selection.toString().trim()
        if (text === '' || text.length > 200) return null
        const anchorNode = selection.anchorNode
        const host = anchorNode === null ? null : anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentElement
        if (host === null || host.closest('[data-chat-flow]') === null) return null
        return text
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        getSnapshot() {
          return state
        },
        /** Show the bar, seeding the query from a transcript selection. */
        open() {
          const seed = selectedText()
          const query = seed === null ? state.query : seed
          const present = conversationPresent()
          if (!state.open) {
            const element = document.activeElement
            focusReturn = element instanceof HTMLElement ? element : null
            publish({ open: true, query, inConversation: present })
          } else {
            // Second Ctrl+F while open: refocus and select, the way a browser
            // does, instead of closing the bar under the user.
            publish({ focusRequest: state.focusRequest + 1, ...(seed === null ? {} : { query }) })
          }
          if (query.trim() !== '' && present) run(query)
          else if (!present) publish({ total: 0, painted: 0, painting: 'ok', position: 0, history: 'idle' })
        },
        /** Hide the bar, clear every highlight, and give focus back. */
        close() {
          expandToken += 1
          engine.clear()
          publish({ open: false, total: 0, painted: 0, painting: 'ok', position: 0, history: 'idle' })
          const target = focusReturn
          focusReturn = null
          if (target !== null && target.isConnected) target.focus()
        },
        /** Search a new query from the input. */
        search(query) {
          run(query)
        },
        /** Focus the next match. */
        next() {
          if (state.total === 0) return
          engine.focus(engine.index + 1, 1)
          publish({ position: engine.index + 1 })
        },
        /** Focus the previous match, reaching into history past the first one. */
        previous() {
          if (state.total === 0) {
            void expand(state.query, 'previous')
            return
          }
          engine.focus(engine.index - 1, -1)
          publish({ position: engine.index + 1 })
          if (engine.index === state.total - 1) void expand(state.query, 'previous')
        },
        /** Drop highlights and pending history work when the plugin is disposed. */
        dispose() {
          expandToken += 1
          for (const handle of [...pollHandles]) {
            if (typeof handle.dispose === 'function') handle.dispose()
          }
          pollHandles.clear()
          engine.clear()
          listeners.clear()
        },
      }
    }

    /** Subscribe a component to a controller without assuming a React version. */
    function useControllerState(controller) {
      const [state, setState] = React.useState(controller.getSnapshot())
      React.useEffect(() => {
        const sync = () => {
          setState(controller.getSnapshot())
        }
        const unsubscribe = controller.subscribe(sync)
        sync()
        return unsubscribe
      }, [controller])
      return state
    }

    /** Nearest scrollable ancestor, so the bar rides the visible chat viewport. */
    function scrollAncestorOf(element) {
      let node = element.parentElement
      while (node !== null && node !== document.body) {
        const overflow = window.getComputedStyle(node).overflowY
        if (overflow === 'auto' || overflow === 'scroll') return node
        node = node.parentElement
      }
      return null
    }

    /**
     * Anchor of the conversation viewport, so the bar sits over the visible chat.
     * Anchoring to the scroll viewport (not to the scrolled content) keeps the bar
     * below the Windows titlebar drag strip; the drag strip is `-webkit-app-region`
     * geometry, so a bar placed inside it swallows every click as a window drag.
     */
    function barAnchor() {
      const column = document.querySelector('[data-chat-flow]')
      if (column === null) return { top: 64, right: 24 }
      const rect = column.getBoundingClientRect()
      const viewport = scrollAncestorOf(column)
      const top = viewport === null ? rect.top : viewport.getBoundingClientRect().top
      const floor = Number.parseFloat(
        window.getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height'),
      )
      const minTop = Number.isFinite(floor) ? floor + 8 : 8
      return {
        top: Math.max(minTop, Math.round(top + 10)),
        right: Math.max(12, Math.round(window.innerWidth - rect.right + 16)),
      }
    }

    function Icon(props) {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }, ...props.paths.map((path, index) => h('path', { key: index, d: path })))
    }

    const UP_ICON = ['M4 10l4-4 4 4']
    const DOWN_ICON = ['M4 6l4 4 4-4']
    const CLOSE_ICON = ['M4 4l8 8', 'M12 4l-8 8']
    const SEARCH_ICON = ['M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z', 'M10.4 10.4L14 14']

    /** Id of the element the input describes itself with. */
    const STATUS_ID = 'dfis-status'
    /** Id of the off-screen live region that speaks the settled state. */
    const ANNOUNCE_ID = 'dfis-announcer'

    /** The find bar itself: one overlay entry, rendered only while open. */
    function FindBar(props) {
      const { controller, timer, t } = props
      const state = useControllerState(controller)
      const [draft, setDraft] = React.useState('')
      const [anchor, setAnchor] = React.useState(null)
      const [announcement, setAnnouncement] = React.useState('')
      const input = React.useRef(null)
      const composing = React.useRef(false)
      /** When the last IME composition ended, for the commit guard. */
      const committedAt = React.useRef(undefined)
      const wasOpen = React.useRef(false)
      const seenFocusRequest = React.useRef(state.focusRequest)

      const schedule = React.useMemo(
        () => timer.debounce(value => {
          controller.search(value)
        }, SEARCH_DEBOUNCE_MS),
        [controller, timer],
      )

      /**
       * One live region for the whole state, updated on a trailing delay.
       * A polite region fed by a 20ms debounce would announce every keystroke
       * ("1/5", "1/12", "1/40"), which makes the field unusable with a screen
       * reader; 500ms trailing is the smallest delay that speaks the settled
       * answer instead of each intermediate one.
       */
      const announce = React.useMemo(
        () => timer.debounce(text => {
          setAnnouncement(text)
        }, ANNOUNCE_DELAY_MS),
        [timer],
      )

      React.useEffect(() => () => {
        schedule.dispose()
        announce.dispose()
      }, [schedule, announce])

      const statusText = (snapshot, query) => {
        const counting = query.trim() !== ''
        const parts = counting ? countParts(snapshot) : null
        const note = noteKey(snapshot)
        const pieces = []
        if (parts !== null) pieces.push(t(parts.key, parts.params))
        if (note !== null) pieces.push(t(note, noteParams(snapshot)))
        return pieces.join('，')
      }

      React.useEffect(() => {
        if (state.open) announce(statusText(state, state.query))
      }, [state.open, state.total, state.position, state.painted, state.painting, state.history, state.rounds, state.inConversation])

      React.useEffect(() => {
        if (state.open && !wasOpen.current) {
          setDraft(state.query)
          const element = input.current
          if (element !== null) {
            element.focus()
            if (state.query !== '') element.select()
          }
        }
        wasOpen.current = state.open
      }, [state.open, state.query])

      // Second Ctrl+F while open: refocus and select, the browser convention,
      // rather than closing the bar the user is typing in.
      React.useEffect(() => {
        if (state.focusRequest === seenFocusRequest.current) return
        seenFocusRequest.current = state.focusRequest
        const element = input.current
        if (element !== null) {
          element.focus()
          element.select()
        }
      }, [state.focusRequest])

      /**
       * Re-measure on every layout change, not only on `window.resize`: the
       * chat column is a grid track that narrows when the right rail opens or
       * the sidebar collapses, and neither of those fires a resize event.
       */
      React.useEffect(() => {
        if (!state.open) return undefined
        let observer = null
        const measure = () => {
          setAnchor(barAnchor())
          const column = document.querySelector('[data-chat-flow]')
          if (observer !== null) observer.disconnect()
          if (column !== null && typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(measure)
            observer.observe(column)
            const viewport = scrollAncestorOf(column)
            if (viewport !== null) observer.observe(viewport)
          }
        }
        measure()
        window.addEventListener('resize', measure)
        return () => {
          window.removeEventListener('resize', measure)
          if (observer !== null) observer.disconnect()
        }
      }, [state.open])

      const change = event => {
        const value = event.target.value
        setDraft(value)
        schedule(value)
      }

      const keyDown = event => {
        const intent = inputIntent(event, composing.current, committedAt.current, Date.now())
        if (intent === null) return
        event.preventDefault()
        if (intent === 'close') {
          event.stopPropagation()
          controller.close()
          return
        }
        if (intent === 'next') controller.next()
        else controller.previous()
      }

      if (!state.open) return null

      const position = anchor ?? { top: 64, right: 24 }
      const counting = draft.trim() !== ''
      const label = counting ? t(countParts(state).key, countParts(state).params) : ''
      const note = noteKey(state)
      const disabled = state.total === 0

      return h('div', {
        className: 'dfis-bar',
        role: 'search',
        'data-find-in-session': '',
        style: { top: `${position.top}px`, right: `${position.right}px` },
      },
        h('input', {
          ref: input,
          className: 'dfis-input',
          type: 'search',
          value: draft,
          placeholder: t('find.placeholder'),
          'aria-label': t('find.placeholder'),
          'aria-describedby': STATUS_ID,
          'aria-keyshortcuts': 'Enter Shift+Enter Escape F3',
          'data-find-in-session-input': '',
          autocomplete: 'off',
          spellCheck: false,
          onChange: change,
          onKeyDown: keyDown,
          onCompositionStart: () => {
            composing.current = true
          },
          onCompositionEnd: () => {
            composing.current = false
            committedAt.current = Date.now()
          },
        }),
        // The visible count is not a live region: it changes on every
        // keystroke. The settled sentence is announced through ANNOUNCE_ID.
        h('span', { id: STATUS_ID, className: 'dfis-count' }, label),
        note !== null && h('span', { className: 'dfis-note' }, t(note, noteParams(state))),
        h('span', {
          id: ANNOUNCE_ID,
          className: 'dfis-sr',
          role: 'status',
          'aria-live': 'polite',
          'aria-atomic': 'true',
        }, announcement),
        h('span', { className: 'dfis-separator', 'aria-hidden': true }),
        h('button', {
          type: 'button', className: 'dfis-button', disabled,
          title: t('find.previous'), 'aria-label': t('find.previous'), 'aria-keyshortcuts': 'Shift+Enter Shift+F3',
          onClick: () => {
            controller.previous()
          },
        }, h(Icon, { paths: UP_ICON })),
        h('button', {
          type: 'button', className: 'dfis-button', disabled,
          title: t('find.next'), 'aria-label': t('find.next'), 'aria-keyshortcuts': 'Enter F3',
          onClick: () => {
            controller.next()
          },
        }, h(Icon, { paths: DOWN_ICON })),
        h('button', {
          type: 'button', className: 'dfis-button',
          title: t('find.close'), 'aria-label': t('find.close'), 'aria-keyshortcuts': 'Escape',
          onClick: () => {
            controller.close()
          },
        }, h(Icon, { paths: CLOSE_ICON })),
      )
    }

    /**
     * Sidebar foot entry: the visible way into the find bar. Renders the full
     * row while the sidebar is wide and an icon button in the 56px rail.
     */
    function SidebarEntry(props) {
      const { controller, t, wide } = props
      const state = useControllerState(controller)
      const label = t('find.sidebar')
      const count = countText(state)
      return h('div', { className: 'dfis-entryHost', 'data-rail': wide ? undefined : '' },
        h('button', {
          type: 'button',
          className: wide ? 'dfis-entry' : 'dfis-entry dfis-rail',
          'data-find-in-session-entry': '',
          'data-active': state.open ? '' : undefined,
          title: wide ? t('find.sidebarHint') : `${label} (Ctrl+F)`,
          'aria-label': label,
          'aria-expanded': state.open ? 'true' : 'false',
          'aria-keyshortcuts': 'Control+F Meta+F',
          onClick: () => {
            if (controller.getSnapshot().open) controller.close()
            else controller.open()
          },
        },
          h(Icon, { paths: SEARCH_ICON }),
          wide && h('span', { className: 'dfis-entryLabel' }, label),
          wide && h('span', { className: 'dfis-entryCount' }, count),
        ))
    }

    return {
      /** Client services this module needs. */
      inject: ['slots', 'locale', 'theme', 'timer'],
      /**
       * Register the find-bar overlay entry, its stylesheet, its colour tokens,
       * and the Ctrl+F global listener. Everything is released with the plugin.
       * @param ctx - client root context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'find-in-session: dictionaries')
        const t = ctx.locale.bind(NS)
        const controller = createController({ timer: ctx.timer })

        ctx.effect(
          () => ctx.theme.overrideTokens('@local/dsh-find-in-session', HIGHLIGHT_TOKENS),
          'find-in-session: highlight tokens',
        )

        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = '@local/dsh-find-in-session'
          tag.dataset.pluginCss = STYLE_KEY
          tag.textContent = styles
          document.head.appendChild(tag)
          return () => {
            tag.remove()
            controller.dispose()
          }
        }, 'find-in-session: stylesheet')

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'find-in-session.bar',
          inject: () => ({ controller, t, timer: ctx.timer }),
        }, FindBar))

        // The sidebar-foot entry is the discoverable way in; Ctrl+F stays as
        // the keyboard path for people who expect browser behaviour.
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'find-in-session.entry',
          order: 10,
          inject: () => ({ controller, t }),
        }, SidebarEntry))

        ctx.effect(() => {
          const keyDown = event => {
            if (event.defaultPrevented || event.isComposing) return
            const modifier = event.ctrlKey || event.metaKey
            const target = event.target instanceof Element ? event.target : null
            if (target !== null && target.closest('.xterm') !== null) return
            const open = controller.getSnapshot().open

            // F3 / Shift+F3 is the browser's other next/previous pair; it needs
            // no modifier, so it is checked before the Ctrl/Cmd gate.
            if (event.key === 'F3' && open && !event.altKey) {
              event.preventDefault()
              if (event.shiftKey) controller.previous()
              else controller.next()
              return
            }
            if (!modifier || event.altKey) return

            if (event.code === 'KeyF' && !event.shiftKey) {
              event.preventDefault()
              // Browsers re-focus and select on a second Ctrl+F. Closing here
              // would make the bar vanish under a user who pressed the shortcut
              // twice — and reopening would silently re-run the old query.
              controller.open()
              return
            }
            if (event.code === 'KeyG' && open) {
              event.preventDefault()
              if (event.shiftKey) controller.previous()
              else controller.next()
              return
            }
            if (event.code === 'Escape' && open) {
              if (target !== null && target.closest('[data-find-in-session-input]') !== null) return
              event.preventDefault()
              controller.close()
            }
          }
          window.addEventListener('keydown', keyDown, true)
          return () => {
            window.removeEventListener('keydown', keyDown, true)
          }
        }, 'find-in-session: find shortcuts')
      },
    }
  },
})
