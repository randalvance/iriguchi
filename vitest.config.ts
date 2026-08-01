import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Replaces bunfig.toml's [test] preload.
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    // Matches the previous `bun test --timeout 30000`.
    testTimeout: 30000,
    // bun test ran files sequentially in one process. Several suites bind
    // ephemeral ports and share IRI_TMP_DIR, so keep that behavior rather
    // than letting vitest parallelize files across workers.
    fileParallelism: false,
  },
});
