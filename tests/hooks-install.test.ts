import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  countInstalledAgentGraphHooks,
  installAgentGraphHooks,
  uninstallAgentGraphHooks
} from "../src/setup/hooks.js";

describe("safe hook config installation", () => {
  it("preserves an existing Claude global hook and every unrelated setting", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentgraph-home-"));
    const directory = join(home, ".claude");
    const path = join(directory, "settings.json");
    await mkdir(directory, { recursive: true });
    const existingHandler = {
      type: "command",
      command: "/existing/customer-hook --important",
      timeout: 99
    };
    await writeFile(path, JSON.stringify({
      theme: "dark",
      permissions: { allow: ["Read"] },
      hooks: {
        PostToolUse: [{ matcher: "Bash", hooks: [existingHandler] }]
      }
    }, null, 2));

    const first = await installAgentGraphHooks({
      provider: "claude",
      command: "AGENTGRAPH_HOOK=1 '/node' '/cli.js' hook claude",
      home,
      now: new Date("2026-07-12T12:00:00Z")
    });
    expect(first.changed).toBe(true);
    expect(first.added).toBe(CLAUDE_HOOK_EVENTS.length);
    expect(first.backupPath).toBeTruthy();
    const installed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(installed.theme).toBe("dark");
    expect(installed.permissions).toEqual({ allow: ["Read"] });
    const hooks = installed.hooks as Record<string, Array<{ hooks: unknown[] }>>;
    expect(hooks.PostToolUse?.[0]?.hooks).toContainEqual(existingHandler);
    expect(countInstalledAgentGraphHooks(installed, "claude")).toBe(CLAUDE_HOOK_EVENTS.length);

    const second = await installAgentGraphHooks({
      provider: "claude",
      command: "AGENTGRAPH_HOOK=1 '/node' '/cli.js' hook claude",
      home
    });
    expect(second.changed).toBe(false);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    const backups = (await readdir(directory)).filter((name) => name.includes("agentgraph-backup"));
    expect(backups).toHaveLength(1);
  });

  it("does not create anything during a dry run", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentgraph-home-"));
    const result = await installAgentGraphHooks({
      provider: "codex",
      command: "AGENTGRAPH_HOOK=1 '/node' '/cli.js' hook codex",
      home,
      dryRun: true
    });
    expect(result.changed).toBe(true);
    expect(result.added).toBe(CODEX_HOOK_EVENTS.length);
    await expect(readFile(join(home, ".codex", "hooks.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses invalid JSON without changing it", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentgraph-home-"));
    const directory = join(home, ".codex");
    const path = join(directory, "hooks.json");
    await mkdir(directory, { recursive: true });
    await writeFile(path, "{ not-json\n");
    await expect(installAgentGraphHooks({
      provider: "codex",
      command: "AGENTGRAPH_HOOK=1 '/node' '/cli.js' hook codex",
      home
    })).rejects.toThrow("Refusing to change invalid JSON");
    await expect(readFile(path, "utf8")).resolves.toBe("{ not-json\n");
  });

  it("uninstalls only AgentGraph handlers and preserves the existing Claude hook", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentgraph-home-"));
    const directory = join(home, ".claude");
    const path = join(directory, "settings.json");
    await mkdir(directory, { recursive: true });
    const existing = { type: "command", command: "/keep-this-hook" };
    await writeFile(path, JSON.stringify({
      important: true,
      hooks: { PostToolUse: [{ hooks: [existing] }] }
    }));
    await installAgentGraphHooks({
      provider: "claude",
      command: "AGENTGRAPH_HOOK=1 '/node' '/cli.js' hook claude",
      home
    });
    const result = await uninstallAgentGraphHooks({ provider: "claude", home });
    expect(result.removed).toBe(CLAUDE_HOOK_EVENTS.length);
    const final = JSON.parse(await readFile(path, "utf8")) as {
      important: boolean;
      hooks: { PostToolUse: Array<{ hooks: unknown[] }> };
    };
    expect(final.important).toBe(true);
    expect(final.hooks.PostToolUse[0]?.hooks).toEqual([existing]);
  });
});
