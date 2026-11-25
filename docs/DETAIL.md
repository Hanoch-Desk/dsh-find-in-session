![A find bar sits over the conversation, two matches are highlighted and the active one is darker](preview.svg)

# Find in conversation

`@local/dsh-find-in-session` puts one find bar over the open conversation. It is
the same bar shipped in 1.0.0 — this release makes what it reports true rather
than making it bigger.

## What it does

- **Ctrl+F / Cmd+F** toggles the bar; **Esc** closes it and returns focus to
  whatever had it before. The sidebar footer entry is the pointer-driven way in.
- Typing highlights every match in the rendered conversation. **Enter** or
  **F3** steps forward, **Shift+Enter** / **Shift+F3** steps back, **Ctrl+G**
  cycles too.
- Opening the bar with text selected in the conversation seeds the query with
  that selection (up to 200 characters).

## Matching, the same way the Host matches

The query is compiled exactly like the Host's own session text filter
(`compileSessionTextFilter` in `@deepseek-ai/dsh-session-query`):

- case-insensitive;
- whitespace between words is flexible — `hello world` matches `hello\t\tworld`
  and a line break, but not `helloworld`;
- everything else is literal. Typing `.*` searches for a dot and a star, it does
  not become a wildcard.

`verify.mjs` compiles the same probe strings through this plugin's compiler and
through the Host's shipped compiler, read out of the installed `app.asar`, and
fails if the resulting regular expressions differ.

## Counting is honest

The number in the bar is the real number of matches in the conversation. Painting
a highlight is not free — `new Highlight(...ranges)` costs one argument per
match — so at most 4000 matches are painted. When that limit is reached the bar
says so (`2/5000, highlighting 4000`) and the sidebar count gains a `+`. Nothing
is silently dropped, and if the browser has no CSS Custom Highlight API the bar
says it cannot highlight instead of pretending there were no matches.

## Paging back is the Host's job

When nothing matches in the loaded window, the bar clicks the Host's own
"load earlier" control — the button inside `[data-chat-history]` — and searches
again, up to 8 pages. It never implements paging itself: the Host owns
prepending, scroll anchoring and re-pagination, and a second implementation
would fight it. `verify.mjs` asserts that the Host still renders that control
and that this plugin calls no paging API of its own.

## Colours follow the theme

The four highlight colours are registered as theme tokens through
`theme.overrideTokens`, so light and dark schemes both stay legible. The bar's
own text is not painted by this plugin at all — it uses the Host's
`--dsw-alias-label-*` tokens — and `verify.mjs` recomputes both sets of ratios
from the values in the installed build:

- highlight pairs: worst is the active match in dark at 6.45:1;
- bar and sidebar chrome: worst is the secondary label on the sidebar at 5.55:1.

Every one of those clears WCAG AA (4.5:1). Tertiary label colour is used only on
disabled buttons, because in the light scheme it is 3.71:1 — readable enough for
something you cannot click, not enough for a sentence you have to read.

## What it deliberately does not do

- **It does not read the session event log.** Only text the conversation column
  has actually rendered is matched. Raw tool-call arguments, request headers and
  anything else the transcript never draws are out of reach — the Host's own
  session search covers those, and this bar does not pretend to.
- **It does not search inside controls.** Match candidates come from text nodes,
  and any node underneath `button`, `input`, `select`, `option`, `textarea`,
  `script`, `style`, `[aria-hidden="true"]`, `[data-chat-history]`,
  `[data-chat-turn-spacer]` or `[data-text-interaction-surface]` is skipped. The
  labels on the transcript's own buttons are therefore not matchable. They are
  chrome, not conversation, and treating them as searchable would make the count
  depend on which controls happened to be on screen.
- **It does not cross sessions.** One conversation at a time.
- **The bar cannot be dragged, docked or collapsed.** It rides a fixed offset
  below the conversation header, right-aligned to the chat column, and re-anchors
  itself when the column is resized (opening the right rail, collapsing the
  sidebar, dragging a splitter) — none of which fires a `window.resize`, so a
  `ResizeObserver` watches the column instead. It can overlap the top of the
  transcript; that is the cost of not adding a container to the host layout.
- **It does not add a match list, a settings page, a second search box or a
  separate window.** One bar, one sidebar entry, the same shortcuts.
- **It does not implement regex, whole-word or case-sensitive modes.** The Host
  has one literal semantics; matching it is the point.
