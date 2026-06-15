import { mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Skill } from "../registry/schema.ts";

export async function materializeSkills(opts: {
  tmpDir: string;
  agentId: string;
  skills: Skill[];
}): Promise<string> {
  const cwd = join(opts.tmpDir, "agents", opts.agentId);
  const skillsRoot = join(cwd, ".claude", "skills");

  // Wipe any existing skills directory so removed skills don't linger.
  await rm(skillsRoot, { recursive: true, force: true });

  if (opts.skills.length === 0) {
    await mkdir(cwd, { recursive: true });
    return cwd;
  }

  await mkdir(skillsRoot, { recursive: true });

  for (const skill of opts.skills) {
    const dir = join(skillsRoot, skill.name);
    await mkdir(dir, { recursive: true });
    let content: string;
    if (skill.content !== undefined) {
      content = skill.content;
    } else if (skill.url) {
      const res = await fetch(skill.url);
      if (!res.ok) {
        throw new Error(`failed to fetch skill ${skill.name}: HTTP ${res.status}`);
      }
      content = await res.text();
    } else {
      throw new Error(`skill ${skill.name} has neither content nor url`);
    }
    await writeFile(join(dir, "SKILL.md"), content, "utf8");
  }

  return cwd;
}
