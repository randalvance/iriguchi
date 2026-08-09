# iriguchi design system

Dark only. Modern-dashboard surfaces, vermilion accent, monospace for anything the system matches on.

Two files carry the whole system:

| File | Role |
|---|---|
| `src/styles/tokens.css` | Every visual decision, as CSS custom properties. |
| `src/styles/base.css` | Reset, element defaults, and component classes. Consumes tokens only. |

Import `base.css` once in the app layout; it `@import`s `tokens.css` itself.

## Principles

1. **No literal values outside `tokens.css`.** No hex, no px spacing, no font stack, no duration in a component. If you need a value that isn't a token, add the token.
2. **Accent is interaction; status is health.** Vermilion means *you can act on this* — links, focus, primary buttons, the active nav item. Green/amber/red/gray mean *this is the state of a thing*. The two vocabularies never cross, which is why the accent is warm-red and the failure red is a distinct, lighter coral.
3. **Color is never the only signal.** Every status carries a dot shape and a word alongside its hue.
4. **Elevation is lightness, not shadow.** Dark UIs lose shadow detail; each step up the surface ramp is a lighter fill. Shadows only separate overlays from the page.
5. **Dark only, but not dark-hardcoded.** Tokens are named semantically (`--surface-2`, `--status-stale`), never literally (`--gray-800`, `--amber`). A light theme would be a second definition of `tokens.css`, touching no component.

## Tokens

### Surfaces

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0b0d10` | Page canvas |
| `--surface-1` | `#121519` | Cards, panels, header |
| `--surface-2` | `#181c22` | Inputs, raised rows, user chat bubble |
| `--surface-3` | `#20252c` | Hover, popovers, active nav |
| `--surface-inset` | `#090b0d` | Code blocks and wells — recessed, not raised |
| `--border` | `#262c34` | Default hairline |
| `--border-strong` | `#333b45` | Elements that must read as interactive at rest |

### Text

Four levels. Contrast measured against `--bg`; all pass WCAG AA for normal text.

| Token | Value | Contrast | Use |
|---|---|---|---|
| `--text` | `#e8ecf1` | 16.4:1 | Body, headings, values |
| `--text-muted` | `#a0a9b4` | 8.2:1 | Secondary text, inactive nav |
| `--text-subtle` | `#868f9b` | 5.9:1 | Labels, timestamps, keys |
| `--text-inverse` | `#0b0d10` | — | On accent and status fills |

`--text-subtle` is the dimness floor. Do not go below it, and do not place it on `--surface-3` or lighter.

### Accent

| Token | Value | Use |
|---|---|---|
| `--accent` | `#e8583c` | Links, focus ring, primary fill, active nav. 5.5:1 on `--bg` — safe as text. |
| `--accent-hover` | `#f26a4e` | Hover |
| `--accent-active` | `#d9502f` | Pressed |
| `--accent-muted` | `#a83c28` | Borders and rules that should recede |
| `--accent-tint` / `--accent-tint-strong` | 12% / 20% mix | Selected-row and active-nav backgrounds |

**Primary buttons are dark text on bright vermilion, not white on it.** White on `#e8583c` reaches only 3.6:1; `--text-inverse` on it reaches 5.5:1 — and it reads louder anyway.

### Status

The four MCP connection states, plus a neutral.

| Token | Value | Contrast | Meaning |
|---|---|---|---|
| `--status-ok` | `#4ade80` | 11.2:1 | Cache fresher than the TTL, or a probe just succeeded |
| `--status-stale` | `#fbbf24` | 10.4:1 | Cached tool list older than the TTL |
| `--status-unreachable` | `#f87171` | 6.1:1 | Last attempt failed |
| `--status-unknown` | `#8a93a2` | 6.3:1 | Never contacted — deliberately desaturated: absence of signal, not a fifth hue |
| `--status-neutral` | `#a0a9b4` | 8.2:1 | Counts and non-health chips |

Each has a matching `--status-*-tint` at 14% for pill backgrounds.

### Typography

Sans for prose and chrome; **mono for anything the system matches on** — agent ids, tool names, model slugs, URLs, header names. That distinction is the main typographic signal in the app, so keep it strict: mono means "this is a value", not "this looks technical".

| Token | px | Use |
|---|---|---|
| `--text-2xs` | 11 | Uppercase eyebrow labels only |
| `--text-xs` | 12 | Metadata, timestamps, table headers |
| `--text-sm` | 13 | Dense secondary text, tags |
| `--text-base` | 14 | App default |
| `--text-md` | 16 | Chat prose — read, not scanned |
| `--text-lg` | 18 | Card titles |
| `--text-xl` | 22 | Page titles |
| `--text-2xl` | 28 | The one hero size |

Weights: 400 / 500 / 600. **700 is deliberately absent** — heavy weights bloom against dark backgrounds. Emphasis is 600 plus a brighter text token.

Line height: `--leading-tight` 1.25 (headings), `--leading-normal` 1.5 (UI), `--leading-relaxed` 1.65 (chat transcripts).

### Spacing, shape, motion

4px base: `--space-1` … `--space-16`. No arbitrary values.

Radius: `--radius-sm` 4 (tags), `--radius-md` 6 (buttons, inputs), `--radius-lg` 10 (cards, bubbles), `--radius-xl` 14 (composer, modals), `--radius-full`.

Motion: `--duration-fast` 120ms (hover/focus), `--duration-base` 180ms (disclosure), `--duration-slow` 280ms (panel entrance); `--ease-out` for entrances, `--ease-in-out` for state changes. **The duration tokens collapse to 0ms under `prefers-reduced-motion`**, so honoring the preference is not something a component can forget.

### Layout

`--container-max` 1280px · `--sidebar-width` 264px · `--header-height` 52px · `--measure` 68ch (chat reading width).

## Components

### Button — `.btn`

| Variant | Use when |
|---|---|
| `.btn-primary` | The one action on a screen — Send. |
| `.btn-secondary` | Supporting actions — Probe, Retry. |
| `.btn-ghost` | Low-weight, repeated actions in dense rows. |
| `.btn-danger` | Destructive. **Unused today** — the UI is read-only; it exists so a later write surface doesn't invent one. |

Size `.btn-sm` for in-row controls. States: hover, active, `:disabled` / `[aria-disabled="true"]` at 50% opacity, and `[data-busy="true"]` which swaps the label for a centered spinner **without resizing** — a probe button must not shift the row out from under the cursor.

Accessibility: real `<button>` elements. Disabled-but-focusable actions use `aria-disabled` so the reason stays reachable; genuinely inert ones use `disabled`.

### Input, textarea, select — `.input` / `.textarea` / `.select`

`--surface-2` fill with a `--border-strong` hairline, so a field reads as interactive without a focus ring. Hover lifts the border to `--text-subtle`; focus is the global ring. Pair with `.field` + `.label` + `.hint`.

### Status pill — `.status`

`.status-ok` · `.status-stale` · `.status-unreachable` · `.status-unknown`

A dot plus a word in a tinted pill. **`.status-unknown` renders a hollow ring rather than a filled dot** — nothing has been measured, and an empty ring says that more honestly than a gray dot does. This is the one component whose exact shape matters: `unknown` and `unreachable` must never be mistaken for each other, because one means "we haven't looked" and the other means "it's down".

Always follow the pill with the tool count and the timestamp of the reading; a status with no time on it implies a liveness the gateway does not have.

### Tag — `.tag`

A value the system knows by name: a tool, a skill, a model, a header name. Monospace, `--surface-2`, hairline border. `.tag-accent` for the selected or matched one.

### Key/value list — `.kv`

The shape almost all agent metadata takes. `<dt>` in `--text-subtle`, `<dd>` in `--text`, values wrap with `overflow-wrap: anywhere` so a long MCP URL doesn't blow out the grid.

### Table — `.table`

Header row in `--text-xs` / `--text-subtle`, hairline row separators, no zebra striping (it fights the surface ramp). Wrap in `.scroll-x` — wide content scrolls in its own box and the page never scrolls sideways.

### Disclosure — `.disclosure`

Native `<details>`. System prompts and JSON parameter schemas are large and rarely the reason someone opened the page, so they collapse by default. The marker is a rotating `▸`; keyboard and screen-reader behavior come free from the element.

### Alert — `.alert`

`.alert-error` · `.alert-warn` · `.alert-info`. Used for failed catalog loads and for the "UI not built" and "internal surface is unauthenticated" notices.

### Empty state — `.empty`

Title, one sentence of body, optional action. Required wherever a list can be legitimately empty — no registered agents, no MCP servers declared — because an empty container with no explanation is indistinguishable from a broken fetch.

### Chat — `.chat`

Three rows: `.chat-toolbar` (agent picker), `.chat-transcript`, `.chat-composer`.

Turns are **asymmetric on purpose**. `.msg-user` is a contained bubble, right-aligned, capped at 80% — a short thing belonging to a person. `.msg-assistant` is full width at `--measure` with no container — long-form prose streaming in, which a bubble only fights.

`.caret` is appended to the assistant turn while chunks arrive and removed on `[DONE]`. It is the only thing distinguishing an in-flight reply from a finished one, so **do not use it decoratively anywhere else**.

`.msg-error` marks a failed run inside the transcript with a red left rule, leaving prior turns intact and the composer usable.

### Skeleton — `.skeleton`

Shimmer placeholder for the catalog while `/internal/agents` is in flight. Animation is disabled under reduced motion. Do not use it for MCP status — an unresolved status is `unknown`, which is a real state, not a loading state.

## Accessibility rules

- **One focus treatment**, defined once on `:focus-visible`. Never remove it; if an element needs a different shape, change the offset.
- Every color pairing above meets **WCAG 2.1 AA** for its size. Status colors were chosen at these lightnesses specifically to clear 4.5:1 on `--bg`, which is why `unknown` is `#8a93a2` and not a darker gray.
- Color is never the sole carrier of meaning — status has a dot shape and a label.
- Interactive targets are ≥ 26px tall (`.btn-sm`) and ≥ 32px for standalone actions.
- `prefers-reduced-motion` is handled in `tokens.css` for durations and per-component for the caret and shimmer.

## Adding to the system

1. Check whether an existing component composes into what you need.
2. If you need a new value, add a **semantic** token — `--surface-4`, not `--gray-750`.
3. Add the class to `base.css` in the section it belongs to, and document it here with its variants, states, and accessibility notes. An undocumented component doesn't exist.
