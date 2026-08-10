## Context

PR #9 gave the gateway a page-aware request contract: `iri_context` is a free-form JSON object, validated for shape and size only, whose top-level scalars are inlined into the system prompt and whose objects and arrays become shape placeholders readable on demand through a gateway-owned `get_context` tool. Manifest tools can be scoped to a screen with `when`. There is deliberately no server-side context persistence and no sessions — the client holds history and resends it every turn.

Nothing consumes that contract yet. The first consumer is a Next.js 15 App Router finance app, and at least one more app is expected. The pieces each of them would otherwise reinvent — an SSE reader, a conversation store, a key-hiding proxy, and the plumbing that turns "what the user is looking at" into an envelope — are identical across apps and none of them are finance-specific.

There is a second, stronger reason this lives in Iriguchi. The eventual goal is chat that *drives* the host UI: apply a filter, open a modal, scroll to a row. The gateway cannot execute such a tool — there is no route from the gateway back into the user's tab — so it requires an interactive run protocol in the gateway itself. A per-app client could never grow into that.

Constraints inherited from the repository: Node ≥ 24, TypeScript run directly with no build step for the gateway, `ui/` and `examples/weather-app` as sibling npm projects driven by root scripts rather than workspace members, `ui/DESIGN.md` as the project's design language, and tests that run offline with no credentials.

## Goals / Non-Goals

**Goals:**

- One package any Iriguchi-registered app can adopt to get an "Ask AI" panel, with no app-specific concepts in it.
- Composable context: whichever component owns the data registers it, and the SDK assembles the envelope.
- Streaming as the only transport, because agentic runs here have been measured around 40 seconds and a spinner is not acceptable for that.
- The gateway API key stays server-side, with no gateway change required.
- Adoption in the finance app costs a provider, a proxy route, and a few `useIriContext` calls.
- Phase A's shape does not foreclose phase C.

**Non-Goals:**

- Bindings for anything but React.
- Server-side conversation persistence, sessions, or history endpoints — the gateway is stateless by design and this change does not challenge that.
- Gateway-minted browser tokens and CORS. Recorded as a follow-up; the proxy makes it unnecessary today.
- The phase C interactive run protocol. Sketched non-normatively below; specified and built separately.
- Rendering rich content (charts, tables, tool-call trace UI) in the transcript. Markdown-free plain text with preserved whitespace for phase A.

## Decisions

### D1 — Distribution: git reference, path link for development

Consumers install from a git URL pinned to a tag; local development links by path. **Alternatives:** publishing to npm (real semver, but needs an org, a publish workflow, and release discipline for one consumer today), or shipping TypeScript source for the consumer to compile (matches the gateway's no-build ethos, but forces the consumer's bundler to transpile `node_modules` and gives up a `.d.ts` contract boundary).

Consequence: the package must be buildable from a bare checkout of any tag. `dist/` is **not** committed; a `prepare` script compiles on install, which npm runs for git dependencies. Breaking changes propagate by moving the ref, so the guide instructs consumers to pin a tag rather than a branch.

### D2 — Location and layout: `packages/chat-ui`

A new `packages/` directory rather than a second top-level sibling next to `ui/`. `ui/` is a private application; this is a distributable artifact, and the directory name says which. It follows the `ui/` *convention* exactly — own `package.json` and `tsconfig.json`, not a workspace member, driven by root scripts.

```
packages/chat-ui/
  src/
    core/        # framework-agnostic: registry, transport, storage, request assembly
    core/panel/  # framework-agnostic panel DOM (see D8)
    react/       # provider, hooks, panel wrapper
    server/      # proxy factory
    styles.css
  tests/
```

Five subpath exports: `.` (re-exports core types), `./core/panel`, `./react`, `./react/panel`, `./server`, plus `./styles.css`. ESM only, compiled by `tsc` to `dist/` with declarations. The split is enforced by an import rule, not by convention alone: `core/` may not import React, `server/` may not import React or touch a DOM global. This is what makes `./server` importable in a Node route handler with no React resolution, and what leaves room for a non-React binding later without a rewrite.

**Alternative rejected:** separate `@iriguchi/chat-core` and `@iriguchi/chat-react` packages. Cleaner in principle, but it is three release refs and a version-skew problem for one consumer. The subpath split gets the same boundary at a fraction of the cost, and splitting later is a mechanical move.

### D3 — Context: a registry of named slices, merged at send

`useIriContext(key, callback, options?)` registers into a provider-level registry keyed by slice name; the effect's cleanup deregisters. At send time the client calls every registered callback, `Promise.all`s the results, and assembles `{ [key]: value }`.

This composes exactly with the gateway's two tiers with no extra concept: a slice returning a scalar rides free in the system prompt every turn; a slice returning an array costs nothing until the model calls `get_context`. It also puts ownership in the right place — `visibleRows` belongs to the table that filtered them, not to the page.

**Alternative rejected:** one per-page provider owning the whole envelope. It forces pages to lift state that belongs to children, and "these rows" is almost always a child's data.

Details settled here:

- **Duplicate keys**: last registration wins; a `console.warn` naming the key in development builds only, so the warning never ships to production and never throws.
- **Failure isolation**: a callback that throws or rejects drops its own slice and reports through the provider's `onError`; the send proceeds. A page that half-broke should still be able to answer "what am I looking at".
- **Fresh every send, never cached**: the design's whole premise is that the envelope describes *now*.
- **Empty means absent**: with no slices registered the request omits `iri_context` entirely, which per the client-context spec is exactly the pre-existing behavior. Sending `{}` would be equivalent for the prompt but would needlessly expose `get_context` reasoning about an empty object.

The documented consequence — the model remembers what earlier turns told it, as text, but cannot `get_context` into a page the user has left — is intended and stated in the guide.

### D4 — Transport: streaming only, through a host-mounted proxy

`createIriguchiChatProxy({ gatewayUrl, apiKey })` returns `(Request) => Promise<Response>`. Next 15 App Router route handlers accept that value as a `POST` export directly; Express, Hono, and Fastify get documented adapters. The handler attaches the bearer credential, forwards the body, and returns the upstream `Response` with its body stream intact — no buffering, no re-encoding. Caller abort is wired to an `AbortController` on the upstream fetch.

**Alternative rejected for now:** gateway-minted short-lived browser tokens plus CORS. It removes the proxy hop, but costs a new endpoint, token issuance/expiry/revocation, origin configuration, and a rate-limit story — a gateway change of its own. The client's transport is a single injectable module, so adopting tokens later is a configuration change rather than a rewrite.

The proxy is deliberately dumb: it does not parse SSE, inspect the body, or enforce policy. Anything it understood would be a second place to keep in sync with the gateway's contract.

Streaming is not optional in the client. `stream: false` would double the code paths for a mode the panel would never use.

### D5 — Persistence: versioned, capped, messages only

Key `iriguchi.chat.v1.<agentId>`, holding `{ v: 1, messages: [...] }`. Namespacing by agent keeps two panels in one application from colliding. On load, a version mismatch, a parse failure, or a shape mismatch discards the thread rather than attempting migration — a dropped conversation is a far smaller harm than a panel that cannot mount.

Two caps applied on write, oldest-first: 40 messages and 128 KiB serialized. Both are needed — a few very long assistant turns blow the byte budget without approaching the count. All storage access is wrapped so a `QuotaExceededError`, a disabled-storage browser, or SSR (`localStorage` undefined) degrades to an in-memory session rather than an exception.

Context is never persisted. It is derived at send, attached to the request, and dropped — it never enters the message list.

### D6 — Size enforcement before the network

The client serializes the merged context and compares against `maxContextBytes` (default 65536, matching `IRI_MAX_CONTEXT_BYTES`). Over the limit, it computes each slice's serialized size and raises an error naming the limit, the observed size, and the largest slice — the gateway's own 400 can only name a total, and "your context is 71 KiB" is not actionable when six components contributed to it.

A slice may opt in with `{ truncate: true }`. Truncation shrinks array values from the end until the merged context fits, and replaces the value with `{ truncated: true, total, kept, items }` so the model is told it is looking at a subset. A truncated non-array slice is not attempted — silently shortening an object is worse than failing. If truncation cannot bring the context under the limit, the send fails as above.

### D7 — Errors, cancellation, and the in-flight turn

The transcript's assistant turn carries a status: `streaming`, `complete`, `cancelled`, or `error`. This one field drives every case the spec distinguishes.

- **Pre-stream failure** (non-2xx before the body opens): parse the JSON error body, surface `code` and message, mark the turn `error` with no text.
- **Mid-stream failure**: keep the text, mark the turn `error`, append the reason.
- **Cancellation**: `AbortController.abort()`, mark `cancelled`, keep the text. Not an error, and not styled as one.

A send is in flight **from the moment it is asked for**, not from the moment a request is dispatched. The controller is therefore claimed before slice resolution, which is what makes `isStreaming()` true across the derivation window: the composer locks, Stop appears, a second send is refused, and a cancel that lands before dispatch stops the run without it ever reaching the gateway. Ordering this the other way is subtly wrong in a way that only shows up once a consumer registers a slow `async` slice — the panel looks idle while a send is under way, and two concurrent runs interleave their deltas into whichever turn happens to be last.

Partial text from a cancelled or failed turn stays in the history and is resent on the next turn. The alternative — dropping it — leaves the model contradicting text the user can still see on screen.

### D8 — Panel and theming

The panel is a reference implementation over the hooks, not the product. `useIriChat` exposes `messages`, `send`, `cancel`, `clear`, and status; a host that wants its own surface imports the hooks and never loads `styles.css`.

The panel's DOM is built once, imperatively, by `mountAskAiPanel(container, chat)` in `core/panel` — it subscribes to the core chat store and updates the transcript itself. The React `AskAiPanel` is a thin wrapper that mounts it into a ref and unmounts on cleanup. That is an unusual shape for a React component, and it is chosen for one reason: it makes the panel available to a non-React host without a second implementation (see D10). It is safe here because the panel is a leaf that owns its subtree entirely — the same arrangement any charting or editor wrapper uses — and because the store, not the DOM, is the source of truth.

Styles ship as one plain stylesheet with no build tooling required. Every value is a namespaced custom property (`--iri-chat-*`) defaulting to `ui/DESIGN.md`'s vocabulary — vermilion accent, the dark surface ramp, mono for values, motion tokens that collapse under `prefers-reduced-motion` — so the panel looks like it belongs to Iriguchi while a host retheming it redefines properties instead of fighting selectors. Class names are all `iri-chat-` prefixed and the sheet defines no element or reset rules, so it cannot reach a host element.

**Shadow DOM was considered and rejected for phase A.** It would guarantee isolation in both directions, but it complicates the stylesheet story, focus management, and portal behavior for a problem prefixing is very likely to solve. It stays available if leakage proves real; the panel's DOM is built through a single mount point so moving it into a shadow root later touches one file.

Panel behavior: a right-edge, vertically centered button; a slide-out surface with focus moved in on open and returned on close; `Escape` closes; the transcript follows `ui/DESIGN.md`'s asymmetric turns (contained user bubble, full-width assistant prose) and its streaming caret convention. Text renders as plain text with preserved whitespace — no markdown rendering, and therefore no HTML injection surface, in phase A.

### D9 — Phase C accommodation without phase C

Registration is typed as one registry with a kind, so `useIriAction(name, schema, handler)` can be added alongside `useIriContext` without either changing. Nothing is exposed to consumers and nothing new appears on the wire: a phase A request is byte-identical to one from a client with no notion of actions.

Non-normative sketch of what phase C will need in the gateway, recorded so phase A is not designed against it: the run pauses when the model calls a client-executed tool, emits the call over the existing SSE channel, the client executes it and posts the result to a resume endpoint keyed by run id, and the run continues. That requires gateway-side run state — the first thing in this system that is not request-scoped — plus a timeout for a client that never answers, and a manifest or request-level declaration of which tools are client-executed. It is a gateway change, it is substantial, and it is explicitly not in this one.

### D10 — `examples/weather-app` is the working demo

The example already teaches `iri_context` end to end: screen state that is *already on screen*, a `when`-scoped tool, and an agent prompted to read context rather than re-fetch. What it does not have is a client worth copying — it hand-rolls SSE parsing, holds history in a bare array, and asks the user to paste `IRI_API_KEY` into a text input. All three are exactly what this package exists to delete.

The example is buildless, served as one static HTML file, and not React — deliberately, since its job is to be readable. That constraint is useful rather than awkward: adopting the package there proves the framework-agnostic half is genuinely framework-agnostic. Concretely:

- The Hono server mounts `createIriguchiChatProxy` at `POST /api/ask-ai` and serves `packages/chat-ui/dist/` under a static path. The example depends on the package by a `file:` path, which exercises D1's development-link path.
- The page imports `core` and `core/panel` as plain browser ESM — no bundler — and calls `mountAskAiPanel`, so the demo shows the real panel rather than a lookalike.
- Its screen state becomes slices instead of one hand-assembled object: `route`, `city`, `today` and `units` as scalars, `forecast` and `saved_locations` as payloads. That makes the two-tier behavior visible in the demo, which is the thing the example is for.
- The gateway URL and API key inputs disappear from the browser. The key moves to the server side of the example, where it belongs, and the page addresses its own origin.

This is why `tsc` emits extension-ful relative specifiers: the browser resolves the emitted ESM directly, with no bundler and no import map.

**Alternative rejected:** converting the example to React so it could use the React panel. It would add a build step to the one thing in the repo that is valuable for having none, and it would leave the framework-agnostic boundary untested by anything but its own unit tests.

The example's manifest, tool endpoints, `when` clause, and system prompt are untouched. Only the client half changes.

### D11 — Testing

Vitest, matching the root, with a DOM environment for the React layer. Three seams carry the suite:

- **Core** is pure and needs no DOM: registry merge and deregistration, size accounting and truncation, request assembly, SSE parsing driven by a hand-built `ReadableStream`, storage against an in-memory `localStorage` double.
- **React** uses Testing Library over a stubbed `fetch`: streaming render, cancel, clear, both error positions, persistence across remount, slice lifecycle across simulated navigation.
- **Server** invokes the proxy handler with a constructed `Request` against a stubbed upstream `fetch`, asserting header attachment, pass-through status and body, unbuffered streaming, and abort propagation.

No credentials, no network, no gateway process. An end-to-end check against a live gateway is a manual step in the guide, not a test.

## Risks / Trade-offs

- **Git-ref distribution has no semver discipline** → the guide requires a pinned tag, and the package version is bumped on every published tag so a consumer can see what it is on.
- **`prepare`-on-install requires the consumer to build the package** → dependencies stay minimal (`typescript` is the only build-time need) and the build is a single `tsc` invocation plus a CSS copy, so an install-time failure is easy to diagnose.
- **Context is assembled from callbacks the SDK does not control** → a slow callback delays the send; slice resolution is bounded by a timeout, after which that slice is dropped and reported like any other slice failure.
- **`localStorage` is per-origin, and a shared browser retains a conversation about a previous user's data** → "Clear conversation" is prominent, storage is namespaced per agent, and the guide states that hosts with a login boundary should clear the thread on sign-out. The client exposes `clear()` for exactly that.
- **A host that registers a large slice on every page pays a serialization cost per send** → slice sizes are computed only when the total exceeds the limit, so the common path serializes once.
- **The panel prefixes rather than isolating its styles** → an aggressive host reset (`* { }` rules) can still reach it. Accepted for phase A; shadow DOM is the escape hatch and the DOM is structured to allow it.
- **Prefixed class names may still collide with a host that uses the same prefix** → unlikely, and a rename is a mechanical change since no consumer targets the panel's internals.
- **The proxy adds a hop and ties streaming correctness to the host's runtime** → documented for Next 15 specifically (the route must run on a streaming-capable runtime and must not be statically optimized), with a smoke-test snippet in the guide.

## Migration Plan

Additive throughout: no gateway code changes, no spec changes to existing capabilities, no consumer affected until it opts in.

1. Land `packages/chat-ui` with its toolchain and root scripts; the gateway's `npm test` and `npx tsc --noEmit` must remain clean and untouched by it.
2. Build core, then server, then React, then the panel — each layer testable before the next depends on it.
3. Adopt it in `examples/weather-app`, which is the first end-to-end proof and the only consumer inside this repository.
4. Document adoption in `docs/chat-ui-client.md` and link it from `docs/app-integration.md` step 6.
5. Tag a release; the finance app installs that tag, declares a `finance-chat` agent, mounts the proxy route, and adds `useIriContext` calls.

Rollback is removing the directory, the root scripts, and the doc, and reverting the example; nothing else depends on them. A consumer rolls back by moving its pinned ref.

## Open Questions

- **Slice resolution timeout value.** The default is 5s per slice, resolved concurrently, so the cost of a send is the slowest slice rather than the sum. The number is a placeholder: the weather app's slices are all synchronous, so nothing here measures it, and it wants a real consumer's async fetches to settle.

  What the two directions cost is now asymmetric in a useful way. **Too low** drops a slow but healthy slice, and that failure is invisible — the model answers without the data and cannot flag what it was never told, since slice failures reach the host's `onError` and the panel renders nothing for them. **Too high** now costs only latency: the derivation window is honest (see D7), so the composer is locked and cancellable throughout it. Before that fix a high value widened a window in which the panel looked idle and a second send could start a concurrent run, which is why the default was left conservative. It is now safe to raise, and probably should be once someone has numbers.

Two earlier questions are now closed by decision: the panel does **not** render markdown, and `clear()` is **not** wired to a host sign-out signal — it stays the host's call, and the provider takes no identity prop.
