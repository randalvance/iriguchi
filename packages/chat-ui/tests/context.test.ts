import { describe, expect, it, vi } from "vitest";
import {
  buildContext,
  ContextTooLargeError,
  resolveSlices,
  serializedSize,
} from "../src/core/context.js";
import { SliceRegistry } from "../src/core/registry.js";
import type { SliceFailure, TruncationNotice } from "../src/core/types.js";
import { rejection } from "./helpers.js";

async function merge(
  registry: SliceRegistry,
  options: { maxBytes?: number; onTruncate?: (n: TruncationNotice) => void } = {},
) {
  return buildContext(await resolveSlices(registry), options);
}

describe("slice registry", () => {
  it("composes slices registered by unrelated components", async () => {
    const registry = new SliceRegistry();
    registry.register("account", () => ({ accountId: 42, balance: 1250.4 }));
    registry.register("visibleRows", () => [{ id: 1 }, { id: 2 }]);

    expect(await merge(registry)).toEqual({
      account: { accountId: 42, balance: 1250.4 },
      visibleRows: [{ id: 1 }, { id: 2 }],
    });
  });

  it("drops a slice once its component unmounts", async () => {
    const registry = new SliceRegistry();
    registry.register("route", () => "/accounts/42");
    const unregister = registry.register("visibleRows", () => [1, 2, 3]);

    unregister();

    expect(await merge(registry)).toEqual({ route: "/accounts/42" });
  });

  it("takes the most recent registration for a duplicate key and warns in development", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = new SliceRegistry();
    registry.register("rows", () => ["first"]);
    registry.register("rows", () => ["second"]);

    expect(await merge(registry)).toEqual({ rows: ["second"] });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("rows");
    warn.mockRestore();
  });

  it("does not let a stale unregister remove the newer registration", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = new SliceRegistry();
    const stale = registry.register("rows", () => ["first"]);
    registry.register("rows", () => ["second"]);

    stale();

    expect(await merge(registry)).toEqual({ rows: ["second"] });
    warn.mockRestore();
  });

  it("omits the envelope entirely when nothing is registered", async () => {
    expect(await merge(new SliceRegistry())).toBeUndefined();
  });
});

describe("slice resolution", () => {
  it("awaits async callbacks", async () => {
    const registry = new SliceRegistry();
    registry.register("summary", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { total: 7 };
    });

    expect(await merge(registry)).toEqual({ summary: { total: 7 } });
  });

  it("re-reads callbacks on every resolution rather than caching", async () => {
    const registry = new SliceRegistry();
    let route = "/accounts/1";
    registry.register("route", () => route);

    expect(await merge(registry)).toEqual({ route: "/accounts/1" });
    route = "/accounts/2";
    expect(await merge(registry)).toEqual({ route: "/accounts/2" });
  });

  it("omits a failing slice, reports it, and sends the rest", async () => {
    const registry = new SliceRegistry();
    registry.register("route", () => "/imports/preview");
    registry.register("broken", () => {
      throw new Error("state not ready");
    });
    registry.register("also-broken", () => Promise.reject(new Error("fetch failed")));

    const failures: SliceFailure[] = [];
    const context = buildContext(
      await resolveSlices(registry, { onFailure: (failure) => failures.push(failure) }),
    );

    expect(context).toEqual({ route: "/imports/preview" });
    expect(failures.map((failure) => failure.key).sort()).toEqual(["also-broken", "broken"]);
    expect(failures.every((failure) => failure.reason === "threw")).toBe(true);
  });

  it("drops a slice that never settles", async () => {
    const registry = new SliceRegistry();
    registry.register("route", () => "/");
    registry.register("hangs", () => new Promise(() => {}), { timeoutMs: 10 });

    const failures: SliceFailure[] = [];
    const context = buildContext(
      await resolveSlices(registry, { onFailure: (failure) => failures.push(failure) }),
    );

    expect(context).toEqual({ route: "/" });
    expect(failures[0]).toMatchObject({ key: "hangs", reason: "timeout" });
  });

  it("treats an unserializable value as that slice's failure, not the send's", async () => {
    const registry = new SliceRegistry();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    registry.register("route", () => "/");
    registry.register("cyclic", () => cyclic);

    const failures: SliceFailure[] = [];
    const context = buildContext(
      await resolveSlices(registry, { onFailure: (failure) => failures.push(failure) }),
    );

    expect(context).toEqual({ route: "/" });
    expect(failures[0]?.key).toBe("cyclic");
  });
});

describe("size enforcement", () => {
  const bigRows = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: i, description: "x".repeat(100) }));

  it("passes a context that fits through untouched", async () => {
    const registry = new SliceRegistry();
    registry.register("rows", () => bigRows(3));
    const context = await merge(registry, { maxBytes: 65536 });
    expect(Array.isArray(context?.["rows"])).toBe(true);
  });

  it("refuses to send an oversized context and names the largest slice", async () => {
    const registry = new SliceRegistry();
    registry.register("route", () => "/imports/preview");
    registry.register("rows", () => bigRows(200));

    const error = await rejection<ContextTooLargeError>(merge(registry, { maxBytes: 2048 }));

    expect(error).toBeInstanceOf(ContextTooLargeError);
    expect(error.largestSlice).toBe("rows");
    expect(error.limit).toBe(2048);
    expect(error.size).toBeGreaterThan(2048);
    expect(error.message).toContain("2048");
  });

  it("truncates an opted-in slice instead of failing, and says so in the payload", async () => {
    const registry = new SliceRegistry();
    registry.register("route", () => "/imports/preview");
    registry.register("rows", () => bigRows(200), { truncate: true });

    const notices: TruncationNotice[] = [];
    const context = await merge(registry, {
      maxBytes: 4096,
      onTruncate: (notice) => notices.push(notice),
    });

    expect(serializedSize(context)).toBeLessThanOrEqual(4096);
    expect(context?.["rows"]).toMatchObject({ truncated: true, total: 200 });
    expect(notices[0]).toMatchObject({ key: "rows", total: 200 });
    expect(notices[0]!.kept).toBeLessThan(200);
  });

  it("still fails when truncation cannot bring it under the limit", async () => {
    const registry = new SliceRegistry();
    registry.register("blob", () => "x".repeat(5000));
    registry.register("rows", () => bigRows(50), { truncate: true });

    await expect(merge(registry, { maxBytes: 1024 })).rejects.toThrowError(ContextTooLargeError);
  });

  it("does not truncate a slice that did not opt in", async () => {
    const registry = new SliceRegistry();
    registry.register("rows", () => bigRows(200));
    await expect(merge(registry, { maxBytes: 4096 })).rejects.toThrowError(ContextTooLargeError);
  });
});
