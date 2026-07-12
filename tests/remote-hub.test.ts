import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { startRemoteHub, validateRemoteHubSecurity } from "../src/remote/hub.js";
import { RemoteHubStore } from "../src/remote/store.js";
import type { Authenticator, RemoteRecord, RemoteRecordInput } from "../src/remote/types.js";

const TOKEN = "remote-hub-test-token-0123456789abcdef";
const principal = { tokenId: "test", teamId: "team-a", repositoryIds: ["repo-a"] };
const authenticator: Authenticator = {
  authenticate: (token) => token === TOKEN ? principal : null
};

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...extra };
}

function memory(key: string, sensitivity: string = "team"): RemoteRecordInput {
  return {
    idempotencyKey: `hub-record-${key.padEnd(16, "x")}`,
    type: "memory",
    subjectId: `subject-${key}`,
    payload: { kind: "fact", text: key, confidence: 0.9, importance: 0.8, expiresAt: null },
    provenance: { source: "test", sourceRecordId: key, occurredAt: "2026-07-12T12:00:00Z" },
    sensitivity: sensitivity as RemoteRecordInput["sensitivity"]
  };
}

async function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
}

async function getWithHost(url: string, host: string): Promise<number> {
  const target = new URL(url);
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: "/v1/health",
      headers: { host, authorization: `Bearer ${TOKEN}` }
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("remote memory hub", () => {
  it("is disabled by default and requires TLS plus explicit hosts off loopback", async () => {
    expect(() => validateRemoteHubSecurity({})).toThrow(/disabled/);
    expect(() => validateRemoteHubSecurity({ enabled: true, host: "0.0.0.0" })).toThrow(/TLS/);
    expect(() => validateRemoteHubSecurity({
      enabled: true,
      host: "0.0.0.0",
      tls: { key: "key", cert: "cert" }
    })).toThrow(/allowed host/);
  });

  it("authenticates, enforces namespaces, and pushes/pulls append-only records", async () => {
    const store = new RemoteHubStore(":memory:");
    const hub = await startRemoteHub({ enabled: true, port: 0, store, authenticator });
    try {
      expect((await fetch(`${hub.url}/v1/health`)).status).toBe(401);
      const health = await fetch(`${hub.url}/v1/health`, { headers: headers() });
      expect(await health.json()).toMatchObject({ ok: true, execution: false });

      const pushed = await post(hub.url, "/v1/sync/push", {
        teamId: "team-a",
        repositoryId: "repo-a",
        records: [{ ...memory("one"), actorTokenId: "spoofed-client-actor" }]
      });
      expect(await pushed.json()).toMatchObject({ accepted: 1, duplicates: 0 });
      const pulled = await post(hub.url, "/v1/sync/pull", {
        teamId: "team-a",
        repositoryId: "repo-a",
        afterCursor: 0
      });
      const body = await pulled.json() as { records: RemoteRecord[] };
      expect(body.records).toHaveLength(1);
      expect(body.records[0]?.actorTokenId).toBe("test");

      const forbidden = await post(hub.url, "/v1/sync/pull", {
        teamId: "team-a",
        repositoryId: "repo-b",
        afterCursor: 0
      });
      expect(forbidden.status).toBe(403);
      const secret = await post(hub.url, "/v1/sync/push", {
        teamId: "team-a",
        repositoryId: "repo-a",
        records: [memory("secret", "secret")]
      });
      expect(secret.status).toBe(422);
    } finally {
      await hub.close();
      store.close();
    }
  });

  it("hard-bounds pull response bytes while preserving cursor pagination", async () => {
    const store = new RemoteHubStore(":memory:");
    const hub = await startRemoteHub({
      enabled: true,
      port: 0,
      store,
      authenticator,
      maxResponseBytes: 1_024
    });
    try {
      const records = ["one", "two", "three"].map((key) => ({
        ...memory(key),
        payload: { ...memory(key).payload, text: key.repeat(80) }
      }));
      expect((await post(hub.url, "/v1/sync/push", {
        teamId: "team-a", repositoryId: "repo-a", records
      })).status).toBe(200);
      const response = await post(hub.url, "/v1/sync/pull", {
        teamId: "team-a", repositoryId: "repo-a", afterCursor: 0, limit: 500
      });
      const text = await response.text();
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1_024);
      const page = JSON.parse(text) as { records: RemoteRecord[]; latestCursor: number };
      expect(page.records.length).toBeGreaterThan(0);
      expect(page.records.length).toBeLessThan(records.length);
      expect(page.latestCursor).toBeGreaterThan(page.records.at(-1)!.cursor);
    } finally {
      await hub.close();
      store.close();
    }
  });

  it("rejects DNS rebinding hosts, untrusted browser origins, and oversized bodies", async () => {
    const store = new RemoteHubStore(":memory:");
    const hub = await startRemoteHub({
      enabled: true,
      port: 0,
      store,
      authenticator,
      maxRequestBytes: 256
    });
    try {
      expect(await getWithHost(hub.url, "attacker.example")).toBe(403);
      expect((await fetch(`${hub.url}/v1/health`, {
        headers: headers({ origin: "https://attacker.example" })
      })).status).toBe(403);
      const oversized = await post(hub.url, "/v1/sync/push", {
        teamId: "team-a",
        repositoryId: "repo-a",
        records: [memory("x".repeat(400))]
      });
      expect(oversized.status).toBe(413);
    } finally {
      await hub.close();
      store.close();
    }
  });

  it("uses bounded long-polling for near-real-time changes", async () => {
    const store = new RemoteHubStore(":memory:");
    const hub = await startRemoteHub({ enabled: true, port: 0, store, authenticator, maxLongPollMs: 1_000 });
    try {
      const pending = post(hub.url, "/v1/sync/pull", {
        teamId: "team-a",
        repositoryId: "repo-a",
        afterCursor: 0,
        waitMs: 1_000
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      store.push({ teamId: "team-a", repositoryId: "repo-a" }, [memory("wake")]);
      const response = await pending;
      const result = await response.json() as { records: RemoteRecordInput[] };
      expect(result.records).toHaveLength(1);
    } finally {
      await hub.close();
      store.close();
    }
  });

  it("limits both request rate and concurrent long polls", async () => {
    let now = 1_000;
    const store = new RemoteHubStore(":memory:");
    const rateHub = await startRemoteHub({
      enabled: true,
      port: 0,
      store,
      authenticator,
      clock: () => now,
      rateLimitPerMinute: 1
    });
    try {
      expect((await fetch(`${rateHub.url}/v1/health`, { headers: headers() })).status).toBe(200);
      expect((await fetch(`${rateHub.url}/v1/health`, { headers: headers() })).status).toBe(429);
      now += 60_000;
      expect((await fetch(`${rateHub.url}/v1/health`, { headers: headers() })).status).toBe(200);
    } finally {
      await rateHub.close();
      store.close();
    }

    const concurrencyStore = new RemoteHubStore(":memory:");
    const concurrencyHub = await startRemoteHub({
      enabled: true,
      port: 0,
      store: concurrencyStore,
      authenticator,
      maxConcurrentRequests: 1,
      maxLongPollMs: 1_000
    });
    try {
      const pending = post(concurrencyHub.url, "/v1/sync/pull", {
        teamId: "team-a", repositoryId: "repo-a", afterCursor: 0, waitMs: 1_000
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect((await fetch(`${concurrencyHub.url}/v1/health`, { headers: headers() })).status).toBe(429);
      concurrencyStore.push({ teamId: "team-a", repositoryId: "repo-a" }, [memory("release")]);
      await pending;
    } finally {
      await concurrencyHub.close();
      concurrencyStore.close();
    }
  });
});
