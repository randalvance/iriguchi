## Why

The gateway is written against Bun's runtime APIs — `Bun.serve`, `bun:sqlite`, `bun:test`, `Bun.sleep` — which means the choice of runtime is not an operational detail but a source-level dependency. That coupling has a concrete cost today: the production image cannot be a plain Bun image, because `@anthropic-ai/claude-agent-sdk` spawns its bundled CLI as a `node` subprocess, so any container must carry both runtimes and hope they agree. Node 26 now runs the TypeScript sources directly with no build step, ships a stable `node:sqlite`, and needs none of that. Standardizing on Node and npm removes the second runtime rather than containerizing around it.

Doing this before `adopt-openai-responses-api` is deliberate. That change rewrites nearly every test file against a new scripted provider; migrating first means each test file is rewritten once, in its final idiom, instead of being authored under `bun:test` and converted weeks later.

## What Changes

- **Node and npm become the only runtime and package manager.** `bun.lock` is replaced by `package-lock.json`, `bunfig.toml` is deleted, and every documented command moves from `bun x` to `npm run x`. Node's native type stripping runs `src/**/*.ts` directly — no bundler, no `tsc` build, no `tsx`.
- **Four runtime call sites change.** `Bun.serve` → `@hono/node-server`; `bun:sqlite` → the built-in `node:sqlite`; `Bun.sleep` → `timers/promises`; `import.meta.main` → an `import.meta.filename`/`process.argv[1]` comparison. The `Store` type already hides the database driver, so the SQLite swap is confined to `src/registry/store.ts`.
- **Tests move to Vitest.** All 25 files under `tests/` drop `bun:test`. Vitest keeps the `describe`/`it`/`expect` surface, so assertion bodies survive intact; `Bun.serve` fixtures become `@hono/node-server`, and `tests/setup.ts` moves from `bunfig.toml`'s `preload` to Vitest's `setupFiles`.
- **A production Dockerfile is added**, on a Node base, with a `.dockerignore`. This is what prompted the change: on Node the image needs one runtime, and the Agent SDK's subprocess is no longer foreign to it.
- **The dev environment follows.** `.devcontainer/devcontainer.json` moves from `oven/bun:1` to a Node image, and the unused `.devcontainer/Dockerfile` — referenced by nothing — is removed rather than maintained in parallel.
- **`examples/weather-app` migrates too**, so the repository runs a single runtime end to end.
- **No externally observable behavior changes.** Every HTTP surface, status code, SSE frame, and database schema is preserved exactly; the existing specs are the regression contract.

## Capabilities

### New Capabilities
- `runtime-platform`: the execution and packaging contract — supported Node version, npm as the package manager, direct TypeScript execution with no build step, the SQLite driver, the test runner, and the container image's runtime interface (environment, data volume, port, health check, non-root user).

### Modified Capabilities

None. `agent-tool-invocation`, `app-registration`, `chat-completions-protocol`, and `provider-routing` describe externally observable behavior, and none of it changes. Preserving them unmodified is the acceptance criterion for this change, not a side effect of it.

## Impact

**Code**
- `src/server.ts` — `Bun.serve` → `serve()` from `@hono/node-server`; `import.meta.main` guard.
- `src/registry/store.ts` — `Database` from `bun:sqlite` → `DatabaseSync` from `node:sqlite`. `db.query(...)` becomes `db.prepare(...)`; `exec`, `get`, `all`, `run`, and `:memory:` carry over. WAL and foreign-key pragmas are unchanged.
- `src/agent/tools.ts` — `Bun.sleep` → `setTimeout` from `timers/promises`.
- `tests/**` — 25 files: import lines, `Bun.serve` fixtures in 8 of them, `Bun.sleep`, and `Bun.file` existence checks in `tests/unit/skills.test.ts`.

**Dependencies**
- Added: `@hono/node-server`; `vitest` and `@types/node` as dev dependencies.
- Removed: `@types/bun`, and `bun-types` from `tsconfig.json`'s `types`.
- `tsconfig.json` moves to Node module resolution. `allowImportingTsExtensions` stays — the sources already import with explicit `.ts` extensions, which is what Node's type stripping requires.

**Prerequisite**
Node ≥ 24 for stable `node:sqlite` and unflagged type stripping; verified against v26.1.0. `package.json` declares the floor in `engines`.

**Risk: no compile step.** Bun and Node both execute TypeScript without type-checking it. `npm run typecheck` (`tsc --noEmit`) remains the only type gate and must stay green in CI — the migration neither adds nor removes that exposure, but it is worth stating plainly.

**Sequencing**
`adopt-openai-responses-api` (49 tasks, none started) should begin only after this lands. Its group 1 introduces a new provider test helper and its groups 2–4 rewrite the runner and chat integration tests; both are far cheaper to author once against Vitest. The two changes touch the same test files and should not proceed in parallel.

**Out of scope**
Behavior changes of any kind, the Agent SDK removal (owned by `adopt-openai-responses-api`), and CI configuration — the repository has no CI workflow to update.
