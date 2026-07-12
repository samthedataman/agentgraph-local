import { afterEach, describe, expect, it } from "vitest";
import { reconcileLeases } from "../src/daemon/reconciler.js";
import { eventFromParams } from "../src/daemon/dispatcher.js";
import { Store } from "../src/store/store.js";

const stores: Store[] = [];

afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

describe("lease reconciliation", () => {
  it("distinguishes a live stale wrapper from an exited process", async () => {
    const store = new Store(":memory:", { hostId: "host_reconcile", leaseDurationMs: 1 });
    stores.push(store);
    const presence = store.registerProcess({
      runId: "run_reconcile",
      leaseToken: "lease",
      provider: "codex",
      pid: 4567,
      processStartToken: "birth-token",
      executable: process.execPath,
      cwd: process.cwd()
    });
    store.database.prepare("UPDATE process_instances SET lease_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", presence.id);
    const stale = reconcileLeases(store, new Date().toISOString(), () => true);
    expect(stale).toMatchObject({ checked: 1, stale: 1, exited: 0 });
    expect(store.getProcessById(presence.id)?.state).toBe("stale");

    const exited = reconcileLeases(store, new Date().toISOString(), () => false);
    expect(exited.exited).toBe(1);
    expect(store.getProcessById(presence.id)?.state).toBe("exited");
  });

  it("correlates a hook-only provider session to one unambiguous live process", () => {
    const store = new Store(":memory:", { hostId: "host_hook" });
    stores.push(store);
    const presence = store.registerProcess({
      runId: "run_attached",
      leaseToken: "lease",
      provider: "claude",
      mode: "attached",
      pid: 4568,
      processStartToken: "birth-token-2",
      executable: "claude",
      cwd: "/tmp/agentgraph-hook-test"
    }, { confidence: "heuristic" });
    const event = eventFromParams({
      event: {
        provider: "claude",
        source: "hook",
        provider_session_id: "claude:ordinary",
        kind: "session.started",
        payload: { cwd: "/tmp/agentgraph-hook-test" }
      }
    }, store);
    expect(event.process_instance_id).toBe(presence.id);
    store.appendEvent(event);
    expect(store.getProcessById(presence.id)?.providerSessionId).toBe("claude:ordinary");
  });
});
