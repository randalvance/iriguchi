export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEvent = {
  event: string;
  level: LogLevel;
  ts: number;
  [key: string]: unknown;
};

export type Logger = {
  /**
   * Detail an operator only wants when diagnosing. Emitted like any other
   * level — the sink does no filtering — so it is a label on the record, not a
   * suppression mechanism.
   */
  debug(event: string, fields?: Record<string, unknown>): void;
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
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    with: (extra) => createLogger({ sink, bound: { ...bound, ...extra } }),
  };
}
