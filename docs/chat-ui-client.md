# Adding an "Ask AI" panel to your app

[`@iriguchi/chat-ui`](../packages/chat-ui) is the client half of [client context](./app-integration.md#step-6--make-your-agent-page-aware). It gives any app registered with the gateway an embedded, page-aware chat: a button pinned to the middle of the right viewport edge, a slide-out panel, and the plumbing that turns "what the user is looking at" into `iri_context`.

Nothing in it is specific to one app. It takes your agent id as configuration and assumes nothing else about your agent.

```
browser ──▶ your app's /api/ask-ai ──▶ Iriguchi /v1/chat/completions
   │             (holds IRI_API_KEY)          │
   │                                          │ runs your agent
   ◀──────────── SSE, streamed through ───────┘
```

The browser never holds a gateway key. That is the reason the proxy route exists.

## Install

Consumers are separate repositories, so the package is installed from a git reference. **Pin a tag, not a branch** — there is no npm semver here, and a branch moves under you.

```bash
npm install "git+https://github.com/<org>/iriguchi.git#chat-ui-v0.1.0"
```

npm runs the package's `prepare` script on a git install, which compiles it. If your npm blocks install scripts, run `npm --prefix node_modules/@iriguchi/chat-ui run build` once.

While developing against a checkout, link it by path instead — this is what `examples/weather-app` does:

```jsonc
{ "dependencies": { "@iriguchi/chat-ui": "file:../iriguchi/packages/chat-ui" } }
```

## Entry points

| Import | Contains | Needs React |
| --- | --- | --- |
| `@iriguchi/chat-ui` | `createChat`, the registry, transport, storage, and types | no |
| `@iriguchi/chat-ui/core/panel` | `mountAskAiPanel` — the panel, framework-free | no |
| `@iriguchi/chat-ui/react` | `IriguchiChatProvider`, `useIriContext`, `useIriChat` | yes |
| `@iriguchi/chat-ui/react/panel` | `AskAiPanel` | yes |
| `@iriguchi/chat-ui/server` | `createIriguchiChatProxy` | no — and it touches no DOM |
| `@iriguchi/chat-ui/styles.css` | the panel's stylesheet | no |

The React panel wraps the framework-free one rather than reimplementing it, so both render the same thing.

## Step 1 — Declare an agent for the chat

Your app's chat agent is its own agent in your manifest, separate from anything else you run. Declare it as you would any other ([app integration, step 1](./app-integration.md#step-1--serve-get-agents-manifest)); the SDK needs only its id.

If your app already exposes tools through an `mcp` entry, the chat agent can point at the same server and needs no new tools. Scope anything screen-specific with [`when`](./app-integration.md#scoping-a-tool-to-a-screen-with-when) — it is matched against exactly the context this client sends.

## Step 2 — Mount the proxy route

`createIriguchiChatProxy` returns a `(Request) => Promise<Response>` handler. Next.js App Router accepts it as a route export directly:

```ts
// app/api/ask-ai/route.ts
import { createIriguchiChatProxy } from "@iriguchi/chat-ui/server";

export const POST = createIriguchiChatProxy({
  gatewayUrl: process.env.IRIGUCHI_GATEWAY_URL!,
  apiKey: process.env.IRIGUCHI_API_KEY!,
});

// Streaming must not be statically optimized or buffered.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
```

Other frameworks call the same handler with a `Request`:

```ts
// Hono
app.post("/api/ask-ai", (c) => handler(c.req.raw));

// Express 5
app.post("/api/ask-ai", async (req, res) => {
  const response = await handler(toWebRequest(req));
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  Readable.fromWeb(response.body).pipe(res);
});
```

The handler forwards the body, attaches the key, streams the response back unbuffered, propagates the gateway's status and error body verbatim, and aborts upstream when the browser disconnects. It parses nothing — anything it understood would be a second place to keep in sync with the gateway.

**Smoke-test it before wiring up the UI.** If this prints all at once rather than progressively, something in your stack is buffering:

```bash
curl -N -X POST http://localhost:3000/api/ask-ai \
  -H 'Content-Type: application/json' \
  -d '{"iri_agent":"my-chat","stream":true,"messages":[{"role":"user","content":"count slowly to twenty"}]}'
```

## Step 3 — Wrap the app and render the panel

```tsx
// app/providers.tsx — a client component
"use client";
import { IriguchiChatProvider } from "@iriguchi/chat-ui/react";
import { AskAiPanel } from "@iriguchi/chat-ui/react/panel";
import "@iriguchi/chat-ui/styles.css";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <IriguchiChatProvider endpoint="/api/ask-ai" agent="my-chat">
      {children}
      <AskAiPanel />
    </IriguchiChatProvider>
  );
}
```

The provider owns the conversation. Mount it once, above your router's content, so the thread survives client-side navigation.

## Step 4 — Register what each part of the page knows

```tsx
// the account page owns the account
useIriContext("account", () => ({ accountId, balance }));

// the table owns the rows it filtered — the page never has to lift that state
useIriContext("visibleRows", () => rows, { truncate: true });

// a slice may fetch what the page does not hold
useIriContext("summary", async () => fetchSummary(accountId));
```

Each slice becomes one top-level key. That lines up with the gateway's two tiers: **scalars ride in the system prompt every turn, objects and arrays cost nothing until the model calls `get_context`**. So flatten what the model must always know — `accountName`, not `account.name` — and leave the bulk nested.

Rules worth knowing:

- **Keys are unique per mount.** A duplicate is last-wins, plus a development-only warning.
- **Unmounting deregisters.** A slice exists exactly as long as the component that owns it.
- **Everything is re-derived on every send.** Nothing is cached and nothing carries over from the previous turn.
- **A slice that throws, rejects, or hangs drops out** and is reported through the provider's `onError`; the message still sends with the remaining slices. A hanging slice is bounded by `sliceTimeoutMs` (5s by default, per slice, overridable per slice with `timeoutMs`).
- **Nothing is registered means no envelope.** The request omits `iri_context` rather than sending `{}`.

An `async` slice delays the send it belongs to, since the envelope has to be complete before the run starts. That window is treated as part of the run: the composer locks, the cancel affordance appears, and cancelling stops it before anything reaches the gateway. Slices resolve concurrently, so a send waits on the slowest one, not on all of them — but a slice on the critical path of every message is worth keeping cheap.

Because a dropped slice is silent to the user by default, wire `onError` to something you will actually see. In development a `console.warn` is enough; in production it is the only signal that the model answered without data it should have had.

### The navigation limitation, which is intended

Context describes the page the user is on *now*. Earlier turns keep what they were told, as text, so the model still remembers it — but it cannot `get_context` into a page the user has navigated away from. If the user needs the model to work across two screens, the answer is a tool, not a bigger envelope.

### Size

The client enforces the gateway's limit before the network, so a failure names the offending slice rather than only a total. Registering a slice with `{ truncate: true }` lets an array value be shortened to fit instead of failing the send; the sent value becomes `{ truncated: true, total, kept, items }`, so the model is never told it has the whole payload. Non-array slices are not truncated — silently shortening an object is worse than refusing.

Override the limit with `maxContextBytes` if your gateway sets `IRI_MAX_CONTEXT_BYTES` to something other than the 64 KiB default.

## Step 5 — Or build your own surface

The hooks are the contract; the panel is a replaceable reference implementation. A host that wants its own UI imports neither the panel nor the stylesheet:

```tsx
const { messages, streaming, send, cancel, clear } = useIriChat();
```

Each message carries a `status` — `streaming`, `complete`, `cancelled`, or `error` — which is enough to render every case the panel renders.

## Theming

The stylesheet is self-contained: no reset, no element selectors, every class prefixed `iri-chat-`, so loading it cannot change one of your elements. Every value is a custom property, so retheming is redefinition rather than override:

```css
.iri-chat-root {
  --iri-chat-accent: #3b82f6;
  --iri-chat-surface-1: #ffffff;
  --iri-chat-text: #111827;
  --iri-chat-width: 480px;
}
```

Defaults follow [the Iriguchi design language](../ui/DESIGN.md). Motion collapses under `prefers-reduced-motion`.

## What the panel does not do

- **No markdown.** Assistant text renders as literal characters with whitespace preserved, which also means there is no markup to inject.
- **No tool-call trace.** The transcript shows the reply, not the run.
- **No actions.** The chat cannot yet drive your UI — apply a filter, open a modal. That needs an interactive run protocol in the gateway, since the gateway has no route back into the user's tab. The client's registration types leave room for it; nothing about it is on the wire today.

## Conversation storage

History lives in `localStorage` under `iriguchi.chat.v1.<agent>`, capped at 40 messages and 128 KiB, oldest dropped first. A thread written under an older schema is discarded rather than migrated, and a storage failure degrades to an in-memory session rather than breaking the panel.

**Only messages are stored — never `iri_context`, and never a slice value.** If your app has a login boundary, call `clear()` on sign-out; the client does not watch your session for you.

## Working example

`examples/weather-app` is the reference: a buildless, framework-free page using the same panel, with the proxy on its own Hono server. See [its README](../examples/weather-app/README.md).
