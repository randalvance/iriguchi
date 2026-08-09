## ADDED Requirements

### Requirement: Manifest tools may declare a `when` clause, validated at registration
The manifest schema SHALL accept an optional `when` clause on both `api_call` and `mcp` tool entries. The clause SHALL be an object whose values are each a scalar, an array of scalars, `{ "prefix": <string> }`, or `{ "exists": <boolean> }`. Registration SHALL reject a manifest containing a malformed `when` clause — a non-object clause, an empty clause, an unrecognized matcher form, or an empty path key — with the existing atomic manifest-validation failure, so a matcher that could never match surfaces at registration rather than as a tool that silently never appears. A manifest with no `when` clauses SHALL validate exactly as it does today.

#### Scenario: Valid when clause accepted
- **WHEN** an app registers a manifest whose tool declares `when: { "route": { "prefix": "/accounts/" } }`
- **THEN** registration succeeds and the clause is persisted with the tool

#### Scenario: Malformed matcher rejected atomically
- **WHEN** a manifest declares `when: { "route": { "regex": "^/acc" } }`
- **THEN** registration fails validation, the whole manifest is rejected, and the app is not persisted

#### Scenario: Empty clause rejected
- **WHEN** a manifest declares `when: {}` on a tool
- **THEN** registration fails validation with a message naming the tool

#### Scenario: Existing manifests unaffected
- **WHEN** an app registers a manifest with no `when` clauses anywhere
- **THEN** validation and the accepted agent set are unchanged from before this capability existed

### Requirement: `get_context` is a reserved tool name
Registration SHALL reject a manifest declaring an `api_call` tool named `get_context` with `400`, `type: "invalid_request_error"`, and `code: "reserved_tool_name"`, naming the tool and the reason, because the gateway exposes its own tool under that name. `mcp` entries SHALL NOT be constrained by this reservation, since their tools reach the model prefixed by the server name and cannot collide.

#### Scenario: Reserved api_call name rejected
- **WHEN** a manifest declares an `api_call` tool named `get_context`
- **THEN** registration fails with `400` and `code: "reserved_tool_name"` and the app is not persisted

#### Scenario: Prefixed mcp tool of the same name is allowed
- **WHEN** an `mcp` server named `finance` advertises a tool called `get_context`
- **THEN** it is exposed as `finance__get_context` and does not collide with the gateway's tool
