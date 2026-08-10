import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // node by default — core and server must run without a DOM. The panel and
    // React suites opt in per file with `@vitest-environment happy-dom`.
    environment: "node",
  },
});
