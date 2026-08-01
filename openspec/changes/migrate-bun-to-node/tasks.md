## 1. Toolchain and project configuration

- [x] 1.1 Rewrite `package.json` scripts for Node: `dev` (`node --watch src/server.ts`), `start`, `test`, `test:e2e`, `typecheck`.
- [x] 1.2 Add `engines.node` declaring the supported floor (≥ 24; verified against 26.1.0).
- [x] 1.3 Add `@hono/node-server` to dependencies; add `vitest` and `@types/node` to devDependencies; remove `@types/bun`.
- [x] 1.4 Run `npm install` to generate `package-lock.json`; record the resolved `@anthropic-ai/claude-agent-sdk` version in the commit message, since it is pinned to `latest`.
- [x] 1.5 Delete `bun.lock` and `bunfig.toml`.
- [x] 1.6 Update `tsconfig.json`: `types` from `bun-types` to `node`, module resolution retargeted to Node. Keep `allowImportingTsExtensions` — the sources already import with explicit `.ts` extensions, which Node's type stripping requires.
- [x] 1.7 Confirm `npx tsc --noEmit` runs and reports only pre-existing issues, if any.

## 2. Runtime call sites

- [x] 2.1 `src/registry/store.ts`: replace `Database` from `bun:sqlite` with `DatabaseSync` from `node:sqlite`. The nine `db.prepare(...)` sites and the `db.exec` schema block carry over unchanged.
- [x] 2.2 Add the transaction helper from `design.md` D3 (`BEGIN`/`COMMIT`, `ROLLBACK` on throw) and repoint the `db.transaction(...)` call site at `store.ts:94` to it. **`node:sqlite` has no `transaction()` — this is the highest-risk edit in the change.**
- [x] 2.3 Audit every `store.ts` return path for the driver's `undefined`-vs-`null` empty-row result and integer column typing; make `getApp`, `listApps`, and `lookupAgent` return exactly what they did before.
- [x] 2.4 `src/server.ts`: replace `Bun.serve` with `serve()` from `@hono/node-server`, mapping the Bun `idleTimeout` derived from `requestTimeoutMs` onto the Node server's timeout settings so SSE connections are not severed.
- [x] 2.5 `src/server.ts`: replace the `import.meta.main` guard with an `import.meta.filename` / `process.argv[1]` comparison.
- [x] 2.6 `src/agent/tools.ts:86`: replace `Bun.sleep(500)` with `setTimeout` from `node:timers/promises`, preserving the single 5xx/timeout/network retry.
- [x] 2.7 Grep `src/` for any remaining `Bun.` or `bun:` reference; expect zero.

## 3. Test suite

- [x] 3.1 Add `vitest.config.ts` with `tests/setup.ts` as `setupFiles`, replacing `bunfig.toml`'s `preload`, and a timeout matching the current 30s.
- [x] 3.2 Add `tests/helpers/listen.ts` exposing `{ port, close() }` over `@hono/node-server`, so the eight `Bun.serve({ port: 0 })` fixtures stay one-liners.
- [x] 3.3 Convert all 25 files under `tests/` from `bun:test` to `vitest` imports. Assertion bodies should not need editing — if a `expect(...)` call requires rewriting, note why.
- [x] 3.4 Repoint the `Bun.serve` fixtures in `tests/integration/{tools,manifest,runner,registration,refresher,example-app-handshake}.test.ts` and `tests/unit/skills.test.ts` at the helper from 3.2, including `server.port` and `server.stop()` usages.
- [x] 3.5 Replace `Bun.sleep` in the refresher, manifest, tools, and skills tests with `node:timers/promises`.
- [x] 3.6 Replace the three `Bun.file(...).exists()` assertions in `tests/unit/skills.test.ts` with a `node:fs` existence check.
- [x] 3.7 Add a store test asserting transaction rollback: an error raised mid-write leaves neither the app row nor its agent rows behind.
- [x] 3.8 Run `npm test`. **This is the regression gate — every pre-existing test must pass before any later group starts.**

## 4. Container image

- [x] 4.1 Add a multi-stage `Dockerfile` on `node:26-slim`: a deps stage running `npm ci --omit=dev`, and a runtime stage copying `node_modules`, `package.json`, and `src/`. No build output to copy.
- [x] 4.2 Set `IRI_PORT`, `IRI_DB_PATH=/data/iriguchi.db`, and `IRI_TMP_DIR=/tmp/iri`; create both directories owned by the non-root `node` user; declare `VOLUME /data`; `EXPOSE` the port; run as `node`.
- [x] 4.3 Add a `HEALTHCHECK` probing `/healthz` via `node -e` with `fetch`, avoiding a `curl` install.
- [x] 4.4 Add `.dockerignore` covering `node_modules`, `.git`, `.env*`, `iriguchi.db*`, `.iri-tmp*`, `tests`, `examples`, `openspec`, `docs`, `.devcontainer`, `.claude`.
- [x] 4.5 Build the image and boot it with throwaway credentials; confirm `/healthz` answers and the database is created under `/data`.
- [x] 4.6 Confirm the built image contains no `.env` and no database file from the build context.
- [x] 4.7 Confirm the container exits with a configuration error when `IRI_API_KEY` is absent.

## 5. Development environment

- [x] 5.1 Update `.devcontainer/devcontainer.json`: `image` to a Node image, `remoteUser` to `node`, `postCreateCommand` to `npm install` for the root and the weather-app example. Keep the forwarded ports.
- [x] 5.2 Delete `.devcontainer/Dockerfile` — `devcontainer.json` references an image directly and never builds it, so nothing consumes this file.
- [x] 5.3 Update the memory note's OpenSpec regeneration command from `bunx` to `npx @fission-ai/openspec@latest update`.

## 6. Example app and documentation

- [x] 6.1 `examples/weather-app`: replace the single `Bun.serve` at `src/server.ts:90` with `@hono/node-server`, add the dependency, and update its `dev`/`start` scripts.
- [x] 6.2 Generate `examples/weather-app/package-lock.json`.
- [x] 6.3 Update `README.md`: the stack line (line 5), the Bun install prerequisite (lines 11–19), the example-app instructions (lines 30–31), and the test/typecheck commands (lines 124–126).
- [x] 6.4 Add README coverage for building and running the container image, including required environment variables and the data volume.
- [x] 6.5 Sweep `docs/` and `.env.example` for `bun` references and update them.

## 7. Verification

- [x] 7.1 Run `npm test` and `npm run typecheck`; both green.
- [x] 7.2 Confirm the suite passes with no provider credentials present and no network access.
- [x] 7.3 Start the gateway against a database file created under the Bun build and confirm previously registered apps are readable without migration.
- [x] 7.4 Exercise a streaming completion end to end against a fake provider and confirm the SSE frame sequence is unchanged.
- [x] 7.5 Run `openspec validate migrate-bun-to-node` and resolve findings.
- [x] 7.6 Confirm no `Bun.`, `bun:`, `bun.lock`, or `bunfig.toml` reference remains anywhere in the repository.
- [x] 7.7 (added during apply) Fix non-erasable syntax: `GatewayError` and `ManifestFetchError` used constructor parameter properties, which crashed `node src/server.ts` at startup with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` while the vitest suite stayed green. Both now assign fields explicitly.
- [x] 7.8 (added during apply) Enable `erasableSyntaxOnly` in `tsconfig.json` so non-erasable syntax fails at typecheck rather than at container boot. See design D9.

## 8. Sequencing follow-up

- [ ] 8.1 Once this change is archived, confirm `adopt-openai-responses-api` group 1 targets Vitest and `tests/helpers/listen.ts` rather than the Bun fixtures its tasks currently describe.
