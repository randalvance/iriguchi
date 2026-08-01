## Context

The gateway runs on Bun and depends on it at the source level in four places (`Bun.serve`, `bun:sqlite`, `Bun.sleep`, `import.meta.main`) plus all 25 test files, which import `bun:test`. Nothing in `openspec/specs/` mentions Bun — the runtime is an implementation detail that leaked into the source rather than a specified behavior, which is why this migration can preserve every existing spec unmodified.

Two facts make Node viable now where it would not have been earlier. Node 26.1.0 (verified locally) strips TypeScript types natively, so `node src/server.ts` runs the sources with no build step, matching how Bun runs them today. And `node:sqlite` is built in, so replacing `bun:sqlite` costs no native dependency.

> **Correction, found during implementation.** This section originally claimed the codebase contained no non-erasable syntax. That was wrong: `GatewayError` (`src/agent/runner.ts`) and `ManifestFetchError` (`src/registry/manifest.ts`) both used constructor **parameter properties**, which strip-only mode rejects. The pre-implementation scan checked for enums, namespaces, and decorators but not parameter properties. Both classes now declare and assign their fields explicitly, and `erasableSyntaxOnly` is enabled in `tsconfig.json` so the gap cannot reopen — see D9.

The forcing function was the production Dockerfile. `@anthropic-ai/claude-agent-sdk` spawns its bundled CLI as a `node` subprocess, so a Bun-based image must install Node anyway and run two runtimes side by side. On Node that problem disappears rather than being packaged around.

## Goals / Non-Goals

**Goals:**
- Node and npm as the only runtime and package manager, across `src/`, `tests/`, `examples/`, the devcontainer, and a new production image.
- Byte-for-byte preservation of externally observable behavior: HTTP surfaces, status codes, SSE framing, and the SQLite schema.
- A test migration whose diff is dominated by import lines, not rewritten assertions.
- A production `Dockerfile` and `.dockerignore` on a single-runtime Node base.

**Non-Goals:**
- Any behavior change. The existing four specs are the regression contract.
- Removing `@anthropic-ai/claude-agent-sdk` — owned by `adopt-openai-responses-api`.
- Adding CI. The repository has no workflow to update.
- Reorganizing tests beyond what the runner swap requires.

## Decisions

### D1 — Run TypeScript directly via Node's type stripping; no build step

Node ≥ 24 executes `.ts` files by erasing types, and the sources already import with explicit `.ts` extensions (`import { loadConfig } from "./config.ts"`) — exactly what type stripping requires, and currently permitted by `allowImportingTsExtensions`. So the import specifiers need no edits at all.

*Alternatives:* `tsx` adds a dependency and a process wrapper to solve a problem the runtime already solves. A `tsc` build step introduces `dist/`, source maps, and a compile phase between edit and run — a real regression against Bun's current immediacy. Rejected both.

*Consequence:* type errors still do not block execution, exactly as under Bun. `npm run typecheck` remains the only type gate.

### D2 — `node:sqlite` over `better-sqlite3`

Built in, so no native module and no compiler in the image. `DatabaseSync` covers everything `store.ts` uses: `exec`, `prepare`, `get`, `all`, `run`, and `:memory:`. Notably the file already calls `db.prepare(...)` at all nine query sites rather than Bun's `db.query(...)` shorthand, so those lines are unchanged.

*Alternative:* `better-sqlite3` is the closest API match and does have `transaction()` (see D3), but it is a native addon requiring a build toolchain in the Docker image — the exact weight this migration is trying to shed. Rejected.

*Watch items:* `.get()` returns `undefined` for no-row where Bun returns `null`, and integer columns come back as `number` by default. `rowToApp` and the `... ?? null` call sites must be checked against both.

### D3 — Hand-roll the transaction helper, preserving the call shape

`store.ts:94` uses `db.transaction(() => {...})`, an API Bun inherited from `better-sqlite3`. **`node:sqlite` has no equivalent.** A local helper wraps the callback in `BEGIN` / `COMMIT` with `ROLLBACK` on throw, keeping the existing call site's shape and its all-or-nothing guarantee for the app+agents upsert.

```ts
const transaction = <T>(fn: () => T) => (): T => {
  db.exec("BEGIN");
  try { const out = fn(); db.exec("COMMIT"); return out; }
  catch (err) { db.exec("ROLLBACK"); throw err; }
};
```

This is the single most behavior-sensitive edit in the migration and gets a dedicated test: a mid-transaction throw must leave no partial rows.

### D4 — Vitest over `node:test`

All 25 files use Jest-style `expect`, including `expect(...).rejects.toThrow(/regex/)`. Vitest keeps `describe`/`it`/`expect` and the `rejects` matchers, so assertion bodies survive untouched and the review surface stays small. `node:test` + `node:assert` would mean rewriting hundreds of assertions by hand — the one place in this migration where silent weakening could hide.

*Cost, stated plainly:* a dev dependency and a `vitest.config.ts`, in a project that otherwise needs no bundler. Accepted for assertion fidelity.

`tests/setup.ts` moves from `bunfig.toml`'s `preload` to `test.setupFiles`, and `bunfig.toml` is deleted.

### D5 — `@hono/node-server` for both the server and test fixtures

`buildApp()` already returns a Hono app and is runtime-agnostic; only the `import.meta.main` block in `src/server.ts` binds a port. Bun's `idleTimeout` (capped at 255s, set from `requestTimeoutMs` to keep SSE alive) maps to the Node server's `requestTimeout`/`headersTimeout`.

Eight test files call `Bun.serve({ port: 0 })` and read `server.port` / call `server.stop()`. Node's `serve()` returns an `http.Server`, where the port comes from `server.address().port` and teardown is `server.close()`. Rather than open-coding that eight times, a shared `tests/helpers/listen.ts` exposes `{ port, close() }` so the fixtures stay one-liners.

### D6 — Container image: `node:26-slim`, multi-stage, non-root, `/data` volume

A `deps` stage runs `npm ci --omit=dev`; the runtime stage copies `node_modules`, `package.json`, and `src/`. No build output to copy. `IRI_DB_PATH=/data/iriguchi.db` on a declared volume so the registry survives container replacement, `IRI_TMP_DIR=/tmp/iri` as scratch, both chowned to the built-in non-root `node` user. Health check probes `/healthz` with `node -e` and `fetch`, avoiding a `curl` install. Secrets are never baked in — `loadConfig()` failing loudly at boot on a missing `IRI_API_KEY` is the desired behavior.

`.dockerignore` is a safety control here, not tidiness: the working tree holds a real `.env`, a populated `iriguchi.db`, and `.iri-tmp*`. A secret copied into a layer survives deleting the file in a later layer.

### D7 — Devcontainer moves to a Node image; the dead Dockerfile is deleted

`.devcontainer/devcontainer.json` pins `image: oven/bun:1` and never references `.devcontainer/Dockerfile` — that file (Debian + Node + Python-from-source + Claude Code) is built by nothing. Deleting it is correct; keeping a second, unused image definition through a runtime migration guarantees it rots further. `postCreateCommand` becomes `npm install`, and `remoteUser` moves from `bun` to `node`.

Per the project's memory note, the OpenSpec skill regeneration command runs inside the devcontainer via `bunx`. After this change that becomes `npx @fission-ai/openspec@latest update`.

### D8 — Lockfile transition is a clean generation, not a conversion

`npm install` generates `package-lock.json` from `package.json`; `bun.lock` and `bunfig.toml` are deleted. Dependency versions may shift within their declared ranges — `@anthropic-ai/claude-agent-sdk` is pinned to `"latest"`, so it will resolve to whatever is current. That resolution is worth recording in the migration commit.

### D9 — `erasableSyntaxOnly` guards the no-build-step decision (added during implementation)

Vitest transpiles through esbuild, which accepts parameter properties happily. Node's strip-only mode does not. That divergence meant a full green test suite coexisted with a server that crashed on startup with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` — discovered only when the container was booted, because nothing in the suite executes `src/server.ts` as a process.

Enabling `erasableSyntaxOnly` in `tsconfig.json` moves that failure into `npm run typecheck`, where it is cheap. Without it, D1's no-build-step decision rests on a property nothing enforces.

*Consequence:* the sources may not use enums, namespaces, or parameter properties. That is a real constraint on future code, and the right trade for keeping the build step gone.

### D10 — Test fixture helpers absorb Bun/Node API differences (refined during implementation)

`tests/helpers/listen.ts` deliberately mirrors the `Bun.serve({ port, fetch })` options object rather than taking a bare handler, so converting 8 fixtures was a textual `Bun.serve(` → `listen(` swap with no structural edits. It also carries three compatibility details Bun provided for free: an idempotent `stop()` (node's `close()` throws `ERR_SERVER_NOT_RUNNING` on a second call, which several suites make), a `fetch` passthrough (`chat.test.ts` proxies one fake server through another), and an `idleTimeout` passthrough mapped to disabling node's `requestTimeout`.

`tests/helpers/spawn.ts` does the same for `Bun.spawn`, exposing stdout as a web `ReadableStream` via `Readable.toWeb` so the `getReader()` scraping loops in the handshake and e2e tests needed no rewriting.

## Risks / Trade-offs

- **`db.transaction()` has no `node:sqlite` equivalent (D3)** → hand-rolled BEGIN/COMMIT/ROLLBACK wrapper plus a dedicated rollback test asserting no partial rows after a mid-transaction throw.
- **`.get()` null-vs-undefined and integer typing differ between drivers** → audit every `store.ts` return path; the existing store integration tests cover `getApp`/`lookupAgent` misses.
- **Vitest pulls a bundler-adjacent dependency into a build-free project (D4)** → confined to `devDependencies`; production `npm ci --omit=dev` and the Docker image never install it.
- **Types are still unchecked at runtime (D1)** → unchanged exposure from Bun, but `npm run typecheck` must be run and green before this change is considered done.
- **`npm install` may resolve `@anthropic-ai/claude-agent-sdk` to a newer version (D8)** → run the full suite after lockfile generation and treat any failure as an SDK-version issue, not a migration bug.
- **Ephemeral-port fixtures behave differently under `@hono/node-server` (D5)** → one shared helper, so the difference is absorbed in a single file rather than eight.
- **Collision with `adopt-openai-responses-api`** → that change touches the same test files and must not run in parallel. It starts after this lands.

## Migration Plan

Ordered so the suite is runnable as early as possible:

1. `package.json` (scripts, `engines`, deps), generate `package-lock.json`, delete `bun.lock` and `bunfig.toml`, retarget `tsconfig.json` to Node types and module resolution.
2. Runtime call sites: `store.ts` (driver + transaction helper), `server.ts` (`@hono/node-server` + main guard), `tools.ts` (`timers/promises`).
3. Vitest config and `tests/helpers/listen.ts`; migrate the 25 test files. **`npm test` green here is the regression gate** — do not proceed until it is.
4. `Dockerfile` + `.dockerignore`; build and boot-verify.
5. Devcontainer, `examples/weather-app`, `README.md`, `.env.example`, `docs/`.

**Rollback:** the change is a single branch touching no persisted data — the SQLite schema and file format are untouched, so a database written under Bun is read unchanged under Node. Reverting the branch is sufficient; no data migration to undo.

## Open Questions

None blocking. Two items are deliberately deferred rather than unresolved: adding CI to enforce `typecheck` (out of scope, no workflow exists today), and whether `examples/weather-app` should keep its own lockfile or join a workspace (left as-is — it has none today).
