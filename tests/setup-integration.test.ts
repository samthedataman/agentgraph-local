import { chmod, mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installLaunchAgent, renderLaunchAgent, uninstallLaunchAgent } from "../src/setup/launchd.js";
import { installMcpServer, uninstallMcpServer } from "../src/setup/mcp.js";
import type { CommandRunner } from "../src/setup/process.js";
import { installTransparentShim, SHIM_MARKER, uninstallTransparentShim } from "../src/setup/shims.js";

describe("transparent shims", () => {
  it("captures the absolute real binary and never recurses through itself", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentgraph-home-"));
    const realBin = join(home, "real-bin");
    const shimDir = join(home, "shim-bin");
    await mkdir(realBin, { recursive: true });
    const vendor = join(realBin, "codex");
    await writeFile(vendor, "#!/bin/sh\nexit 0\n");
    await chmod(vendor, 0o755);
    const result = await installTransparentShim({
      provider: "codex",
      nodePath: "/usr/bin/node",
      cliPath: "/package/dist/cli.js",
      home,
      shimDir,
      env: { HOME: home, PATH: `${shimDir}:${realBin}` }
    });
    expect(result.installed).toBe(true);
    const resolvedVendor = await realpath(vendor);
    expect(result.vendorPath).toBe(resolvedVendor);
    const content = await readFile(join(shimDir, "codex"), "utf8");
    expect(content).toContain(SHIM_MARKER);
    expect(content).toContain(`-- '${resolvedVendor}' "$@"`);

    const removed = await uninstallTransparentShim({ provider: "codex", home, shimDir });
    expect(removed.removed).toBe(true);
    await expect(readFile(join(shimDir, "codex"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite or remove an unrelated executable", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentgraph-home-"));
    const shimDir = join(home, "bin");
    await mkdir(shimDir, { recursive: true });
    const path = join(shimDir, "claude");
    await writeFile(path, "#!/bin/sh\necho mine\n");
    await chmod(path, 0o755);
    const install = await installTransparentShim({
      provider: "claude",
      nodePath: "/node",
      cliPath: "/cli",
      vendorPath: "/real/claude",
      home,
      shimDir
    });
    expect(install.skipped).toBe(true);
    const uninstall = await uninstallTransparentShim({ provider: "claude", home, shimDir });
    expect(uninstall.skipped).toBe(true);
    await expect(readFile(path, "utf8")).resolves.toContain("echo mine");
  });
});

describe("MCP setup", () => {
  it("adds once and leaves an existing named registration untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentgraph-home-"));
    const calls: string[][] = [];
    let present = false;
    const runner: CommandRunner = async (_executable, args) => {
      calls.push(args);
      if (args[1] === "get") {
        return {
          code: present ? 0 : 1,
          stdout: present ? "Command: /node\nArgs: /cli.js mcp --provider claude" : "",
          stderr: ""
        };
      }
      present = true;
      return { code: 0, stdout: "", stderr: "" };
    };
    const base = {
      provider: "claude" as const,
      nodePath: "/node",
      cliPath: "/cli.js",
      vendorPath: "/claude",
      runner,
      env: { HOME: home }
    };
    const first = await installMcpServer(base);
    const second = await installMcpServer(base);
    expect(first.installed).toBe(true);
    expect(first.changed).toBe(true);
    expect(second.installed).toBe(true);
    expect(second.changed).toBe(false);
    expect(calls.filter((args) => args[1] === "add")).toHaveLength(1);

    const removed = await uninstallMcpServer({
      provider: "claude",
      vendorPath: "/claude",
      runner,
      env: { HOME: home }
    });
    expect(removed.removed).toBe(true);
    expect(calls.at(-1)).toEqual(["mcp", "remove", "agentgraph", "--scope", "user"]);
  });

  it("preserves a pre-existing unowned MCP entry with the same name", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentgraph-home-"));
    const calls: string[][] = [];
    const runner: CommandRunner = async (_executable, args) => {
      calls.push(args);
      return { code: 0, stdout: "Command: /someone/else\nArgs: unrelated", stderr: "" };
    };
    const result = await installMcpServer({
      provider: "claude",
      nodePath: "/node",
      cliPath: "/cli.js",
      vendorPath: "/claude",
      runner,
      env: { HOME: home }
    });
    expect(result).toMatchObject({ installed: false, skipped: true, changed: false });
    const removed = await uninstallMcpServer({
      provider: "claude",
      vendorPath: "/claude",
      runner,
      env: { HOME: home }
    });
    expect(removed).toMatchObject({ removed: false, skipped: true });
    expect(calls.some((args) => args.includes("remove"))).toBe(false);
  });
});

describe("launchd setup", () => {
  it("plans without writing, installs, and removes only the owned plist", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentgraph-home-"));
    const path = join(home, "Library", "LaunchAgents", "com.agentgraph.daemon.plist");
    const calls: string[][] = [];
    const runner: CommandRunner = async (_executable, args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    const planned = await installLaunchAgent({
      nodePath: "/node",
      cliPath: "/cli.js",
      home,
      path,
      platform: "darwin",
      uid: 501,
      runner,
      dryRun: true
    });
    expect(planned.write?.changed).toBe(true);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toEqual([]);

    const installed = await installLaunchAgent({
      nodePath: "/node",
      cliPath: "/cli.js",
      home,
      path,
      platform: "darwin",
      uid: 501,
      runner
    });
    expect(installed.loaded).toBe(true);
    expect(await readFile(path, "utf8")).toContain("com.agentgraph.daemon");

    const removed = await uninstallLaunchAgent({ home, path, platform: "darwin", uid: 501, runner });
    expect(removed.removed).toBe(true);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("escapes plist values", () => {
    const plist = renderLaunchAgent({ nodePath: "/node", cliPath: "/a&b/cli.js", home: "/tmp/x<y" });
    expect(plist).toContain("/a&amp;b/cli.js");
    expect(plist).toContain("/tmp/x&lt;y");
  });
});
