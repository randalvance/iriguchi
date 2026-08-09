/** The separator between an MCP server's name and one of its tool names. */
export const NAME_SEPARATOR = "__";

/**
 * Anthropic-style tool-name limit. A discovered tool whose prefixed form
 * exceeds this is dropped rather than truncated: truncation could silently
 * collapse two distinct tools onto one name.
 */
export const MAX_TOOL_NAME_LENGTH = 64;

const VALID_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/** `finance` + `list_accounts` -> `finance__list_accounts`. */
export function prefixToolName(serverName: string, toolName: string): string {
  return `${serverName}${NAME_SEPARATOR}${toolName}`;
}

/**
 * Recover the server name from an exposed name. Server names cannot contain
 * `_`, so the first `__` is unambiguously the separator even when the tool's
 * own name contains one.
 */
export function splitExposedName(
  exposed: string,
): { serverName: string; toolName: string } | null {
  const at = exposed.indexOf(NAME_SEPARATOR);
  if (at <= 0) return null;
  const toolName = exposed.slice(at + NAME_SEPARATOR.length);
  if (!toolName) return null;
  return { serverName: exposed.slice(0, at), toolName };
}

export type NameRejection = "too_long" | "invalid_characters" | "collision";

/**
 * Why a prefixed name cannot be exposed, or `null` if it can.
 *
 * `takenNames` is the set of names already claimed on the same agent — that is,
 * its `api_call` tool names plus anything already accepted from another server.
 */
export function rejectExposedName(
  exposed: string,
  takenNames: ReadonlySet<string>,
): NameRejection | null {
  if (exposed.length > MAX_TOOL_NAME_LENGTH) return "too_long";
  if (!VALID_TOOL_NAME.test(exposed)) return "invalid_characters";
  if (takenNames.has(exposed)) return "collision";
  return null;
}
