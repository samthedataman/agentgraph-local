import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { HandoffStore } from "../src/handoff/store.js";
import { ArtifactStore } from "../src/memory/artifacts.js";
import { ContextPackBuilder } from "../src/memory/context-pack.js";
import type { SqliteDatabase } from "../src/memory/database.js";
import { MemoryDomain } from "../src/memory/domain.js";
import { GraphStore } from "../src/memory/graph.js";
import { SessionSnapshotStore } from "../src/memory/snapshots.js";
import { MemoryStore } from "../src/memory/store.js";

const open: Database.Database[] = [];

function database(): SqliteDatabase {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  open.push(db);
  return db as unknown as SqliteDatabase;
}

afterEach(() => {
  while (open.length) open.pop()?.close();
});

describe("MemoryStore", () => {
  it("keeps search scoped and returns explicit provenance", () => {
    const store = new MemoryStore(database(), () => "2026-07-12T12:00:00.000Z");
    const memory = store.commit({
      kind: "decision",
      text: "Use a Unix domain socket for local IPC",
      scope: { kind: "repository", key: "/repo/a" },
      sourceSessionId: "codex:one",
      sources: [{ type: "event", id: "evt_1", excerpt: "Architecture decision" }],
      confidence: 0.95,
      importance: 0.9
    });
    store.commit({
      kind: "decision",
      text: "Use TCP for the unrelated project",
      scope: { kind: "repository", key: "/repo/b" }
    });

    const results = store.search({
      query: "Unix socket",
      scope: { kind: "repository", key: "/repo/a" }
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(memory.id);
    expect(results[0]?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "event", id: "evt_1" }),
        expect.objectContaining({ type: "session", id: "codex:one" })
      ])
    );
  });

  it("supersedes without returning stale memory", () => {
    const store = new MemoryStore(database());
    const first = store.commit({
      kind: "fact",
      text: "The service uses port 3000",
      scope: { kind: "repository", key: "/repo" }
    });
    const next = store.supersede(first.id, {
      kind: "fact",
      text: "The service uses a Unix socket",
      scope: { kind: "repository", key: "/repo" }
    });

    expect(store.get(first.id)).toMatchObject({ status: "superseded", supersededBy: next.id });
    expect(store.search({ query: "port 3000", scope: { kind: "repository", key: "/repo" } })).toEqual([]);
    expect(store.search({ query: "Unix socket", scope: { kind: "repository", key: "/repo" } })[0]?.id).toBe(next.id);
  });

  it("excludes secret memory from search unless explicitly requested", () => {
    const store = new MemoryStore(database());
    const scope = { kind: "repository" as const, key: "/repo" };
    store.commit({ kind: "fact", text: "secret marker", scope, sensitivity: "secret" });
    expect(store.search({ query: "marker", scope })).toEqual([]);
    expect(store.search({ query: "marker", scope, includeSecret: true })).toHaveLength(1);
  });

  it("projects memory provenance and supersession into the graph", () => {
    const db = database();
    const domain = new MemoryDomain(db);
    const first = domain.commitMemory({
      kind: "constraint",
      text: "Do not expose a TCP listener",
      scope: { kind: "repository", key: "/repo" },
      sources: [{ type: "event", id: "evt_security" }]
    });
    const replacement = domain.supersedeMemory(first.id, {
      kind: "constraint",
      text: "Bind only to a private Unix socket",
      scope: { kind: "repository", key: "/repo" }
    });
    const row = db
      .prepare("SELECT node_id FROM ag_graph_nodes WHERE node_type = 'Memory' AND canonical_key = ?")
      .get(replacement.id) as { node_id: string };
    const neighborhood = domain.graph.neighbors(row.node_id);
    expect(neighborhood.edges.some((edge) => edge.type === "SUPERSEDES")).toBe(true);
  });
});

describe("artifacts, graph, and context packs", () => {
  it("stores bounded artifact content behind a stable reference", () => {
    const store = new ArtifactStore(database());
    const artifact = store.publish({
      name: "test-report.txt",
      scope: { kind: "repository", key: "/repo" },
      content: "2 tests passed",
      sourceEventId: "evt_test"
    });
    expect(artifact.contentRef).toBe(`agentgraph://artifacts/${artifact.id}/content`);
    expect(store.get(artifact.id)).not.toHaveProperty("content");
    expect(store.get(artifact.id, true)).toMatchObject({ content: "2 tests passed", sourceEventId: "evt_test" });
  });

  it("returns evidence-backed graph neighborhoods", () => {
    const db = database();
    const graph = new GraphStore(db);
    const scope = { kind: "repository" as const, key: "/repo" };
    const decision = graph.upsertNode({ type: "Decision", canonicalKey: "d1", label: "Use SQLite", scope });
    const event = graph.upsertNode({ type: "Event", canonicalKey: "evt1", label: "Decision event", scope });
    graph.addEdge({
      fromNodeId: decision.id,
      toNodeId: event.id,
      type: "SUPPORTED_BY",
      evidenceEventId: "evt1",
      confidence: 1
    });
    expect(graph.neighbors(decision.id, { direction: "out" })).toMatchObject({
      nodes: [expect.objectContaining({ id: event.id })],
      edges: [expect.objectContaining({ evidenceEventId: "evt1", confidence: 1 })]
    });
  });

  it("never exceeds the requested context-pack budget", () => {
    const db = database();
    const memories = new MemoryStore(db);
    const handoffs = new HandoffStore(db);
    const artifacts = new ArtifactStore(db);
    const snapshots = new SessionSnapshotStore(db);
    const builder = new ContextPackBuilder(memories, handoffs, artifacts, snapshots);
    for (let index = 0; index < 10; index += 1) {
      memories.commit({
        kind: "fact",
        text: `Socket decision ${index} ${"details ".repeat(20)}`,
        scope: { kind: "repository", key: "/repo" }
      });
    }
    const pack = builder.build({
      scope: { kind: "repository", key: "/repo" },
      query: "socket decision",
      maxBytes: 512
    });
    expect(pack.byteLength).toBeLessThanOrEqual(512);
    expect(pack.approximateTokens).toBe(Math.ceil(pack.byteLength / 4));
    expect(pack.truncated).toBe(true);
    expect(pack.text).toContain("untrusted working context");
  });

  it("does not include global memory in a repository context pack unless requested", () => {
    const db = database();
    const memories = new MemoryStore(db);
    const builder = new ContextPackBuilder(
      memories,
      new HandoffStore(db),
      new ArtifactStore(db),
      new SessionSnapshotStore(db)
    );
    memories.commit({
      kind: "fact",
      text: "global-only-marker",
      scope: { kind: "global", key: "global" }
    });
    const input = { scope: { kind: "repository" as const, key: "/repo" }, query: "marker" };
    expect(builder.build(input).text).not.toContain("global-only-marker");
    expect(builder.build({ ...input, includeGlobal: true }).text).toContain("global-only-marker");
  });

  it("does not include a session snapshot from another repository scope", () => {
    const db = database();
    const snapshots = new SessionSnapshotStore(db);
    snapshots.upsert({
      sessionId: "claude:one",
      scope: { kind: "repository", key: "/other" },
      summary: "cross-repo-marker"
    });
    const builder = new ContextPackBuilder(
      new MemoryStore(db),
      new HandoffStore(db),
      new ArtifactStore(db),
      snapshots
    );
    const pack = builder.build({
      scope: { kind: "repository", key: "/repo" },
      sessionId: "claude:one"
    });
    expect(pack.text).not.toContain("cross-repo-marker");
  });
});
