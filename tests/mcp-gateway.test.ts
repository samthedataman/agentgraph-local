import { describe, expect, it, vi } from "vitest";
import { McpGateway, withActorIdentity, withIdentity, withSourceIdentity } from "../src/mcp/gateway.js";

describe("McpGateway", () => {
  it("maps presence and resolves inherited caller identity", async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === "process.list") {
        return [{ id: "proc_1", runId: "run_1", providerSessionId: "codex:session" }];
      }
      return [];
    });
    const gateway = new McpGateway(rpc, { runId: "run_1", sessionId: "codex:session" });
    expect(await gateway.whoAmI()).toMatchObject({
      confidence: "supervised",
      process: { id: "proc_1" }
    });
    expect(rpc).toHaveBeenCalledWith("process.list", { includeExited: false });
  });

  it("routes context and inbox requests through daemon RPC", async () => {
    const rpc = vi.fn(async (method: string, params?: unknown) => ({ method, params }));
    const gateway = new McpGateway(rpc, {
      sessionId: "claude:one",
      provider: "claude",
      repository: "/repo"
    });
    await gateway.contextPack({ scope: { kind: "repository", key: "/repo" } });
    await gateway.inbox({});
    expect(rpc).toHaveBeenCalledWith(
      "context.pack",
      expect.objectContaining({ sessionId: "claude:one", provider: "claude", repository: "/repo" })
    );
    expect(rpc).toHaveBeenCalledWith(
      "handoff.inbox",
      expect.objectContaining({ sessionId: "claude:one", provider: "claude", repository: "/repo" })
    );
  });

  it("searches historical sessions in scope and excludes the caller by default", async () => {
    const rpc = vi.fn(async (method: string, params?: unknown) => ({ method, params }));
    const gateway = new McpGateway(rpc, {
      sessionId: "codex:current",
      repository: "/repo",
      worktree: "/repo"
    });
    await gateway.sessionSearch({
      query: "LegalVoice web chat",
      scope: { kind: "repository", key: "/repo" },
      limit: 5
    });
    expect(rpc).toHaveBeenCalledWith("session.search", {
      query: "LegalVoice web chat",
      repositoryRoot: "/repo",
      excludeSessionId: "codex:current",
      limit: 5
    });
  });

  it("resolves an ordinary caller from one live provider session in the same repository", async () => {
    const rpc = vi.fn(async () => [{
      runId: "attached_run",
      provider: "claude",
      providerSessionId: "claude:ordinary",
      repositoryRoot: "/repo",
      worktreeRoot: "/repo"
    }]);
    const gateway = new McpGateway(rpc, { provider: "claude", repository: "/repo" });
    await expect(gateway.resolveIdentity()).resolves.toMatchObject({
      runId: "attached_run",
      sessionId: "claude:ordinary",
      provider: "claude",
      repository: "/repo"
    });
  });

  it("does not overwrite explicit actor identity", () => {
    expect(withIdentity({ actorSession: "explicit" }, { sessionId: "inherited" })).toMatchObject({
      actorSession: "explicit"
    });
  });

  it("binds mutating provenance and actors to a resolved caller", () => {
    const identity = { sessionId: "resolved" };
    expect(withActorIdentity({ actorSession: "spoofed" }, identity)).toMatchObject({ actorSession: "resolved" });
    expect(withSourceIdentity({ sourceSessionId: "spoofed" }, identity)).toMatchObject({ sourceSessionId: "resolved" });
  });
});
