import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeSkills } from "../../src/agent/skills.ts";

describe("materializeSkills", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "iri-skills-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates cwd at <root>/agents/<id> with no skills", async () => {
    const cwd = await materializeSkills({
      tmpDir: root,
      agentId: "weather-bot",
      skills: [],
    });
    expect(cwd).toBe(join(root, "agents", "weather-bot"));
    expect(await Bun.file(join(cwd, ".claude")).exists()).toBe(false);
  });

  it("writes inline skill to .claude/skills/<name>/SKILL.md", async () => {
    const cwd = await materializeSkills({
      tmpDir: root,
      agentId: "weather-bot",
      skills: [
        {
          name: "weather-jargon",
          content: "---\nname: weather-jargon\ndescription: x\n---\n\n# body",
        },
      ],
    });
    const path = join(cwd, ".claude", "skills", "weather-jargon", "SKILL.md");
    const body = await readFile(path, "utf8");
    expect(body).toContain("name: weather-jargon");
    expect(body).toContain("# body");
  });

  it("fetches url-based skill", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("---\nname: remote\ndescription: x\n---\n\nremote body"),
    });
    try {
      const cwd = await materializeSkills({
        tmpDir: root,
        agentId: "remote-bot",
        skills: [{ name: "remote", url: `http://localhost:${server.port}/skill.md` }],
      });
      const body = await readFile(
        join(cwd, ".claude", "skills", "remote", "SKILL.md"),
        "utf8",
      );
      expect(body).toContain("remote body");
    } finally {
      server.stop();
    }
  });

  it("removes stale skill directories on re-materialize", async () => {
    const cwd = await materializeSkills({
      tmpDir: root,
      agentId: "bot",
      skills: [{ name: "a", content: "---\nname: a\ndescription: x\n---\n\nA" }],
    });
    expect(await Bun.file(join(cwd, ".claude/skills/a/SKILL.md")).exists()).toBe(true);

    await materializeSkills({
      tmpDir: root,
      agentId: "bot",
      skills: [{ name: "b", content: "---\nname: b\ndescription: x\n---\n\nB" }],
    });
    expect(await Bun.file(join(cwd, ".claude/skills/a/SKILL.md")).exists()).toBe(false);
    expect(await Bun.file(join(cwd, ".claude/skills/b/SKILL.md")).exists()).toBe(true);
  });

  it("throws on fetch failure", async () => {
    await expect(
      materializeSkills({
        tmpDir: root,
        agentId: "bot",
        skills: [{ name: "x", url: "http://localhost:1/skill.md" }],
      }),
    ).rejects.toThrow();
  });
});
