# chat-ui-client Specification

## Purpose
TBD - created by syncing change add-chat-ui-client. Update Purpose after archive.
## Requirements
### Requirement: The client ships as a standalone sibling package
The repository SHALL contain a `@iriguchi/chat-ui` package with its own `package.json` and `tsconfig.json`, outside the gateway's dependency graph and not an npm workspace member, following the convention already used by `ui/`. The root `package.json` SHALL expose `chat-ui:install`, `chat-ui:build`, `chat-ui:check`, and `chat-ui:test` scripts so the package is reachable from the repository root. The package SHALL declare React as a peer dependency rather than a dependency, and its entry points SHALL be separated so that a consumer importing only the server proxy pulls in no React and no browser API.

#### Scenario: Package toolchain runs from the repository root
- **WHEN** `npm run chat-ui:check` and `npm run chat-ui:test` are run at the repository root
- **THEN** the package's type check and test suite execute and report their own results

#### Scenario: Gateway build is unaffected
- **WHEN** the gateway's `npm test` and `npx tsc --noEmit` are run
- **THEN** both pass and neither compiles nor loads any file from the client package

#### Scenario: Server entry point is browser-free
- **WHEN** a consumer imports only the server proxy entry point in a Node process
- **THEN** the import resolves without requiring React or any DOM global

#### Scenario: Tests need no credentials or network
- **WHEN** the package's test suite runs with no environment variables set and no network access
- **THEN** every test passes

### Requirement: Components register named context slices
The client SHALL let any component register a named context slice consisting of a key and a callback that produces that key's value. The callback SHALL be permitted to return either a value or a promise of a value. A registration SHALL remain active until the registering component unmounts, at which point the slice SHALL be removed. Registration SHALL NOT require the registering component to be an ancestor or descendant of any other registering component beyond the shared provider.

#### Scenario: A slice becomes a top-level context key
- **WHEN** a component registers the slice `account` returning `{ accountId: 42 }` and a message is sent
- **THEN** the request's `iri_context` contains a top-level `account` key whose value is that object

#### Scenario: Sibling components compose
- **WHEN** one component registers `account` and an unrelated sibling registers `visibleRows`
- **THEN** a single request carries both keys, and neither component needs to know about the other

#### Scenario: Unmounting removes the slice
- **WHEN** a component that registered `visibleRows` unmounts and a message is then sent
- **THEN** the request's `iri_context` contains no `visibleRows` key

#### Scenario: Duplicate keys warn and last-wins
- **WHEN** two mounted components register the same slice key
- **THEN** the most recent registration supplies the value, and a warning naming the key is emitted in development builds only

### Requirement: Context is derived fresh on every send
The client SHALL invoke every registered slice callback at send time, on each send, and SHALL await any returned promise before dispatching the request. It SHALL NOT cache a previously produced value across sends, and SHALL NOT carry a previous turn's `iri_context` into a later request. A slice callback that throws or rejects SHALL cause that slice to be omitted, with the failure surfaced to the host through the client's error channel, and the send SHALL proceed with the remaining slices.

#### Scenario: Values reflect the current page
- **WHEN** the user navigates from one account page to another and sends a message
- **THEN** the request carries the new page's slice values, not the previous page's

#### Scenario: Async slices are awaited
- **WHEN** a slice callback returns a promise that resolves after 50ms
- **THEN** the request is dispatched only after it resolves and carries its resolved value

#### Scenario: A failing slice does not fail the send
- **WHEN** one of three registered slice callbacks rejects
- **THEN** the request is sent carrying the other two slices, and the failure is reported to the host

#### Scenario: Empty context is omitted entirely
- **WHEN** no slices are registered and a message is sent
- **THEN** the request body omits `iri_context` rather than sending an empty object

### Requirement: The conversation survives client-side navigation
The client SHALL retain the message history across client-side route changes within the host application, and SHALL NOT reset, clear, or restart the conversation when the registered slices change. Only the context attached to each new turn SHALL change with the page.

#### Scenario: Thread continues across pages
- **WHEN** the user sends a message on one page, navigates to another page, and sends a second message
- **THEN** the second request carries the full prior history and the second page's context

#### Scenario: Panel state is preserved across navigation
- **WHEN** the panel is open and the user navigates client-side
- **THEN** the panel remains open with its transcript intact

### Requirement: Oversized context is rejected client-side with a named slice
The client SHALL serialize the merged context and compare its byte length against a configured maximum that defaults to the gateway's 65536 and is overridable by the host. When the limit is exceeded, the client SHALL NOT dispatch the request, and SHALL raise an error that names the limit, the observed size, and the single largest contributing slice. A slice SHALL be able to opt into truncation at registration; when the limit is exceeded and truncating opted-in slices brings the context under the limit, the client SHALL truncate those slices and send rather than fail.

#### Scenario: Oversized context fails before the network
- **WHEN** the merged context serializes to more than the configured maximum and no slice opts into truncation
- **THEN** no request is dispatched and the error names the limit, the observed size, and the largest slice

#### Scenario: Opt-in truncation rescues the send
- **WHEN** a slice registered with truncation enabled is the reason the context is oversized
- **THEN** that slice's value is reduced until the merged context fits, the request is sent, and the host is told the slice was truncated

#### Scenario: Truncation is not silent
- **WHEN** a slice is truncated
- **THEN** the sent context records that the slice was truncated, so the model is not told it has the whole payload

### Requirement: Requests stream and render incrementally
The client SHALL send `stream: true` and SHALL render assistant text as `chat.completion.chunk` deltas arrive rather than after the run completes. It SHALL treat the `data: [DONE]` sentinel as the end of the run, SHALL ignore chunks it does not recognize rather than aborting, and SHALL mark the in-flight assistant turn as in-flight for the duration of the stream. The request SHALL carry the configured agent id as `iri_agent` and the full client-held message history.

#### Scenario: Tokens render as they arrive
- **WHEN** the stream emits three text deltas over several seconds
- **THEN** the transcript shows the partial text after each delta, before the run completes

#### Scenario: Unknown chunk fields are tolerated
- **WHEN** a chunk carries a field the client does not recognize
- **THEN** the client renders any text delta it does contain and continues the stream

#### Scenario: Completion clears the in-flight marker
- **WHEN** `data: [DONE]` arrives
- **THEN** the assistant turn is marked complete and the composer accepts a new message

#### Scenario: History is resent every turn
- **WHEN** a third message is sent in a conversation
- **THEN** the request body carries all prior user and assistant messages, since the gateway holds no session

### Requirement: A run in flight can be cancelled
The client SHALL expose a cancel action while a run is in flight, and cancelling SHALL abort the underlying request. Text already received SHALL remain in the transcript, marked as cancelled rather than deleted, and the composer SHALL become usable again. A cancelled run SHALL NOT be presented as an error. A run SHALL be considered in flight from the moment it is requested — including while its context slices are still resolving, before any request has been dispatched — so that for that whole period the client reports itself as streaming, refuses a second send, and honours a cancel.

#### Scenario: Cancel stops the stream
- **WHEN** the user cancels mid-run
- **THEN** the request is aborted, the partial assistant text remains and is marked cancelled, and the composer is enabled

#### Scenario: In flight while context is still being derived
- **WHEN** a registered slice has not yet resolved and no request has been dispatched
- **THEN** the client reports itself as streaming, and the panel shows the cancel affordance rather than an idle composer

#### Scenario: A second send during context derivation is refused
- **WHEN** the user sends again while a slow slice is still resolving
- **THEN** the second send is ignored, no second run starts, and exactly one request is dispatched

#### Scenario: Cancel before dispatch
- **WHEN** the user cancels while slices are still resolving
- **THEN** no request reaches the gateway, the turn is marked cancelled rather than failed, and a later send proceeds normally

#### Scenario: Cancelled text stays in history
- **WHEN** the user sends another message after cancelling
- **THEN** the cancelled partial turn is included in the resent history

### Requirement: Failures have a defined presentation in both positions
The client SHALL distinguish a failure that occurs before any token has rendered from one that arrives after rendering has begun. A pre-stream failure SHALL replace the pending assistant turn with an error turn. A mid-stream failure SHALL retain the text already rendered and append an error indication to that same turn. In both cases prior turns SHALL remain intact and the composer SHALL become usable again. When the gateway returns a JSON error body, the client SHALL surface its `code` and message rather than a generic failure string.

#### Scenario: Failure before any output
- **WHEN** the request returns `400` with `code: "context_too_large"` before the stream opens
- **THEN** the transcript shows an error turn naming that code and message, and earlier turns are unchanged

#### Scenario: Failure after partial output
- **WHEN** the connection drops after some text has rendered
- **THEN** the rendered text is kept and an error indication is appended to the same turn

#### Scenario: The panel stays usable after a failure
- **WHEN** any run fails
- **THEN** the composer is re-enabled and the next message is sent with the full history including the failed turn's partial text

### Requirement: History persists locally under a versioned, capped key
The client SHALL persist the message history to `localStorage` under a key carrying an explicit schema version. On load, a stored thread whose version does not match the current one SHALL be discarded rather than parsed, as SHALL a thread that fails to parse or does not match the expected shape. The client SHALL cap what it stores by both a turn count and a total byte size, dropping the oldest turns first, and SHALL persist messages only — `iri_context` and any value derived from a slice SHALL never be written to storage. The client SHALL expose an explicit action to clear the conversation, which SHALL remove both the in-memory transcript and the stored thread. A storage write that fails SHALL NOT break the panel.

#### Scenario: Thread is restored on reload
- **WHEN** the user reloads the page after a conversation
- **THEN** the panel restores the prior transcript

#### Scenario: Stale schema is dropped, not crashed on
- **WHEN** stored data written under an earlier version key is present
- **THEN** the client starts an empty conversation and the panel renders normally

#### Scenario: Context is never written to storage
- **WHEN** a conversation has carried context on every turn
- **THEN** the stored payload contains no slice keys and no slice values

#### Scenario: Cap prevents unbounded growth
- **WHEN** the conversation exceeds the configured turn or byte cap
- **THEN** the oldest turns are dropped from what is stored and the stored payload stays under the cap

#### Scenario: Clear removes both copies
- **WHEN** the user activates "Clear conversation"
- **THEN** the transcript empties and the stored thread is removed

#### Scenario: Storage failure is non-fatal
- **WHEN** a `localStorage` write throws, for example because the quota is exhausted
- **THEN** the panel continues to function for the rest of the session

### Requirement: A server-side proxy keeps the gateway key out of the browser
The package SHALL export a factory that, given a gateway URL and an API key, returns a handler with the signature `(Request) => Promise<Response>`. The handler SHALL forward the request body to the gateway's `/v1/chat/completions`, attach the API key as a bearer credential server-side, and stream the SSE response back to the caller without buffering it. It SHALL propagate the gateway's status code and error body verbatim on failure, and SHALL propagate caller disconnection so an aborted browser request aborts the upstream run. The client SHALL never be configured with the gateway API key, and the browser SHALL address the host application's own route rather than the gateway.

#### Scenario: Key never reaches the browser
- **WHEN** the panel sends a message through a mounted proxy route
- **THEN** the browser request carries no gateway API key and targets the host application's origin

#### Scenario: Stream passes through unbuffered
- **WHEN** the gateway emits SSE chunks over several seconds
- **THEN** the browser receives each chunk as it is produced rather than a single response at the end

#### Scenario: Gateway errors are passed through
- **WHEN** the gateway returns `400` with `code: "invalid_context"`
- **THEN** the proxy responds with the same status and body

#### Scenario: Abort propagates upstream
- **WHEN** the browser aborts the request mid-stream
- **THEN** the proxy aborts its upstream request to the gateway

#### Scenario: Handler is framework-agnostic
- **WHEN** the handler is invoked directly with a `Request` object in a test, with no framework present
- **THEN** it returns a `Response`, and the same handler value is usable as a Next.js App Router route export

### Requirement: The panel presents an edge-pinned entry point and a slide-out surface
The package SHALL provide a panel component rendering a control pinned to the vertical middle of the right viewport edge, labelled "Ask AI", which opens a chat surface containing a transcript, a composer, a cancel affordance while a run is in flight, and a "Clear conversation" action. The control SHALL be a real button, the open surface SHALL be dismissible by keyboard, focus SHALL move into the surface on open and return to the control on close, and the panel SHALL honor `prefers-reduced-motion`. The panel SHALL be optional: the host SHALL be able to build its own surface from the exported hooks without importing the panel or its stylesheet.

#### Scenario: Opening and closing
- **WHEN** the user activates the "Ask AI" control
- **THEN** the chat surface opens, focus moves into it, and dismissing it returns focus to the control

#### Scenario: Keyboard reachable
- **WHEN** the user navigates with the keyboard alone
- **THEN** the control, composer, send, cancel, and clear actions are all reachable and operable

#### Scenario: Reduced motion honored
- **WHEN** the user's system requests reduced motion
- **THEN** the surface appears without a slide transition

#### Scenario: Hooks work without the panel
- **WHEN** a host imports only the provider and hooks
- **THEN** it can send messages, read streaming state, cancel, and clear without the panel component or its stylesheet being loaded

#### Scenario: Assistant text is rendered as plain text
- **WHEN** an assistant reply contains markdown syntax, HTML tags, or both
- **THEN** the transcript displays the characters literally with whitespace preserved, and no markup is interpreted or inserted into the document

### Requirement: The panel is mountable without React
The package SHALL expose a framework-agnostic mount function that renders the same panel into a supplied element from a chat instance, and SHALL expose it as browser-loadable ES modules requiring no bundler, transpiler, or import map. The React panel component SHALL be a wrapper over that same implementation rather than a second one, so the two cannot diverge. Unmounting SHALL remove the panel's DOM and release its subscriptions.

#### Scenario: Vanilla host renders the real panel
- **WHEN** a page with no framework and no build step imports the module over plain ESM and calls the mount function
- **THEN** the same panel renders, streams, cancels, and clears as it does under React

#### Scenario: One implementation, not two
- **WHEN** the React panel component renders
- **THEN** it delegates to the framework-agnostic mount rather than reimplementing the panel's DOM

#### Scenario: Unmount is clean
- **WHEN** the mounted panel is unmounted
- **THEN** its DOM is removed and it no longer reacts to chat state changes

### Requirement: The panel is styled self-containedly and themed by custom properties
The panel's styles SHALL ship as a single importable stylesheet that requires no build tooling, utility framework, or design system in the host. Every visual value the panel uses SHALL be expressed as a namespaced CSS custom property with a default matching the Iriguchi design language, so a host overrides appearance by redefining properties rather than by overriding selectors. The panel's selectors SHALL be namespaced so they match no host element, and the stylesheet SHALL define no global element or reset rules.

#### Scenario: Works in a host with no CSS framework
- **WHEN** the stylesheet is imported into an application that uses neither Tailwind nor any design system
- **THEN** the panel renders as designed

#### Scenario: Theming without selector overrides
- **WHEN** a host redefines the panel's accent and surface custom properties
- **THEN** the panel adopts them with no change to the stylesheet and no `!important`

#### Scenario: No leakage into the host
- **WHEN** the stylesheet is loaded on a page with its own buttons, inputs, and headings
- **THEN** no host element's computed style changes

### Requirement: The registration API reserves room for client-executed actions
The client's registration surface SHALL be typed so that a future capability in which the model invokes a host-executed action can be added without changing the signature or semantics of context slice registration. In this change no action registration SHALL be exposed to consumers and no action SHALL be advertised to the gateway; the request the client sends SHALL be indistinguishable from one produced by a client that has no notion of actions.

#### Scenario: Read-only wire format
- **WHEN** any message is sent by this client
- **THEN** the request body carries only fields the gateway's existing contract defines, and nothing describing client-executed actions

#### Scenario: Context registration is stable
- **WHEN** a later change introduces action registration
- **THEN** existing calls that register context slices compile and behave unchanged

### Requirement: The bundled example app demonstrates the client
`examples/weather-app` SHALL use this package rather than its own chat implementation: its server SHALL mount the proxy and SHALL hold the gateway API key, its page SHALL address its own origin, and no gateway credential SHALL be entered in or held by the browser. The example's screen state SHALL be supplied as named context slices, with at least one scalar slice and at least one payload slice, so both context tiers are visible in the demo. The example SHALL remain buildless and free of any framework, and its manifest, tool endpoints, `when` clause, and agent prompt SHALL be unchanged by this change.

#### Scenario: No credential in the browser
- **WHEN** the example's page is loaded and a message is sent
- **THEN** the page offers no API key input, sends no gateway credential, and posts to the example's own server

#### Scenario: Both context tiers are exercised
- **WHEN** the user is viewing a city and sends a message
- **THEN** the request carries the route and city as scalar slices and the multi-day forecast as a payload slice the agent reads only through `get_context`

#### Scenario: The screen-scoped tool still appears
- **WHEN** the user is on a city screen
- **THEN** the `when`-scoped `save_location` tool is exposed exactly as it was before this change, and it is absent on the home screen

#### Scenario: The example still runs with no build step
- **WHEN** the example is started per its README
- **THEN** it serves and functions without any bundler or transpiler running against the example itself

### Requirement: Adoption is documented end to end
The repository SHALL carry a guide covering installation from a git reference and by local path link, mounting the proxy route in a Next.js App Router application and in at least one other server framework, wrapping the application in the provider, registering context slices, and using or replacing the panel. The guide SHALL state explicitly that context is re-derived per turn, so the model retains what earlier turns told it as text but cannot read context for a page the user has navigated away from. `docs/app-integration.md` SHALL link to it from its client-context section.

#### Scenario: A new consumer can adopt without reading the source
- **WHEN** a developer follows the guide in a fresh Next.js 15 App Router application
- **THEN** they reach a working panel having read only the guide

#### Scenario: The navigation limitation is stated
- **WHEN** a developer reads the guide
- **THEN** it states that `get_context` can only reach the current page's context, and that this is intended
