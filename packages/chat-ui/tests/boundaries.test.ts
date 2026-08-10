import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Comments are stripped before matching. These rules are about what the code
 * does, and a comment that happens to contain the word "window" is prose, not
 * a DOM access.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

async function sourcesUnder(dir: string): Promise<Array<{ path: string; text: string }>> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
  return Promise.all(
    files.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path, text: stripComments(await readFile(path, "utf8")) };
    }),
  );
}

/**
 * The subpath split is what lets a Node route handler import ./server without
 * resolving React, and what leaves room for a non-React binding. Convention
 * alone would not survive a hurried edit, so it is asserted.
 */
describe("import boundaries", () => {
  it("keeps React out of core", async () => {
    for (const file of await sourcesUnder(join(src, "core"))) {
      expect(file.text, `${file.path} imports react`).not.toMatch(/from\s+["']react/);
    }
  });

  it("keeps React and the DOM out of the server entry point", async () => {
    for (const file of await sourcesUnder(join(src, "server"))) {
      expect(file.text, `${file.path} imports react`).not.toMatch(/from\s+["']react/);
      expect(file.text, `${file.path} touches the DOM`).not.toMatch(
        /\b(document|window|localStorage)\b/,
      );
    }
  });

  it("keeps the DOM out of core except in the panel, which is the DOM", async () => {
    for (const file of await sourcesUnder(join(src, "core"))) {
      if (file.path.includes(join("core", "panel"))) continue;
      expect(file.text, `${file.path} touches document/window`).not.toMatch(
        /\b(document|window)\b/,
      );
    }
  });

  it("strips comments before judging a source", async () => {
    // Guards the guard: without this the rules above fail on prose.
    expect(stripComments('const a = 1; // mentions window\n/* and document */')).not.toMatch(
      /\b(document|window)\b/,
    );
    expect(stripComments('import x from "react";')).toMatch(/from\s+["']react/);
  });

  it("emits browser-loadable relative specifiers", async () => {
    // No bundler and no import map in the weather example, so every relative
    // import has to carry its extension.
    for (const file of await sourcesUnder(src)) {
      const relatives = [...file.text.matchAll(/from\s+["'](\.[^"']*)["']/g)].map((m) => m[1]!);
      for (const specifier of relatives) {
        expect(specifier, `${file.path} imports ${specifier}`).toMatch(/\.js$/);
      }
    }
  });
});
