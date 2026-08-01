# runtime-platform Specification

## Purpose

Define how the gateway is executed and packaged: the runtime and package manager, direct TypeScript execution without a build step, the embedded SQLite driver and the atomicity of registry writes, how the test suite runs offline, and the container image's runtime interface. Also fixes that changing any of this must not alter externally observable behavior.

## Requirements

### Requirement: Node is the sole runtime and npm the sole package manager

The gateway SHALL execute on Node.js and declare its minimum supported version in `package.json` `engines`. Dependencies SHALL be resolved through npm against a committed `package-lock.json`. No Bun-specific global, built-in module, or configuration file SHALL remain in the repository.

#### Scenario: Installing and starting from a clean checkout
- **WHEN** an operator runs `npm ci` followed by `npm start` on a machine with a supported Node version and required environment variables set
- **THEN** the gateway starts and serves requests, with Bun neither installed nor invoked

#### Scenario: No Bun artifacts remain
- **WHEN** the repository is searched for `bun.lock`, `bunfig.toml`, `bun:` module specifiers, or `Bun.` global references
- **THEN** no matches are found in `src/`, `tests/`, `examples/`, or the devcontainer configuration

#### Scenario: Unsupported Node version
- **WHEN** the declared `engines.node` floor is not satisfied by the running interpreter
- **THEN** npm reports the version mismatch during install

### Requirement: TypeScript sources execute without a build step

The gateway SHALL run its TypeScript sources directly through the Node runtime, producing no compiled output directory. Source files SHALL remain restricted to erasable TypeScript syntax, and this restriction SHALL be enforced at type-check time rather than discovered at startup. Type checking SHALL be available as a separate, non-blocking command.

#### Scenario: Starting the server from source
- **WHEN** `npm start` is run
- **THEN** the Node process executes `src/server.ts` directly and no build artifact is generated or required

#### Scenario: Type checking is a distinct gate
- **WHEN** `npm run typecheck` is run
- **THEN** `tsc --noEmit` reports type errors without emitting files, and its result does not affect the ability to start the server

#### Scenario: Non-erasable syntax is rejected before it reaches the runtime
- **WHEN** a source file introduces an enum, a namespace, or a constructor parameter property
- **THEN** `npm run typecheck` fails, rather than the failure surfacing only when the server process starts

### Requirement: Registry persistence uses the embedded SQLite driver

The gateway SHALL persist its app and agent registry through Node's built-in SQLite driver at the path given by `IRI_DB_PATH`, with WAL journaling and foreign-key enforcement enabled. The database schema SHALL be unchanged, and `:memory:` SHALL remain a valid path.

#### Scenario: Registering and retrieving an app
- **WHEN** an app registers and is subsequently looked up by id, and one of its agents is looked up by agent id
- **THEN** the stored record is returned with its manifest intact, matching the behavior specified in `app-registration`

#### Scenario: A database written by a previous release is reopened
- **WHEN** the gateway starts against an existing database file created before this change
- **THEN** it opens successfully and returns the previously registered apps without migration

#### Scenario: Lookup of an absent record
- **WHEN** an app or agent id that was never registered is looked up
- **THEN** the store reports the record as absent rather than returning a partially populated object

### Requirement: App registration writes are atomic

Writing an app together with its agent rows SHALL succeed or fail as a unit. A failure partway through the write SHALL leave no rows from that write behind.

#### Scenario: Failure partway through a registration write
- **WHEN** an error is raised after the app row is written but before its agent rows are committed
- **THEN** the transaction is rolled back and neither the app row nor any of its agent rows is present afterward

#### Scenario: Re-registering an existing app
- **WHEN** an app that is already registered registers again with a different agent set
- **THEN** its previous agent rows are replaced and no orphaned agent rows remain

### Requirement: The automated test suite runs offline under a single command

`npm test` SHALL run the unit and integration suites to completion without network access and without any real provider credentials. Tests requiring live providers SHALL remain opt-in behind an explicit environment flag.

#### Scenario: Running the suite with no credentials and no network
- **WHEN** `npm test` is run with no provider API keys present and no outbound network access
- **THEN** the unit and integration suites pass, using local fixtures bound to ephemeral ports

#### Scenario: Live provider tests stay opt-in
- **WHEN** `npm test` is run without the end-to-end flag set
- **THEN** tests that would contact a real provider are not executed

### Requirement: The gateway ships as a runnable container image

The repository SHALL provide a Dockerfile producing an image that runs the gateway as a non-root user. All configuration SHALL be supplied through environment variables at run time; no credential SHALL be baked into any layer. The registry database SHALL live on a declared volume so it survives container replacement. The image SHALL expose the gateway port and report health from the existing `/healthz` endpoint.

#### Scenario: Running the image with required configuration
- **WHEN** the image is run with the required environment variables and a volume mounted at the data path
- **THEN** the gateway starts, `/healthz` reports ok, and the database is created on the mounted volume

#### Scenario: Running the image without required configuration
- **WHEN** the image is run with `IRI_API_KEY` absent
- **THEN** the container fails at startup with a configuration error rather than serving unauthenticated requests

#### Scenario: The registry outlives the container
- **WHEN** an app registers, the container is destroyed, and a new container is started against the same volume
- **THEN** the previously registered app is still present

#### Scenario: Build context excludes local secrets and state
- **WHEN** the image is built from a working tree containing `.env`, a populated database file, and temporary agent directories
- **THEN** none of them are present in the resulting image

### Requirement: Externally observable behavior is unchanged by the runtime migration

Changing the runtime SHALL NOT alter any behavior specified by `chat-completions-protocol`, `app-registration`, `agent-tool-invocation`, or `provider-routing`, including status codes, response bodies, streaming frame format, and error shapes.

#### Scenario: Existing specs continue to hold
- **WHEN** the full test suite covering the four existing capabilities is run against the migrated runtime
- **THEN** every scenario passes without amendment to those specs

#### Scenario: Streaming responses are unaffected
- **WHEN** a client requests a streaming completion
- **THEN** the SSE frame sequence and termination sentinel match the format required by `chat-completions-protocol`, and long-running responses are not severed by an idle timeout
