window.__ModuleLoader__.load({
  id: '@local/dsh-find-in-session',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Browser-side locale namespace owned by this bundle. */
    const NS = 'find-in-session'
    /** Physical key that opens the bar; also the id of the injected stylesheet. */
    const STYLE_KEY = '@local/dsh-find-in-session/find-bar.css'
    const MATCH_HIGHLIGHT = 'dfis-match'
    const ACTIVE_HIGHLIGHT = 'dfis-active'
    /** Above DSH's own overlay entries (z-index 20) and below app dialogs. */
    const BAR_Z_INDEX = 40
    const SEARCH_DEBOUNCE_MS = 20

    const zh = {
      'find.placeholder': '在会话中查找',
      'find.count': '{position}/{total}',
      'find.empty': '无匹配',
      'find.previous': '上一处（Shift+Enter）',
      'find.next': '下一处（Enter）',
      'find.close': '关闭（Esc）',
      'find.sidebar': '会话内查找',
      'find.sidebarHint': '在已加载的会话内容中查找并定位',
    }
    const en = {
      'find.placeholder': 'Find in conversation',
      'find.count': '{position}/{total}',
      'find.empty': 'No results',
      'find.previous': 'Previous match (Shift+Enter)',
      'find.next': 'Next match (Enter)',
      'find.close': 'Close (Esc)',
      'find.sidebar': 'Find in conversation',
      'find.sidebarHint': 'Search the loaded conversation and jump between matches',
    }

    const styles = `
.dfis-bar{position:fixed;z-index:${BAR_Z_INDEX};display:flex;align-items:center;gap:4px;padding:5px 6px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.16);font-family:var(--dsw-font-family,system-ui);color:var(--dsw-alias-label-primary,#1a1a1a);pointer-events:auto;-webkit-app-region:no-drag;app-region:no-drag}
.dfis-bar *{-webkit-app-region:no-drag;app-region:no-drag}
.dfis-input{width:170px;padding:2px 4px;border:0;outline:0;background:transparent;font-family:inherit;font-size:13px;line-height:18px;color:inherit}
.dfis-input::placeholder{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.dfis-count{min-width:46px;text-align:center;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums;white-space:nowrap}
.dfis-button{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5f5f5f);cursor:pointer}
.dfis-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dfis-button:disabled{color:var(--dsw-alias-label-tertiary,#b4b4b4);cursor:default}
.dfis-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:1px}
.dfis-separator{width:.5px;height:16px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.14));flex:none}
.dfis-entry{display:inline-flex;align-items:center;gap:8px;width:calc(100% + 4px);height:42px;margin:0 -2px;padding:0 10px 0 8px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary,#1a1a1a);font-family:inherit;font-size:14px;cursor:pointer}
.dfis-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dfis-entry[data-active]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dfis-entry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:-2px}
.dfis-entryLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfis-entryCount{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
.dfis-rail{width:36px;height:36px;padding:0;border-radius:50%;justify-content:center}
.dfis-entryHost{display:flex;width:100%}
.dfis-entryHost[data-rail]{width:36px;justify-content:center}
*::highlight(${MATCH_HIGHLIGHT}){background-color:rgba(255,205,66,.45);color:inherit}
*::highlight(${ACTIVE_HIGHLIGHT}){background-color:#ffb020;color:#1b1b1b}
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

    /** Every range matching `query` inside one block. */
    function rangesIn(block, query) {
      const nodes = textNodesOf(block)
      if (nodes.length === 0) return []
      let text = ''
      const spans = []
      for (const node of nodes) {
        spans.push({ node, start: text.length, end: text.length + node.data.length })
        text += node.data
      }
      const lowered = text.toLowerCase()
      const caseless = lowered.length === text.length
      const haystack = caseless ? lowered : text
      const needle = caseless ? query.toLowerCase() : query
      if (needle === '') return []
      const ranges = []
      for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
        const end = at + needle.length
        const first = locate(spans, at)
        const last = locate(spans, end - 1)
        if (first === null || last === null) continue
        const range = document.createRange()
        range.setStart(first.node, at - first.start)
        range.setEnd(last.node, end - 1 - last.start + 1)
        ranges.push(range)
      }
      return ranges
    }

    /** Ranges for the whole loaded transcript, in reading order. */
    function collect(query) {
      const ranges = []
      for (const column of columnRoots()) {
        for (const block of blocksOf(column)) {
          for (const range of rangesIn(block, query)) ranges.push(range)
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

      // Repaint the whole match layer. Only on a new query: up to 4000 ranges.
      const paintMatches = () => {
        if (!canHighlight()) return
        CSS.highlights.delete(MATCH_HIGHLIGHT)
        if (ranges.length === 0) return
        CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...ranges.slice(0, 4000)))
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

      return {
        /** Number of matches from the last search. */
        get size() {
          return ranges.length
        },
        /** Zero-based index of the focused match, or -1. */
        get index() {
          return active
        },
        /** Recompute matches for `query` and focus the first visible one. */
        search(query) {
          ranges = query.trim() === '' ? [] : collect(query.trim())
          active = -1
          paintMatches()
          if (ranges.length === 0) {
            clearHighlights()
            return 0
          }
          focusFrom(0, 1)
          return ranges.length
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
          clearHighlights()
        },
      }
    }

    /** Bar visibility plus the search it currently shows; subscribable by React. */
    function createController() {
      const engine = createEngine()
      let state = { open: false, query: '', position: 0, total: 0 }
      const listeners = new Set()

      const publish = patch => {
        state = { ...state, ...patch }
        for (const listener of [...listeners]) listener()
      }

      const run = query => {
        const total = engine.search(query)
        publish({ query, total, position: total === 0 ? 0 : engine.index + 1 })
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
        /** Show the bar, restoring the previous query. */
        open() {
          if (!state.open) publish({ open: true })
          if (state.query.trim() !== '') run(state.query)
        },
        /** Hide the bar and clear every highlight. */
        close() {
          engine.clear()
          publish({ open: false, total: 0, position: 0 })
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
        /** Focus the previous match. */
        previous() {
          if (state.total === 0) return
          engine.focus(engine.index - 1, -1)
          publish({ position: engine.index + 1 })
        },
        /** Drop highlights when the owning plugin is disposed. */
        dispose() {
          engine.clear()
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

    /** The find bar itself: one overlay entry, rendered only while open. */
    function FindBar(props) {
      const { controller, t } = props
      const state = useControllerState(controller)
      const [draft, setDraft] = React.useState('')
      const [anchor, setAnchor] = React.useState(null)
      const input = React.useRef(null)
      const timer = React.useRef(null)
      const wasOpen = React.useRef(false)

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

      React.useEffect(() => {
        if (!state.open) return undefined
        const measure = () => {
          setAnchor(barAnchor())
        }
        measure()
        window.addEventListener('resize', measure)
        return () => {
          window.removeEventListener('resize', measure)
        }
      }, [state.open])

      React.useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current)
      }, [])

      const schedule = value => {
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          timer.current = null
          controller.search(value)
        }, SEARCH_DEBOUNCE_MS)
      }

      const change = event => {
        const value = event.target.value
        setDraft(value)
        schedule(value)
      }

      const keyDown = event => {
        if (event.key === 'Enter') {
          event.preventDefault()
          if (event.shiftKey) controller.previous()
          else controller.next()
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          controller.close()
        }
      }

      if (!state.open) return null

      const position = anchor ?? { top: 64, right: 24 }
      const counting = draft.trim() !== ''
      const label = !counting
        ? ''
        : state.total === 0
          ? t('find.empty')
          : t('find.count', { position: state.position, total: state.total })

      const disabled = state.total === 0

      return h('div', {
        className: 'dfis-bar',
        role: 'search',
        'data-find-in-session': '',
        'aria-label': t('find.placeholder'),
        style: { top: `${position.top}px`, right: `${position.right}px` },
      },
        h('input', {
          ref: input,
          className: 'dfis-input',
          type: 'text',
          value: draft,
          placeholder: t('find.placeholder'),
          'aria-label': t('find.placeholder'),
          'data-find-in-session-input': '',
          autocomplete: 'off',
          spellCheck: false,
          onChange: change,
          onKeyDown: keyDown,
        }),
        h('span', { className: 'dfis-count', 'aria-live': 'polite' }, label),
        h('span', { className: 'dfis-separator', 'aria-hidden': true }),
        h('button', {
          type: 'button', className: 'dfis-button', disabled,
          title: t('find.previous'), 'aria-label': t('find.previous'),
          onClick: () => {
            controller.previous()
          },
        }, h(Icon, { paths: UP_ICON })),
        h('button', {
          type: 'button', className: 'dfis-button', disabled,
          title: t('find.next'), 'aria-label': t('find.next'),
          onClick: () => {
            controller.next()
          },
        }, h(Icon, { paths: DOWN_ICON })),
        h('button', {
          type: 'button', className: 'dfis-button',
          title: t('find.close'), 'aria-label': t('find.close'),
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
      const counting = state.total > 0
      return h('div', { className: 'dfis-entryHost', 'data-rail': wide ? undefined : '' },
        h('button', {
          type: 'button',
          className: wide ? 'dfis-entry' : 'dfis-entry dfis-rail',
          'data-find-in-session-entry': '',
          'data-active': state.open ? '' : undefined,
          title: wide ? t('find.sidebarHint') : `${label} (Ctrl+F)`,
          'aria-label': label,
          'aria-keyshortcuts': 'Control+F',
          onClick: () => {
            if (controller.getSnapshot().open) controller.close()
            else controller.open()
          },
        },
          h(Icon, { paths: SEARCH_ICON }),
          wide && h('span', { className: 'dfis-entryLabel' }, label),
          wide && h('span', { className: 'dfis-entryCount' }, counting ? String(state.total) : ''),
        ))
    }

    return {
      /** Client services this module needs. */
      inject: ['slots', 'locale'],
      /**
       * Register the find-bar overlay entry, its stylesheet, and the Ctrl+F global
       * listener. Everything is released with the plugin.
       * @param ctx - client root context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'find-in-session: dictionaries')
        const t = ctx.locale.bind(NS)
        const controller = createController()

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
          inject: () => ({ controller, t }),
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
            if (!modifier || event.altKey) return
            const target = event.target instanceof Element ? event.target : null
            if (target !== null && target.closest('.xterm') !== null) return
            const open = controller.getSnapshot().open

            if (event.code === 'KeyF' && !event.shiftKey) {
              event.preventDefault()
              // 开关式：未打开则打开，已打开则关闭（浏览器里 Ctrl+F 是重新聚焦，这里按需求做成切换）
              if (open) controller.close()
              else controller.open()
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
