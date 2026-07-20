import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/store.js";

const stores: Store[] = [];

afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

function makeStore(leaseDurationMs = 15_000): Store {
  const store = new Store(":memory:", { hostId: "host_test", leaseDurationMs });
  stores.push(store);
  return store;
}

function registration() {
  return {
    runId: "run_test",
    leaseToken: "lease-secret",
    provider: "codex" as const,
    pid: process.pid,
    processStartToken: "birth-token",
    executable: "/usr/local/bin/codex",
    argv: ["--model", "test"],
    cwd: "/tmp/project",
    repositoryRoot: "/tmp/project",
    worktreeRoot: "/tmp/project",
    terminal: {
      tty: "/dev/ttys001",
      termProgram: "test",
      termSessionId: "term-session",
      itermSessionId: null,
      tmuxPane: null,
      parentPid: process.ppid
    }
  };
}

describe("core Store", () => {
  it("registers, authenticates, heartbeats, and exits a process lease", () => {
    const store = makeStore();
    const created = store.registerProcess(registration());
    expect(created.state).toBe("live");
    expect(created.confidence).toBe("supervised");
    expect(created.terminal?.tty).toBe("/dev/ttys001");
    expect(store.listProcesses()).toHaveLength(1);

    expect(() => store.heartbeat("run_test", "wrong")).toThrow("Invalid process lease");
    const heartbeat = store.heartbeat("run_test", "lease-secret", "using_tool");
    expect(heartbeat.activity).toBe("using_tool");

    const exited = store.markExited("run_test", "lease-secret", 0, null);
    expect(exited.state).toBe("exited");
    expect(store.listProcesses()).toHaveLength(0);
    expect(store.listProcesses({ includeExited: true })).toHaveLength(1);
  });

  it("deduplicates events and attaches native sessions to processes", () => {
    const store = makeStore();
    const processPresence = store.registerProcess(registration());
    const input = {
      provider: "codex" as const,
      source: "hook" as const,
      process_instance_id: processPresence.id,
      provider_session_id: "thr_native",
      kind: "session.started",
      payload: { model: "gpt-test" },
      idempotency_key: "hook:session:start"
    };
    const first = store.appendEvent(input);
    const duplicate = store.appendEvent(input);
    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.event.event_id).toBe(first.event.event_id);
    expect(store.listEvents()).toHaveLength(1);
    expect(store.getProcessById(processPresence.id)?.providerSessionId).toBe("thr_native");
    expect(store.getProcessById(processPresence.id)?.activity).toBe("idle");
  });

  it("accepts sparse forward-compatible envelopes", () => {
    const store = makeStore();
    const appended = store.appendEvent({
      provider: "future-agent",
      source: "stream",
      kind: "provider.unknown_event",
      payload: { extra: true },
      vendor_extension: { retainedInPayloadByNormalizer: false }
    });
    expect(appended.event.schema).toBe("local.agent.event/1");
    expect(appended.event.event_id).toMatch(/^evt_/);
    expect(appended.event.hop_count).toBe(0);
  });

  it("reconciles a SessionStart hook that arrives before wrapper registration", () => {
    const store = makeStore();
    store.appendEvent({
      provider: "codex",
      source: "hook",
      provider_session_id: "thr_early",
      kind: "session.started",
      payload: { agentgraph_run_id: "run_test" }
    });
    expect(store.listEvents()[0]?.process_instance_id).toBeNull();
    const presence = store.registerProcess(registration());
    expect(store.listEvents()[0]?.process_instance_id).toBe(presence.id);
    expect(store.getProcessById(presence.id)?.providerSessionId).toBe("thr_early");
  });

  it("searches historical sessions by prompt within repository scope", () => {
    const store = makeStore();
    store.appendEvent({
      provider: "codex",
      source: "hook",
      provider_session_id: "thr_legalvoice",
      occurred_at: "2026-07-15T20:00:00Z",
      kind: "turn.prompted",
      payload: {
        cwd: "/tmp/project",
        transcript_path: "/tmp/codex/thr_legalvoice.jsonl",
        prompt: "Simplify the LegalVoice web intake chat component without removing functionality"
      }
    });
    store.appendEvent({
      provider: "codex",
      source: "hook",
      provider_session_id: "thr_other",
      occurred_at: "2026-07-16T20:00:00Z",
      kind: "turn.prompted",
      payload: { cwd: "/tmp/other", prompt: "Unrelated newer session" }
    });

    expect(store.searchSessions({
      query: "LegalVoice web chat",
      repositoryRoot: "/tmp/project"
    })).toMatchObject([{
      sessionId: "thr_legalvoice",
      repositoryRoot: "/tmp/project",
      transcriptPath: "/tmp/codex/thr_legalvoice.jsonl"
    }]);
    expect(store.getSession("thr_legalvoice", { repositoryRoot: "/tmp/project" })).toMatchObject({
      title: "Simplify the LegalVoice web intake chat component without removing functionality",
      latestPrompt: "Simplify the LegalVoice web intake chat component without removing functionality"
    });
    expect(store.getSession("thr_legalvoice", { repositoryRoot: "/tmp/other" })).toBeNull();
  });
});
