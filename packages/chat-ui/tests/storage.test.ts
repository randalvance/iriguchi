import { describe, expect, it } from "vitest";
import {
  capMessages,
  clearThread,
  loadThread,
  saveThread,
  storageKey,
  STORAGE_VERSION,
} from "../src/core/storage.js";
import type { ChatMessage } from "../src/core/types.js";
import { memoryStorage } from "./helpers.js";

const AGENT = "weather-bot";
const thread: ChatMessage[] = [
  { role: "user", content: "what's the weather here?", status: "complete" },
  { role: "assistant", content: "Sunny, 72°F.", status: "complete" },
];

describe("conversation storage", () => {
  it("round-trips a thread", () => {
    const storage = memoryStorage();
    saveThread(AGENT, thread, storage);

    expect(loadThread(AGENT, storage)).toEqual([
      { role: "user", content: "what's the weather here?" },
      { role: "assistant", content: "Sunny, 72°F." },
    ]);
  });

  it("namespaces the key by version and agent", () => {
    expect(storageKey(AGENT)).toBe(`iriguchi.chat.v${STORAGE_VERSION}.${AGENT}`);
  });

  it("discards a thread written under an older version", () => {
    const storage = memoryStorage({
      [storageKey(AGENT)]: JSON.stringify({ v: STORAGE_VERSION - 1, messages: thread }),
    });
    expect(loadThread(AGENT, storage)).toEqual([]);
  });

  it("discards an unparseable or wrongly shaped payload", () => {
    expect(loadThread(AGENT, memoryStorage({ [storageKey(AGENT)]: "{not json" }))).toEqual([]);
    expect(
      loadThread(
        AGENT,
        memoryStorage({
          [storageKey(AGENT)]: JSON.stringify({ v: STORAGE_VERSION, messages: [{ role: "user" }] }),
        }),
      ),
    ).toEqual([]);
  });

  it("writes messages only — never context or a slice value", () => {
    const storage = memoryStorage();
    saveThread(AGENT, thread, storage);

    const raw = storage.getItem(storageKey(AGENT)) ?? "";
    expect(raw).not.toContain("iri_context");
    expect(raw).not.toContain("forecast");
    expect(JSON.parse(raw)).toEqual({
      v: STORAGE_VERSION,
      messages: [
        { role: "user", content: "what's the weather here?" },
        { role: "assistant", content: "Sunny, 72°F." },
      ],
    });
  });

  it("caps by message count, dropping the oldest", () => {
    const many: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
    }));

    const kept = capMessages(many, { maxMessages: 10 });
    expect(kept).toHaveLength(10);
    expect(kept[0]?.content).toBe("m50");
  });

  it("caps by byte size even when the count is small", () => {
    const heavy: ChatMessage[] = Array.from({ length: 5 }, () => ({
      role: "assistant",
      content: "x".repeat(1000),
    }));

    const kept = capMessages(heavy, { maxMessages: 40, maxBytes: 2500 });
    expect(kept.length).toBeLessThan(5);
    expect(new TextEncoder().encode(JSON.stringify({ v: STORAGE_VERSION, messages: kept })).length)
      .toBeLessThanOrEqual(2500);
  });

  it("survives a storage that throws on write", () => {
    const hostile = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };

    expect(() => saveThread(AGENT, thread, hostile)).not.toThrow();
  });

  it("survives a storage that throws on read", () => {
    const hostile = {
      getItem: () => {
        throw new Error("access denied");
      },
      setItem: () => {},
      removeItem: () => {},
    };

    expect(loadThread(AGENT, hostile)).toEqual([]);
  });

  it("is a no-op when there is no storage at all", () => {
    expect(loadThread(AGENT, null)).toEqual([]);
    expect(() => saveThread(AGENT, thread, null)).not.toThrow();
    expect(() => clearThread(AGENT, null)).not.toThrow();
  });

  it("removes the stored thread on clear", () => {
    const storage = memoryStorage();
    saveThread(AGENT, thread, storage);
    clearThread(AGENT, storage);

    expect(storage.getItem(storageKey(AGENT))).toBeNull();
  });
});
