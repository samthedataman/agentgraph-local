import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { startA2AServer } from "../src/a2a/server.js";

const TOKEN = "agentgraph-test-token-0123456789abcdef";

function rpcBody(prompt: string, provider = "claude"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: { parts: [{ kind: "text", text: prompt }] },
      metadata: { provider }
    }
  });
}

function authorizedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    ...extra
  };
}

async function getWithHost(url: string, host: string): Promise<number> {
  const target = new URL(url);
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "GET",
      headers: {
        host,
        authorization: `Bearer ${TOKEN}`
      }
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("experimental A2A façade", () => {
  it("requires a bearer token and delegates an authenticated text message", async () => {
    const server = await startA2AServer({
      port: 0,
      token: TOKEN,
      delegateFn: async (options) => ({
        provider: options.provider,
        sessionId: "session-1",
        finalResponse: `reviewed: ${options.prompt}`,
        exitCode: 0,
        durationMs: 1,
        events: [],
        stderr: ""
      })
    });
    try {
      const unauthorized = await fetch(`${server.url}/.well-known/agent-card.json`);
      expect(unauthorized.status).toBe(401);

      const cardResponse = await fetch(`${server.url}/.well-known/agent-card.json`, {
        headers: authorizedHeaders()
      });
      expect(cardResponse.status).toBe(200);
      const card = await cardResponse.json() as Record<string, unknown>;
      expect(card.name).toBe("AgentGraph Local Relay");

      const response = await fetch(`${server.url}/a2a`, {
        method: "POST",
        headers: authorizedHeaders(),
        body: rpcBody("check the diff")
      }).then((result) => result.json()) as Record<string, unknown>;

      const task = response.result as Record<string, unknown>;
      expect(task.provider).toBe("claude");
      expect((task.status as Record<string, unknown>).state).toBe("completed");
    } finally {
      await server.close();
    }
  });

  it("generates an unguessable token when one is not supplied", async () => {
    const server = await startA2AServer({ port: 0 });
    try {
      expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const response = await fetch(`${server.url}/.well-known/agent-card.json`, {
        headers: { authorization: `Bearer ${server.token}` }
      });
      expect(response.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("rejects non-loopback Host headers and unsafe browser origins", async () => {
    const server = await startA2AServer({ port: 0, token: TOKEN });
    try {
      expect(await getWithHost(`${server.url}/.well-known/agent-card.json`, "attacker.example")).toBe(403);
      const originResponse = await fetch(`${server.url}/.well-known/agent-card.json`, {
        headers: authorizedHeaders({ origin: "https://attacker.example" })
      });
      expect(originResponse.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("bounds request bodies and delegated output", async () => {
    const server = await startA2AServer({
      port: 0,
      token: TOKEN,
      maxRequestBytes: 256,
      maxOutputBytes: 96,
      delegateFn: async (options) => ({
        provider: options.provider,
        finalResponse: "é".repeat(1_000),
        exitCode: 0,
        durationMs: 1,
        events: [],
        stderr: ""
      })
    });
    try {
      const oversized = await fetch(`${server.url}/a2a`, {
        method: "POST",
        headers: authorizedHeaders(),
        body: rpcBody("x".repeat(512))
      });
      expect(oversized.status).toBe(413);

      const response = await fetch(`${server.url}/a2a`, {
        method: "POST",
        headers: authorizedHeaders(),
        body: rpcBody("bounded response")
      }).then((result) => result.json()) as Record<string, unknown>;
      const task = response.result as { artifacts: Array<{ parts: Array<{ text: string }> }> };
      const text = task.artifacts[0]?.parts[0]?.text ?? "";
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(96);
      expect(text).toContain("output truncated");
    } finally {
      await server.close();
    }
  });

  it("rejects work above the configured concurrency cap", async () => {
    let release!: () => void;
    let signalStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const server = await startA2AServer({
      port: 0,
      token: TOKEN,
      maxConcurrentTasks: 1,
      delegateFn: async (options) => {
        signalStarted();
        await gate;
        return {
          provider: options.provider,
          finalResponse: "done",
          exitCode: 0,
          durationMs: 1,
          events: [],
          stderr: ""
        };
      }
    });
    try {
      const first = fetch(`${server.url}/a2a`, {
        method: "POST",
        headers: authorizedHeaders(),
        body: rpcBody("first")
      });
      await started;
      const second = await fetch(`${server.url}/a2a`, {
        method: "POST",
        headers: authorizedHeaders(),
        body: rpcBody("second")
      });
      expect(second.status).toBe(429);
      release();
      expect((await first).status).toBe(200);
    } finally {
      release();
      await server.close();
    }
  });
});
