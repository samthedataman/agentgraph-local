import { describe, expect, it } from "vitest";
import { preferProviderLeafProcesses, providerForCommand } from "../src/daemon/process-inspection.js";
import type { DiscoveredProcess } from "../src/protocol/types.js";

function processRecord(overrides: Partial<DiscoveredProcess>): DiscoveredProcess {
  return {
    pid: 100,
    parentPid: 1,
    provider: "codex",
    command: "node codex",
    cwd: "/repo",
    tty: "/dev/ttys001",
    processStartToken: "start",
    ...overrides
  };
}

describe("agent process discovery", () => {
  it("identifies only actual provider executables and launchers", () => {
    expect(providerForCommand("/vendor/bin/codex resume session-1")).toBe("codex");
    expect(providerForCommand("node /usr/local/bin/codex")).toBe("codex");
    expect(providerForCommand("node /usr/local/bin/claude --resume one")).toBe("claude");
    expect(providerForCommand("node /repo/agentgraph/dist/cli.js mcp --provider codex")).toBeNull();
    expect(providerForCommand("/vendor/bin/codex-code-mode-host")).toBeNull();
  });

  it("collapses a provider launcher while preserving separate terminals", () => {
    const launcher = processRecord({ pid: 100, parentPid: 1, command: "node codex" });
    const native = processRecord({ pid: 101, parentPid: 100, command: "/vendor/bin/codex" });
    const otherTerminal = processRecord({
      pid: 200,
      parentPid: 1,
      command: "/vendor/bin/codex",
      tty: "/dev/ttys002"
    });

    expect(preferProviderLeafProcesses([launcher, native, otherTerminal]).map((item) => item.pid))
      .toEqual([101, 200]);
  });
});
