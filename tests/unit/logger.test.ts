import { describe, it, expect, mock, beforeEach } from "bun:test";
import { createLogger, type LogEvent } from "../../src/logger.ts";

function captureLogger() {
  const events: LogEvent[] = [];
  const sink = (e: LogEvent) => events.push(e);
  return { events, sink };
}

describe("logger", () => {
  it("emits JSON with event, level, timestamp", () => {
    const { events, sink } = captureLogger();
    const log = createLogger({ sink });
    log.info("request.start", { method: "POST", path: "/v1/chat/completions" });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("request.start");
    expect(events[0].level).toBe("info");
    expect(events[0].method).toBe("POST");
    expect(events[0].path).toBe("/v1/chat/completions");
    expect(typeof events[0].ts).toBe("number");
  });

  it("propagates bound fields via .with(...)", () => {
    const { events, sink } = captureLogger();
    const log = createLogger({ sink });
    const child = log.with({ request_id: "01H123" });
    child.info("agent.turn", { turn: 1 });
    expect(events[0].request_id).toBe("01H123");
    expect(events[0].turn).toBe(1);
    expect(events[0].event).toBe("agent.turn");
  });

  it("levels: info, warn, error", () => {
    const { events, sink } = captureLogger();
    const log = createLogger({ sink });
    log.info("a", {});
    log.warn("b", {});
    log.error("c", { err: "boom" });
    expect(events.map((e) => e.level)).toEqual(["info", "warn", "error"]);
  });

  it("default sink writes JSON line to stdout", () => {
    let captured = "";
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => {
      captured += s;
      return true;
    };
    try {
      const log = createLogger();
      log.info("test.evt", { x: 1 });
    } finally {
      (process.stdout as any).write = orig;
    }
    const line = captured.trim();
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe("test.evt");
    expect(parsed.x).toBe(1);
  });
});
