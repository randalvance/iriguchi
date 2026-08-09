import { describe, it, expect } from "vitest";
import {
  prefixToolName,
  splitExposedName,
  rejectExposedName,
  MAX_TOOL_NAME_LENGTH,
} from "../../src/agent/mcp/naming.ts";

describe("prefixToolName / splitExposedName", () => {
  it("prefixes with the server name", () => {
    expect(prefixToolName("finance", "list_accounts")).toBe("finance__list_accounts");
  });

  it("round-trips a tool name that itself contains underscores", () => {
    const exposed = prefixToolName("finance", "get_account_balance");
    expect(splitExposedName(exposed)).toEqual({
      serverName: "finance",
      toolName: "get_account_balance",
    });
  });

  it("round-trips a tool name containing a double underscore", () => {
    // Splitting on the FIRST separator is what makes this unambiguous.
    const exposed = prefixToolName("finance", "weird__tool");
    expect(splitExposedName(exposed)).toEqual({
      serverName: "finance",
      toolName: "weird__tool",
    });
  });

  it("round-trips a hyphenated server name", () => {
    const exposed = prefixToolName("finance-mcp", "list_tags");
    expect(splitExposedName(exposed)).toEqual({
      serverName: "finance-mcp",
      toolName: "list_tags",
    });
  });

  it("returns null for a name with no separator", () => {
    expect(splitExposedName("list_accounts")).toBeNull();
  });

  it("returns null when the separator leads or the tool part is empty", () => {
    expect(splitExposedName("__list_accounts")).toBeNull();
    expect(splitExposedName("finance__")).toBeNull();
  });
});

describe("rejectExposedName", () => {
  const none = new Set<string>();

  it("accepts a well-formed, unclaimed name", () => {
    expect(rejectExposedName("finance__list_accounts", none)).toBeNull();
  });

  it("rejects a name longer than the tool-name limit", () => {
    const long = `finance__${"a".repeat(MAX_TOOL_NAME_LENGTH)}`;
    expect(rejectExposedName(long, none)).toBe("too_long");
  });

  it("accepts a name exactly at the limit", () => {
    const exact = "a".repeat(MAX_TOOL_NAME_LENGTH);
    expect(rejectExposedName(exact, none)).toBeNull();
  });

  it("rejects characters outside the allowed set", () => {
    expect(rejectExposedName("finance__list accounts", none)).toBe("invalid_characters");
    expect(rejectExposedName("finance__list.accounts", none)).toBe("invalid_characters");
  });

  it("rejects a name already claimed on the same agent", () => {
    const taken = new Set(["finance__list_accounts"]);
    expect(rejectExposedName("finance__list_accounts", taken)).toBe("collision");
  });

  it("reports length before characters when both are wrong", () => {
    const long = `finance__${"a b".repeat(30)}`;
    expect(rejectExposedName(long, none)).toBe("too_long");
  });
});
