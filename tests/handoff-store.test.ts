import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { HandoffStore } from "../src/handoff/store.js";
import type { SqliteDatabase } from "../src/memory/database.js";

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

describe("HandoffStore", () => {
  it("routes an inbox item and enforces its durable state machine", () => {
    const store = new HandoffStore(database(), () => "2026-07-12T12:00:00.000Z");
    const handoff = store.create({
      fromSession: "codex:one",
      target: { sessionId: "claude:two", provider: "claude", repository: "/repo" },
      objective: "Review the socket lifecycle",
      contextRefs: ["mem_1"],
      artifactRefs: ["artifact_1"]
    });
    expect(handoff.expiresAt).toBe("2026-07-13T12:00:00.000Z");
    expect(store.inbox({ sessionId: "claude:two", provider: "claude", repository: "/repo" })).toHaveLength(1);
    expect(store.inbox({ sessionId: "claude:other", provider: "claude", repository: "/repo" })).toEqual([]);
    expect(store.inbox({ sessionId: "claude:two", provider: "claude", repository: "/other" })).toEqual([]);

    store.acknowledge(handoff.id, "claude:two");
    store.claim(handoff.id, "claude:two");
    store.start(handoff.id, "claude:two");
    const completed = store.complete(handoff.id, "claude:two", "No blocking issues", ["artifact_review"]);
    expect(completed).toMatchObject({
      state: "completed",
      claimedBySession: "claude:two",
      resultSummary: "No blocking issues",
      artifactRefs: ["artifact_1", "artifact_review"]
    });
    expect(store.deliveries(handoff.id).map((delivery) => delivery.state)).toEqual([
      "queued",
      "acknowledged",
      "claimed",
      "running",
      "completed"
    ]);
    expect(() => store.fail(handoff.id, "claude:two", "late failure")).toThrow("Invalid handoff transition");
  });

  it("prevents a different exact recipient from claiming work", () => {
    const store = new HandoffStore(database());
    const handoff = store.create({
      fromSession: "codex:one",
      target: { sessionId: "claude:two" },
      objective: "Review"
    });
    expect(() => store.claim(handoff.id, "claude:three")).toThrow("addressed to another session");
  });

  it("enforces acknowledgement when the sender requires it", () => {
    const store = new HandoffStore(database());
    const handoff = store.create({
      fromSession: "codex:one",
      target: { sessionId: "claude:two" },
      objective: "Review",
      requiresAck: true
    });
    expect(() => store.claim(handoff.id, "claude:two")).toThrow("requires acknowledgement");
    store.acknowledge(handoff.id, "claude:two");
    expect(store.claim(handoff.id, "claude:two").state).toBe("claimed");
  });

  it("expires pending work and rejects excess delegation hops", () => {
    let clock = "2026-07-12T12:00:00.000Z";
    const store = new HandoffStore(database(), () => clock);
    const handoff = store.create({
      fromSession: "codex:one",
      target: { provider: "claude" },
      objective: "Time bounded review",
      expiresAt: "2026-07-12T12:01:00.000Z"
    });
    expect(handoff.expiresAt).toBe("2026-07-12T12:01:00.000Z");
    clock = "2026-07-12T12:02:00.000Z";
    expect(store.expireDue()).toBe(1);
    expect(store.get(handoff.id)?.state).toBe("expired");
    expect(() =>
      store.create({
        fromSession: "codex:one",
        target: { provider: "claude" },
        objective: "Recursive review",
        hopCount: 3,
        maxHops: 2
      })
    ).toThrow("exceeds maxHops");
  });
});
