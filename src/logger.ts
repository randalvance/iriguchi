export type LogLevel = "info" | "warn" | "error";

export type LogEvent = {
  event: string;
  level: LogLevel;
  ts: number;
  [key: string]: unknown;
};

export type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  with(extra: Record<string, unknown>): Logger;
};

type Sink = (e: LogEvent) => void;

const defaultSink: Sink = (e) => {
  process.stdout.write(JSON.stringify(e) + "\n");
};

export function createLogger(opts: { sink?: Sink; bound?: Record<string, unknown> } = {}): Logger {
  const sink = opts.sink || defaultSink;
  const bound = opts.bound || {};
  const emit = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    sink({ ...bound, ...fields, event, level, ts: Date.now() });
  };
  return {
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    with: (extra) => createLogger({ sink, bound: { ...bound, ...extra } }),
  };
}
