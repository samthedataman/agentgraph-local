import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { assertScopeAccess, createMcpServer } from "../src/mcp/server.js";

describe("AgentGraph MCP server", () => {
  it("rejects repository and session scopes that contradict resolved identity", () => {
    expect(() =>
      assertScopeAccess(
        { kind: "repository", key: "/other" },
        { repository: "/repo", sessionId: "codex:one" }
      )
    ).toThrow("does not match");
    expect(() =>
      assertScopeAccess(
        { kind: "session", key: "codex:other" },
        { repository: "/repo", sessionId: "codex:one" }
      )
    ).toThrow("resolved MCP session");
  });

  it("exposes a complete handoff lifecycle and inherits session identity", async () => {
    const rpc = vi.fn(async (method: string, params?: unknown) => ({ method, params }));
    const server = createMcpServer(rpc, { sessionId: "claude:one" });
    const client = new Client({ name: "agentgraph-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "session_search",
          "handoff_acknowledge",
          "handoff_claim",
          "handoff_start",
          "handoff_complete",
          "handoff_fail",
          "handoff_decline",
          "handoff_cancel"
        ])
      );

      await client.callTool({
        name: "handoff_claim",
        arguments: { handoffId: "handoff_1", actorSession: "spoofed" }
      });
      expect(rpc).toHaveBeenCalledWith("handoff.claim", {
        handoffId: "handoff_1",
        actorSession: "claude:one"
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
