# management-ui Specification

## Purpose

Define the shipped management client: how it is built and served, what the chat panel and the read-only agent catalog present, how MCP connection health is shown and refreshed, and how the interface degrades when the gateway or a declared MCP server is unavailable.

## Requirements

### Requirement: The UI is a static client served by the gateway

The management UI SHALL be built as static assets from a `ui/` package in this repository and served by the gateway at `/ui` when `IRI_UI_ENABLED` is true. It SHALL obtain all data at run time from `/internal/*` over HTTP and SHALL hold no direct access to the registry, the MCP cache, or configuration. It SHALL NOT be rendered on the server, and the gateway SHALL NOT invoke a bundler while serving a request. When the built assets are absent, a request to `/ui` SHALL return a message naming the missing build and the command that produces it, rather than a bare `404`.

#### Scenario: Built UI is served alongside the API
- **WHEN** the UI has been built and the gateway starts with `IRI_UI_ENABLED=true`
- **THEN** `GET /ui` returns the application shell and its assets load from the same origin and port as `/v1`

#### Scenario: UI is absent when the surface is disabled
- **WHEN** the gateway starts with `IRI_UI_ENABLED` unset
- **THEN** `GET /ui` returns `404`

#### Scenario: Missing build is diagnosed
- **WHEN** `IRI_UI_ENABLED=true` but no built assets exist at the configured location
- **THEN** the response names the missing build directory and the build command to run

### Requirement: The chat panel selects an agent and streams its reply

The UI SHALL present a chat panel whose agent picker is populated from the live agent catalog, showing each agent's id, owning app, and resolved provider and model. Sending a message SHALL post the transcript to the chat proxy with the selected agent and render the streamed reply incrementally as it arrives. The transcript SHALL accumulate across turns within the session so that a follow-up message carries the preceding turns. Switching the selected agent SHALL be an explicit act that does not silently reinterpret an in-flight run.

#### Scenario: Agent list comes from the registry
- **WHEN** the chat panel loads
- **THEN** the picker lists exactly the agents the catalog reports, each labeled with its owning app and resolved model

#### Scenario: Reply renders as it streams
- **WHEN** a message is sent to a selected agent
- **THEN** the assistant's text appears incrementally as chunks arrive, before the stream completes

#### Scenario: Multi-turn context is preserved
- **WHEN** a second message is sent in the same session
- **THEN** the request carries the prior user and assistant turns

#### Scenario: No agents registered
- **WHEN** the catalog is empty
- **THEN** the panel states that no agents are registered and disables sending, rather than presenting an empty picker

### Requirement: The agent catalog view is read-only

The UI SHALL present a catalog listing every agent with its owning app, description, resolved provider and model, and counts of `api_call` tools, MCP servers, and skills. Selecting an agent SHALL show its detail: each `api_call` tool with its description and HTTP method and path, each MCP server with its URL and configured header names, each skill, and the agent's system prompt. The UI SHALL offer no control that registers, refreshes, deletes, or otherwise mutates an app, agent, or gateway setting.

#### Scenario: Catalog reflects the registry
- **WHEN** the catalog view loads with two apps registered
- **THEN** every agent of both apps is listed with its tool, MCP, and skill counts

#### Scenario: Detail separates tool kinds
- **WHEN** an agent with both `api_call` tools and MCP servers is opened
- **THEN** the two are shown as distinct groups, each with the fields relevant to its kind

#### Scenario: No mutating affordances
- **WHEN** any catalog view is inspected
- **THEN** it contains no control that issues a write to `/apps/*` or to any gateway setting

#### Scenario: Header values are never displayed
- **WHEN** an MCP server declares an `Authorization` header
- **THEN** the detail view names the header without displaying its value

### Requirement: MCP connection health is visible and refreshable

Each MCP server shown in the catalog SHALL display its status — `ok`, `stale`, `unknown`, or `unreachable` — as a visually distinguishable state, together with its last discovered tool count and the time that discovery or failed attempt occurred. `unreachable` SHALL show the recorded error message. Each server SHALL offer a probe control that triggers an on-demand connection attempt and updates the displayed status with the live outcome. Loading the catalog SHALL NOT trigger probes.

#### Scenario: Never-contacted server is distinguishable from a broken one
- **WHEN** one server has never been contacted and another failed its last attempt
- **THEN** the first is shown as `unknown` and the second as `unreachable` with its error message, in visually distinct states

#### Scenario: Probe updates the displayed status
- **WHEN** the probe control is used on a server that is now reachable
- **THEN** the status becomes `ok` with the freshly discovered tool count and the probe's timestamp

#### Scenario: Catalog load performs no probes
- **WHEN** the catalog is loaded while every declared server is down
- **THEN** the view renders promptly with cached statuses and no connection is attempted

### Requirement: The UI degrades rather than breaks when the gateway is unavailable

The UI SHALL report a failed or errored `/internal/*` request as a visible, human-readable state naming what could not be loaded, and SHALL leave the rest of the interface usable. A failure in one panel SHALL NOT blank the other. A failed chat run SHALL leave the transcript intact and allow a retry.

#### Scenario: Catalog request fails
- **WHEN** `/internal/agents` returns an error or cannot be reached
- **THEN** the catalog shows an error state naming the failure and the chat panel remains rendered

#### Scenario: Chat run fails
- **WHEN** a chat request fails or its stream errors mid-run
- **THEN** the error is shown in the transcript, prior turns remain visible, and the input remains usable
