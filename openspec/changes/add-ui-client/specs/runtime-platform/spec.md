## MODIFIED Requirements

### Requirement: TypeScript sources execute without a build step

The gateway SHALL run its TypeScript sources directly through the Node runtime, producing no compiled output directory. Source files SHALL remain restricted to erasable TypeScript syntax, and this restriction SHALL be enforced at type-check time rather than discovered at startup. Type checking SHALL be available as a separate, non-blocking command.

This rule scopes to the gateway. The management UI SHALL be a separate package with its own dependencies and its own build, producing static assets in a distinct output directory that the gateway serves as files. The gateway SHALL NOT compile, bundle, or transform UI sources — at startup or while serving a request — and starting the gateway SHALL NOT require the UI to have been built.

#### Scenario: Starting the server from source
- **WHEN** `npm start` is run
- **THEN** the Node process executes `src/server.ts` directly and no build artifact is generated or required for the gateway

#### Scenario: Type checking is a distinct gate
- **WHEN** `npm run typecheck` is run
- **THEN** `tsc --noEmit` reports type errors without emitting files, and its result does not affect the ability to start the server

#### Scenario: Non-erasable syntax is rejected before it reaches the runtime
- **WHEN** a source file introduces an enum, a namespace, or a constructor parameter property
- **THEN** `npm run typecheck` fails, rather than the failure surfacing only when the server process starts

#### Scenario: The UI builds separately from the gateway
- **WHEN** the UI build command is run
- **THEN** static assets are produced in the UI package's own output directory, and no gateway source is compiled or emitted

#### Scenario: The gateway starts without a built UI
- **WHEN** `npm start` is run in a checkout where the UI has never been built
- **THEN** the gateway starts and serves `/v1` and `/apps` normally

### Requirement: The gateway ships as a runnable container image

The repository SHALL provide a Dockerfile producing an image that runs the gateway as a non-root user. All configuration SHALL be supplied through environment variables at run time; no credential SHALL be baked into any layer. The registry database SHALL live on a declared volume so it survives container replacement. The image SHALL expose the gateway port and report health from the existing `/healthz` endpoint.

The build SHALL produce the management UI's static assets in a stage separate from the runtime layer and copy only those assets forward, so no frontend toolchain or UI source ships in the final image. The image SHALL NOT enable the internal surface or the UI by default; both remain governed by run-time environment configuration.

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

#### Scenario: Built UI assets are present without their toolchain
- **WHEN** the image is inspected after a build
- **THEN** the UI's static assets are present at the path the gateway serves, and neither the UI's source nor its build dependencies are in the runtime layer

#### Scenario: The image does not expose the internal surface by default
- **WHEN** the image is run with only the required environment variables
- **THEN** `/internal/*` and `/ui` return `404`
