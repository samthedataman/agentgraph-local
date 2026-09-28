import { afterEach, describe, expect, it } from "vitest";
import { eventFromParams, resolveHookHost, type HostInspector } from "../src/daemon/dispatcher.js";
import { reconcileLeases } from "../src/daemon/reconciler.js";
import { isMultiSessionHost } from "../src/daemon/process-inspection.js";
import { normalizeCodexHook } from "../src/hooks/normalize.js";
import { MemoryDomain } from "../src/memory/domain.js";
import { asDatabase } from "../src/memory/database.js";
import { launchAgentNode } from "../src/setup/doctor.js";
import { Store } from "../src/store/store.js";

const stores: Store[] = [];

afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

function makeStore(): Store {
  const store = new Store(":memory:", { hostId: "host_desktop" });
  stores.push(store);
  return store;
}

const APP_SERVER = "/Applications/ChatGPT.app/Contents/Resources/codex -c features.x=true app-server --analytics-default-enabled";
const CLAUDE_DESKTOP = "/Users/me/Library/Application Support/Claude/claude-code/2.1.281/claude.app/Contents/MacOS/claude --output-format stream-json";

function inspector(commands: Record<number, string>): HostInspector {
  return {
    startToken: (pid) => (commands[pid] ? `ps_${pid}` : null),
    command: (pid) => commands[pid] ?? null
  };
}

function prompt(sessionId: string, cwd: string, text: string, occurredAt: string, processId?: string) {
  return {
    provider: "codex" as const,
    source: "hook" as const,
    provider_session_id: sessionId,
    kind: "turn.prompted",
    occurred_at: occurredAt,
    ...(processId ? { process_instance_id: processId } : {}),
    payload: { cwd, prompt: text, transcript_path: `/tmp/${sessionId}.jsonl` }
  };
}

describe("desktop app presence", () => {
  it("recognizes app servers as multi-session hosts", () => {
    expect(isMultiSessionHost(APP_SERVER)).toBe(true);
    expect(isMultiSessionHost("/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://")).toBe(true);
    expect(isMultiSessionHost(CLAUDE_DESKTOP)).toBe(false);
    expect(isMultiSessionHost("node /usr/local/lib/codex.js")).toBe(false);
  });

  it("attaches a TTY-less hook to its verified host process", () => {
    const store = makeStore();
    const host = resolveHookHost(store, "codex", 3503, "/repo", inspector({ 3503: APP_SERVER }));
    expect(host).toMatchObject({ pid: 3503, provider: "codex", mode: "attached", confidence: "hook_seen" });
    expect(host?.metadata).toMatchObject({ autoAttachedFromHook: true, multiSession: true });

    // The second lookup hits the store without inspecting the process again.
    const again = resolveHookHost(store, "codex", 3503, "/repo", inspector({}));
    expect(again?.id).toBe(host?.id);
  });

  it("refuses a host PID that is not the named provider", () => {
    const store = makeStore();
    expect(resolveHookHost(store, "codex", 77, "/repo", inspector({ 77: "/bin/zsh" }))).toBeNull();
    expect(resolveHookHost(store, "codex", 78, "/repo", inspector({}))).toBeNull();
    expect(resolveHookHost(store, "claude", 3503, "/repo", inspector({ 3503: APP_SERVER }))).toBeNull();
    expect(store.listProcesses()).toHaveLength(0);
  });

  it("keeps several sessions live on one app server with their own cwd and activity", () => {
    const store = makeStore();
    const host = resolveHookHost(store, "codex", 3503, "/repo-a", inspector({ 3503: APP_SERVER }))!;
    // An app server with no session is infrastructure, not an agent.
    expect(store.listProcesses()).toHaveLength(0);

    const now = new Date().toISOString();
    store.appendEvent(prompt("thr_a", "/repo-a", "Fix the intake form", now, host.id));
    store.appendEvent(prompt("thr_b", "/repo-b", "Audit the dialer", now, host.id));
    store.appendEvent({
      provider: "codex", source: "hook", provider_session_id: "thr_b", process_instance_id: host.id,
      kind: "tool.started", payload: { cwd: "/repo-b" }
    });

    const live = store.listProcesses({ provider: "codex" });
    expect(live.map((presence) => presence.providerSessionId).sort()).toEqual(["thr_a", "thr_b"]);
    const bySession = Object.fromEntries(live.map((presence) => [presence.providerSessionId, presence]));
    expect(bySession.thr_a).toMatchObject({ cwd: "/repo-a", activity: "thinking" });
    expect(bySession.thr_b).toMatchObject({ cwd: "/repo-b", activity: "using_tool" });

    // Ending one session leaves the other attached.
    store.appendEvent({
      provider: "codex", source: "hook", provider_session_id: "thr_a", process_instance_id: host.id,
      kind: "session.detached", payload: {}
    });
    expect(store.listProcesses().map((presence) => presence.providerSessionId)).toEqual(["thr_b"]);
  });

  it("drops idle hosted sessions but keeps single-session processes", () => {
    const store = makeStore();
    const host = resolveHookHost(store, "codex", 3503, "/repo", inspector({ 3503: APP_SERVER }))!;
    store.appendEvent(prompt("thr_idle", "/repo", "Old thread", new Date().toISOString(), host.id));
    store.database.prepare("UPDATE session_attachments SET last_event_at = '2000-01-01T00:00:00.000Z'").run();

    const result = reconcileLeases(store, new Date().toISOString(), () => true);
    expect(result.idleDetached).toBe(1);
    expect(store.listProcesses()).toHaveLength(0);
    // A new prompt brings the session back.
    store.appendEvent(prompt("thr_idle", "/repo", "Back again", new Date().toISOString(), host.id));
    expect(store.listProcesses().map((presence) => presence.providerSessionId)).toEqual(["thr_idle"]);
  });

  it("still switches sessions on a single-session process", () => {
    const store = makeStore();
    const claude = resolveHookHost(store, "claude", 1555, "/repo", inspector({ 1555: CLAUDE_DESKTOP }))!;
    expect(claude.metadata.multiSession).toBe(false);
    const now = new Date().toISOString();
    store.appendEvent({ ...prompt("s1", "/repo", "one", now, claude.id), provider: "claude" });
    store.appendEvent({ ...prompt("s2", "/repo", "two", now, claude.id), provider: "claude" });
    expect(store.listProcesses().map((presence) => presence.providerSessionId)).toEqual(["s2"]);
  });

  it("does not move an attached single-session process on a TTY-less guess", () => {
    const store = makeStore();
    const claude = resolveHookHost(store, "claude", 1555, "/tmp/shared", inspector({ 1555: CLAUDE_DESKTOP }))!;
    store.appendEvent({ ...prompt("owner", "/tmp/shared", "mine", new Date().toISOString(), claude.id), provider: "claude" });

    const stranger = eventFromParams({
      event: {
        provider: "claude",
        source: "hook",
        provider_session_id: "other-window",
        kind: "tool.started",
        payload: { cwd: "/tmp/shared", agentgraph_hook_tty: null }
      }
    }, store);
    expect(stranger.process_instance_id).toBeUndefined();
  });

  it("reports sessions that have events but no live presence", () => {
    const store = makeStore();
    store.appendEvent(prompt("thr_orphan", "/repo", "Nobody attached me", new Date().toISOString()));
    const gaps = store.presenceGaps(new Date(Date.now() - 60_000).toISOString());
    expect(gaps).toMatchObject([{ provider: "codex", sessionId: "thr_orphan", cwd: "/repo" }]);

    const host = resolveHookHost(store, "codex", 3503, "/repo", inspector({ 3503: APP_SERVER }))!;
    store.appendEvent(prompt("thr_orphan", "/repo", "Now attached", new Date().toISOString(), host.id));
    expect(store.presenceGaps(new Date(Date.now() - 60_000).toISOString())).toEqual([]);
  });
});

describe("session digests", () => {
  it("keeps the human objective when scheduled automation prompts arrive", () => {
    const store = makeStore();
    store.appendEvent(prompt("thr_watch", "/repo", [
      "<in-app-browser-context source=\"ambient-ui-state\">tab state</in-app-browser-context>",
      "# Files mentioned by the user:",
      "## My request: watch the other sessions overnight"
    ].join("\n"), "2026-09-28T10:00:00.000Z"));
    store.appendEvent(prompt(
      "thr_watch", "/repo",
      "<heartbeat>\n<automation_id>watch</automation_id>\nContinue supervision</heartbeat>",
      "2026-09-28T10:05:00.000Z"
    ));
    store.appendEvent({
      provider: "codex", source: "hook", provider_session_id: "thr_watch", kind: "turn.completed",
      occurred_at: "2026-09-28T10:06:00.000Z", payload: { last_assistant_message: "Elevare deploy still pending." }
    });

    const session = store.getSession("thr_watch", { repositoryRoot: "/repo" });
    expect(session).toMatchObject({
      objective: "watch the other sessions overnight",
      latestPrompt: "watch the other sessions overnight",
      latestAssistantMessage: "Elevare deploy still pending.",
      promptCount: 1,
      automatedPromptCount: 1,
      title: "watch the other sessions overnight",
      transcriptPath: "/tmp/thr_watch.jsonl"
    });
  });

  it("searches digests, honours scope and exclusion, and lists recent sessions for a match-all query", () => {
    const store = makeStore();
    store.appendEvent(prompt("thr_old", "/repo/app", "Repair the number porting flow", "2026-09-01T00:00:00.000Z"));
    store.appendEvent(prompt("thr_new", "/repo", "Draft the Stanley report", "2026-09-02T00:00:00.000Z"));
    store.appendEvent(prompt("thr_elsewhere", "/other", "Repair the porting flow elsewhere", "2026-09-03T00:00:00.000Z"));

    expect(store.searchSessions({ query: "porting", repositoryRoot: "/repo" }).map((s) => s.sessionId))
      .toEqual(["thr_old"]);
    expect(store.searchSessions({ query: "*", repositoryRoot: "/repo" }).map((s) => s.sessionId))
      .toEqual(["thr_new", "thr_old"]);
    expect(store.searchSessions({ query: "*", repositoryRoot: "/repo", excludeSessionId: "thr_new" })
      .map((s) => s.sessionId)).toEqual(["thr_old"]);
    expect(store.searchSessions({ query: "porting", repositoryRoot: "/repo" })[0]?.matchSnippets)
      .toEqual(["Repair the number porting flow"]);
  });

  it("redacts pasted keys, including markdown-escaped ones, from digests", () => {
    const store = makeStore();
    const fakeKey = "apikey\\_0123456789abcdef0123\\_fedcba9876543210fedcba";
    store.appendEvent(prompt("thr_key", "/repo", `${fakeKey} add this key to the environment`, "2026-09-01T00:00:00.000Z"));
    const session = store.getSession("thr_key", { repositoryRoot: "/repo" });
    expect(session?.objective).toBe("[REDACTED] add this key to the environment");
    expect(JSON.stringify(store.searchSessions({ query: "environment", repositoryRoot: "/repo" })))
      .not.toContain("0123456789abcdef");
  });

  it("rebuilds digests from the event log", () => {
    const store = makeStore();
    store.appendEvent(prompt("thr_rebuild", "/repo", "First request", "2026-09-01T00:00:00.000Z"));
    store.appendEvent(prompt("thr_rebuild", "/repo", "Second request", "2026-09-01T01:00:00.000Z"));
    const before = store.getSession("thr_rebuild", { repositoryRoot: "/repo" });
    store.database.prepare("DELETE FROM session_digests").run();

    expect(store.rebuildSessionDigests()).toBe(2);
    expect(store.getSession("thr_rebuild", { repositoryRoot: "/repo" })).toEqual(before);
  });

  it("gives context packs a derived snapshot when none was published", () => {
    const store = makeStore();
    store.appendEvent(prompt("thr_ctx", "/repo", "Wire the Clio Grow sync", "2026-09-01T00:00:00.000Z"));
    const domain = new MemoryDomain(asDatabase(store.database));
    expect(domain.snapshots.get("thr_ctx")).toMatchObject({
      sessionId: "thr_ctx",
      scope: { kind: "repository", key: "/repo" },
      objective: "Wire the Clio Grow sync",
      metadata: { derived: true, provider: "codex", promptCount: 1 }
    });

    domain.upsertSnapshot({
      sessionId: "thr_ctx",
      scope: { kind: "repository", key: "/repo" },
      objective: "Published objective"
    });
    expect(domain.snapshots.get("thr_ctx")?.objective).toBe("Published objective");
  });
});

describe("hook payload bounds", () => {
  it("caps tool output far below prompt text and records the host PID", () => {
    const huge = "x".repeat(20_000);
    const tool = normalizeCodexHook(
      { hook_event_name: "PostToolUse", session_id: "thr", tool_response: huge },
      { env: {}, tty: null, hostPid: null }
    );
    expect(String(tool.payload.tool_response).length).toBeLessThan(4_200);

    const turn = normalizeCodexHook(
      { hook_event_name: "UserPromptSubmit", session_id: "thr", prompt: huge },
      { env: {}, tty: null, hostPid: 3503 }
    );
    expect(String(turn.payload.prompt)).toHaveLength(20_000);
    expect(turn.payload.agentgraph_host_pid).toBe(3503);
  });
});

describe("doctor runtime", () => {
  it("reads the Node binary pinned in the LaunchAgent", () => {
    const plist = `<key>ProgramArguments</key>
  <array>
    <string>/Users/me/.nvm/versions/node/v22.12.0/bin/node</string>
    <string>/opt/agentgraph/dist/cli.js</string>
  </array>`;
    expect(launchAgentNode(plist)).toBe("/Users/me/.nvm/versions/node/v22.12.0/bin/node");
    expect(launchAgentNode("<plist/>")).toBeNull();
  });
});
