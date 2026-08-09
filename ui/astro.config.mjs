import { defineConfig } from "astro/config";

/**
 * Static output, served by the gateway at /ui.
 *
 * `output: "static"` is a design constraint, not a default. An SSR adapter
 * would put a second runtime inside the gateway process and hand the UI direct
 * access to the store — collapsing the client/server boundary this is supposed
 * to be a client across. Static keeps it honest: it can only see what
 * `/internal/*` exposes, which is also what makes that surface reviewable.
 *
 * `base` must match the path the gateway mounts, so emitted asset URLs resolve.
 */
export default defineConfig({
  output: "static",
  base: "/ui",
  build: { format: "directory" },
  // The gateway serves the built files; Astro's dev server is only ever used
  // standalone, where it proxies nothing and /internal is reached cross-origin.
  server: { port: 4321 },
  devToolbar: { enabled: false },
});
