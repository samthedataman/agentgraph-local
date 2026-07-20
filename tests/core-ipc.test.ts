import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentGraphConfig } from "../src/config/config.js";
import type { AgentGraphPaths } from "../src/config/paths.js";
import { createCoreDispatcher } from "../src/daemon/dispatcher.js";
import { startDaemonServer, type DaemonServer } from "../src/daemon/server.js";
import { rpc } from "../src/ipc/client.js";
import type { ProcessPresence } from "../src/protocol/types.js";
import { Store } from "../src/store/store.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

function testPaths(root: string): AgentGraphPaths {
  return {
    homeDir: root,
    runDir: join(root, "run"),
    socketPath: join(root, "run", "agentgraph.sock"),
    databasePath: join(root, "agentgraph.sqlite3"),
    pidPath: join(root, "run", "agentgraph.pid"),
    logDir: join(root, "logs"),
    spoolDir: join(root, "spool"),
    hookSpoolDir: join(root, "spool", "hooks"),
    configPath: join(root, "config.json")
  };
}

const config: AgentGraphConfig = {
  schemaVersion: 1,
  hostId: "host_ipc_test",
  heartbeatIntervalMs: 25,
  leaseDurationMs: 1_000,
  reconciliationIntervalMs: 1_000,
  recentProcessSeconds: 3_600
};

describe("Unix socket JSONL RPC", () => {
  it("serves health, presence, and event ingestion over a private socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentgraph-ipc-"));
    const paths = testPaths(root);
    const store = new Store(paths.databasePath, { hostId: config.hostId, leaseDurationMs: config.leaseDurationMs });
    const dispatcher = createCoreDispatcher(store, paths, config);
    let daemon: DaemonServer;
    try {
      daemon = await startDaemonServer({ paths, config, store, dispatcher });
    } catch (error) {
      // Some agent sandboxes prohibit even owner-only Unix-domain sockets.
      // Production uses this transport; keep storage cleanup deterministic when
      // the host test runner denies listen(2).
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        store.close();
        rmSync(root, { recursive: true, force: true });
        return;
      }
      throw error;
    }
    cleanup.push(async () => {
      await daemon.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });

    const health = await rpc<{ ok: boolean; liveProcesses: number }>("health", undefined, {
      socketPath: paths.socketPath
    });
    expect(health).toMatchObject({ ok: true, liveProcesses: 0 });

    const presence = await rpc<ProcessPresence>("process.register", {
      runId: "run_ipc",
      leaseToken: "lease-ipc",
      provider: "claude",
      pid: process.pid,
      processStartToken: "test-birth",
      executable: "claude",
      cwd: root
    }, { socketPath: paths.socketPath });
    expect(presence.provider).toBe("claude");

    const appended = await rpc<{ inserted: boolean }>("event.append", { event: {
      provider: "claude",
      source: "hook",
      run_id: "run_ipc",
      provider_session_id: "claude-session",
      kind: "session.started",
      payload: {},
      idempotency_key: "ipc-event"
    } }, { socketPath: paths.socketPath });
    expect(appended.inserted).toBe(true);

    const listed = await rpc<ProcessPresence[]>("process.list", {}, { socketPath: paths.socketPath });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.providerSessionId).toBe("claude-session");

    daemon.dispatcher.register("test.delayed", async () => {
      await delay(30);
      return { ok: true };
    });
    const abandoned = createConnection(paths.socketPath);
    await once(abandoned, "connect");
    abandoned.write(`${JSON.stringify({ jsonrpc: "1.0", id: "abandoned", method: "test.delayed" })}\n`);
    abandoned.destroy();
    await delay(60);
    await expect(rpc<{ ok: boolean }>("health", undefined, { socketPath: paths.socketPath }))
      .resolves.toMatchObject({ ok: true });
  });
});
