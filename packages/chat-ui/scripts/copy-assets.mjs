// tsc only emits what it compiles, and the stylesheet is shipped verbatim.
// Kept as a node script rather than `cp` so the build works on any platform.
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await mkdir(join(root, "dist"), { recursive: true });
await copyFile(join(root, "src", "styles.css"), join(root, "dist", "styles.css"));
