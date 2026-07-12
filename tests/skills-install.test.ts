import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installCoordinationSkill,
  skillInstallPath,
  uninstallCoordinationSkill
} from "../src/setup/skills.js";

async function sourceSkill(): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "agentgraph-skill-source-"));
  await writeFile(join(source, "SKILL.md"), "---\nname: coordinate-agentgraph\ndescription: Test\n---\n");
  return source;
}

describe("coordination skill setup", () => {
  it("installs and removes only an AgentGraph-owned skill", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentgraph-home-"));
    const sourceDirectory = await sourceSkill();
    const installed = await installCoordinationSkill({ provider: "codex", sourceDirectory, home });
    expect(installed).toMatchObject({ installed: true, skipped: false });
    await expect(readFile(join(installed.path, "SKILL.md"), "utf8")).resolves.toContain("coordinate-agentgraph");
    const removed = await uninstallCoordinationSkill({ provider: "codex", home });
    expect(removed.removed).toBe(true);
  });

  it("preserves an unrelated skill using the same directory name", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentgraph-home-"));
    const sourceDirectory = await sourceSkill();
    const path = skillInstallPath("claude", home);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "user-owned\n");
    const install = await installCoordinationSkill({ provider: "claude", sourceDirectory, home });
    expect(install).toMatchObject({ installed: false, skipped: true });
    const uninstall = await uninstallCoordinationSkill({ provider: "claude", home });
    expect(uninstall).toMatchObject({ removed: false, skipped: true });
    await expect(readFile(join(path, "SKILL.md"), "utf8")).resolves.toBe("user-owned\n");
  });
});
