# @iriguchi/chat-ui

An embeddable, page-aware chat client for apps registered with an [Iriguchi](../../README.md) gateway: an "Ask AI" button pinned to the right viewport edge, a slide-out panel, and the plumbing that turns whatever the user is looking at into an `iri_context` envelope.

```tsx
<IriguchiChatProvider endpoint="/api/ask-ai" agent="my-chat">
  {children}
  <AskAiPanel />
</IriguchiChatProvider>

// per component, wherever the data actually lives
useIriContext("account", () => ({ accountId, balance }));
```

- **Composable context** — any component registers a named slice; the client merges them at send time. Scalars ride in the agent's prompt every turn, payloads cost tokens only when the model reads them with `get_context`.
- **Streaming** — SSE, rendered token by token, cancellable mid-run.
- **Client-held history** — persisted to `localStorage`, versioned and capped. Messages only; context is never stored.
- **No key in the browser** — `createIriguchiChatProxy` mounts on your own server and holds `IRI_API_KEY`.
- **No framework required** — the React binding is a wrapper over a framework-free core and panel.

Full guide: [`docs/chat-ui-client.md`](../../docs/chat-ui-client.md). Working integration: [`examples/weather-app`](../../examples/weather-app).

## Tool events

A page whose data an agent tool writes needs to know when the write lands — not when the model stops talking. Opt in at the provider, then subscribe wherever the data lives:

```tsx
<IriguchiChatProvider endpoint="/api/ask-ai" agent="my-chat" showToolCalls>

// in the page that owns the data
useIriToolEvents((event) => {
  if (event.type === "result" && !event.is_error) void refetchDraft();
});
```

One `call` event per tool the agent invokes, then one `result` when it finishes; pair them by `id`, never by position, since tools can run in parallel. `result` carries `is_error` and nothing else — **the tool's return payload never reaches the browser**, by design.

`showToolCalls` takes effect at mount: the chat is rebuilt only when `endpoint` or `agent` change, because rebuilding it would drop the conversation. Without it the request body is byte-identical to a client that has no notion of tool events.

## Install

This package is not on a registry, and **it cannot be installed from a git reference.** It lives in `packages/chat-ui` of a repository whose root is the gateway (`"name": "iriguchi"`), so `npm install git+…/iriguchi.git#<tag>` installs the gateway. The subdirectory form (`::path:packages/chat-ui`) fails the same way on npm 11 — it unpacks the gateway into a directory named `node_modules/@iriguchi/chat-ui`, so there is no install error to notice.

Install a packed tarball instead. From a gateway checkout (with `npm run chat-ui:install` done once):

```bash
npm run chat-ui:pack
```

That builds and writes `iriguchi-chat-ui-<version>.tgz` at the repository root. Then in the consumer:

```bash
npm install ./iriguchi-chat-ui-0.2.0.tgz
```

The tarball ships a prebuilt `dist/`, so it does not depend on `prepare` running — npm 11 blocks dependency lifecycle scripts by default. To verify you have the right package — it must print `@iriguchi/chat-ui`, not `iriguchi`:

```bash
node -e "console.log(require('./node_modules/@iriguchi/chat-ui/package.json').name)"
```

For local development, depend on the directory (`"file:../iriguchi/packages/chat-ui"`) and run `npm run chat-ui:build` first — the symlink resolves through `dist/`. See [the install section of the guide](../../docs/chat-ui-client.md#install).

## Development

```bash
npm --prefix packages/chat-ui install   # or: npm run chat-ui:install
npm run chat-ui:check                   # tsc --noEmit
npm run chat-ui:test                    # vitest, offline, no credentials
npm run chat-ui:build                   # tsc -> dist/ plus the stylesheet
```
