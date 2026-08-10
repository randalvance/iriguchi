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

## Development

```bash
npm --prefix packages/chat-ui install   # or: npm run chat-ui:install
npm run chat-ui:check                   # tsc --noEmit
npm run chat-ui:test                    # vitest, offline, no credentials
npm run chat-ui:build                   # tsc -> dist/ plus the stylesheet
```
