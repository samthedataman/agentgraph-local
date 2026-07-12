import { id } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import type { SqliteDatabase } from "../memory/database.js";
import { ensureDomainSchema } from "../memory/schema.js";
import { parseJsonArray } from "../memory/validation.js";
import type {
  CreateHandoffInput,
  Handoff,
  HandoffDelivery,
  HandoffState,
  HandoffTarget,
  InboxSelector
} from "./types.js";

interface HandoffRow {
  handoff_id: string;
  from_session: string;
  target_session: string | null;
  target_provider: string | null;
  target_repository: string | null;
  target_capability: string | null;
  objective: string;
  state: HandoffState;
  delivery_mode: Handoff["deliveryMode"];
  requires_ack: number;
  context_refs_json: string;
  artifact_refs_json: string;
  causal_chain_json: string;
  hop_count: number;
  max_hops: number;
  claimed_by_session: string | null;
  result_summary: string | null;
  error: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  claimed_at: string | null;
  completed_at: string | null;
}

interface DeliveryRow {
  delivery_id: string;
  handoff_id: string;
  recipient_session: string | null;
  state: string;
  detail: string | null;
  created_at: string;
}

const TERMINAL_STATES = new Set<HandoffState>(["completed", "failed", "expired", "cancelled", "declined"]);
const TRANSITIONS: Record<HandoffState, ReadonlySet<HandoffState>> = {
  created: new Set(["queued", "cancelled"]),
  queued: new Set(["delivered", "acknowledged", "claimed", "failed", "expired", "cancelled", "declined"]),
  delivered: new Set(["acknowledged", "claimed", "failed", "expired", "cancelled", "declined"]),
  acknowledged: new Set(["claimed", "running", "failed", "expired", "cancelled", "declined"]),
  claimed: new Set(["running", "completed", "failed", "expired", "cancelled"]),
  running: new Set(["completed", "failed", "expired", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  expired: new Set(),
  cancelled: new Set(),
  declined: new Set()
};

export class HandoffStore {
  constructor(
    readonly database: SqliteDatabase,
    private readonly clock: () => string = nowIso
  ) {
    ensureDomainSchema(database);
  }

  create(input: CreateHandoffInput): Handoff {
    validateCreate(input);
    const handoffId = id("handoff");
    if (input.causalChain && new Set(input.causalChain).size !== input.causalChain.length) {
      throw new Error("A handoff causal chain cannot contain a cycle");
    }
    const hopCount = input.hopCount ?? 0;
    const maxHops = input.maxHops ?? 2;
    if (hopCount > maxHops) throw new Error(`Handoff hop count ${hopCount} exceeds maxHops ${maxHops}`);
    const timestamp = this.clock();
    const expiresAt = input.expiresAt
      ? new Date(Date.parse(input.expiresAt)).toISOString()
      : new Date(Date.parse(timestamp) + 24 * 60 * 60 * 1_000).toISOString();
    this.database
      .prepare(
        `INSERT INTO ag_handoffs(
          handoff_id, from_session, target_session, target_provider, target_repository,
          target_capability, objective, state, delivery_mode, requires_ack,
          context_refs_json, artifact_refs_json, causal_chain_json, hop_count,
          max_hops, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        handoffId,
        input.fromSession,
        input.target.sessionId ?? null,
        input.target.provider ?? null,
        input.target.repository ?? null,
        input.target.capability ?? null,
        input.objective.trim(),
        input.deliveryMode ?? "next_turn",
        input.requiresAck === false ? 0 : 1,
        JSON.stringify(unique(input.contextRefs ?? [])),
        JSON.stringify(unique(input.artifactRefs ?? [])),
        JSON.stringify(unique(input.causalChain ?? [])),
        hopCount,
        maxHops,
        expiresAt,
        timestamp,
        timestamp
      );
    this.recordDelivery(handoffId, null, "queued", null);
    return this.require(handoffId);
  }

  get(handoffId: string): Handoff | null {
    const row = this.database.prepare("SELECT * FROM ag_handoffs WHERE handoff_id = ?").get(handoffId) as
      | HandoffRow
      | undefined;
    return row ? mapHandoff(row) : null;
  }

  require(handoffId: string): Handoff {
    const handoff = this.get(handoffId);
    if (!handoff) throw new Error(`Handoff not found: ${handoffId}`);
    return handoff;
  }

  inbox(selector: InboxSelector): Handoff[] {
    this.expireDue();
    const states = selector.states ?? ["queued", "delivered", "acknowledged", "claimed", "running"];
    const placeholders = states.map(() => "?").join(",");
    const rows = this.database
      .prepare(
        `SELECT * FROM ag_handoffs
         WHERE state IN (${placeholders})
           AND (
             (
               target_session = ?
               AND (? = '' OR target_repository IS NULL OR target_repository = ?)
             ) OR
             (
               target_session IS NULL
               AND (target_provider IS NULL OR target_provider = ?)
               AND (target_repository IS NULL OR target_repository = ?)
             )
           )
         ORDER BY created_at ASC LIMIT ?`
      )
      .all(
        ...states,
        selector.sessionId,
        selector.repository ?? "",
        selector.repository ?? "",
        selector.provider ?? "",
        selector.repository ?? "",
        Math.min(Math.max(selector.limit ?? 25, 1), 100)
      ) as HandoffRow[];
    return rows.map(mapHandoff);
  }

  list(options: { fromSession?: string; states?: HandoffState[]; limit?: number } = {}): Handoff[] {
    this.expireDue();
    const clauses: string[] = ["1 = 1"];
    const params: unknown[] = [];
    if (options.fromSession) {
      clauses.push("from_session = ?");
      params.push(options.fromSession);
    }
    if (options.states?.length) {
      clauses.push(`state IN (${options.states.map(() => "?").join(",")})`);
      params.push(...options.states);
    }
    params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));
    const rows = this.database
      .prepare(`SELECT * FROM ag_handoffs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as HandoffRow[];
    return rows.map(mapHandoff);
  }

  deliver(handoffId: string, recipientSession: string, detail?: string): Handoff {
    return this.transition(handoffId, "delivered", recipientSession, detail);
  }

  acknowledge(handoffId: string, actorSession: string): Handoff {
    return this.transition(handoffId, "acknowledged", actorSession);
  }

  claim(handoffId: string, actorSession: string): Handoff {
    return this.transition(handoffId, "claimed", actorSession);
  }

  start(handoffId: string, actorSession: string): Handoff {
    return this.transition(handoffId, "running", actorSession);
  }

  complete(handoffId: string, actorSession: string, resultSummary?: string, artifactRefs: string[] = []): Handoff {
    return this.database.transaction(() => {
      this.expireDue();
      const current = this.assertActor(this.require(handoffId), actorSession, "recipient");
      this.assertTransition(current.state, "completed");
      const timestamp = this.clock();
      const allArtifacts = unique([...current.artifactRefs, ...artifactRefs]);
      this.database
        .prepare(
          `UPDATE ag_handoffs SET state = 'completed', result_summary = ?, artifact_refs_json = ?,
           updated_at = ?, completed_at = ? WHERE handoff_id = ?`
        )
        .run(resultSummary ?? null, JSON.stringify(allArtifacts), timestamp, timestamp, handoffId);
      this.recordDelivery(handoffId, actorSession, "completed", resultSummary ?? null);
      return this.require(handoffId);
    })();
  }

  fail(handoffId: string, actorSession: string, error: string): Handoff {
    if (!error.trim()) throw new Error("A failure reason is required");
    return this.transition(handoffId, "failed", actorSession, error.trim());
  }

  decline(handoffId: string, actorSession: string, reason?: string): Handoff {
    return this.transition(handoffId, "declined", actorSession, reason);
  }

  cancel(handoffId: string, actorSession: string, reason?: string): Handoff {
    this.expireDue();
    const current = this.require(handoffId);
    if (current.fromSession !== actorSession) throw new Error("Only the sender can cancel a handoff");
    return this.transitionInternal(current, "cancelled", actorSession, reason);
  }

  deliveries(handoffId: string): HandoffDelivery[] {
    const rows = this.database
      .prepare("SELECT * FROM ag_handoff_deliveries WHERE handoff_id = ? ORDER BY created_at")
      .all(handoffId) as DeliveryRow[];
    return rows.map((row) => ({
      id: row.delivery_id,
      handoffId: row.handoff_id,
      recipientSession: row.recipient_session,
      state: row.state,
      detail: row.detail,
      createdAt: row.created_at
    }));
  }

  expireDue(): number {
    const timestamp = this.clock();
    const due = this.database
      .prepare(
        `SELECT handoff_id FROM ag_handoffs
         WHERE expires_at IS NOT NULL AND expires_at <= ?
           AND state NOT IN ('completed', 'failed', 'expired', 'cancelled', 'declined')`
      )
      .all(timestamp) as Array<{ handoff_id: string }>;
    for (const row of due) {
      this.database
        .prepare("UPDATE ag_handoffs SET state = 'expired', updated_at = ?, completed_at = ? WHERE handoff_id = ?")
        .run(timestamp, timestamp, row.handoff_id);
      this.recordDelivery(row.handoff_id, null, "expired", "Handoff TTL elapsed");
    }
    return due.length;
  }

  private transition(handoffId: string, state: HandoffState, actorSession: string, detail?: string): Handoff {
    this.expireDue();
    const current = this.assertActor(this.require(handoffId), actorSession, "recipient");
    if (
      current.requiresAck &&
      (state === "claimed" || state === "running") &&
      (current.state === "queued" || current.state === "delivered")
    ) {
      throw new Error("This handoff requires acknowledgement before it can be claimed or started");
    }
    return this.transitionInternal(current, state, actorSession, detail);
  }

  private transitionInternal(current: Handoff, state: HandoffState, actorSession: string, detail?: string): Handoff {
    this.assertTransition(current.state, state);
    const timestamp = this.clock();
    const assignments = ["state = ?", "updated_at = ?"];
    const values: unknown[] = [state, timestamp];
    if (state === "acknowledged") {
      assignments.push("acknowledged_at = ?");
      values.push(timestamp);
    }
    if (state === "claimed") {
      assignments.push("claimed_by_session = ?", "claimed_at = ?");
      values.push(actorSession, timestamp);
    }
    if (state === "running" && current.claimedBySession === null) {
      assignments.push("claimed_by_session = ?", "claimed_at = ?");
      values.push(actorSession, timestamp);
    }
    if (state === "failed") {
      assignments.push("error = ?", "completed_at = ?");
      values.push(detail ?? "Handoff failed", timestamp);
    } else if (TERMINAL_STATES.has(state)) {
      assignments.push("completed_at = ?");
      values.push(timestamp);
    }
    values.push(current.id);
    this.database.prepare(`UPDATE ag_handoffs SET ${assignments.join(", ")} WHERE handoff_id = ?`).run(...values);
    this.recordDelivery(current.id, actorSession, state, detail ?? null);
    return this.require(current.id);
  }

  private assertTransition(from: HandoffState, to: HandoffState): void {
    if (!TRANSITIONS[from].has(to)) throw new Error(`Invalid handoff transition: ${from} -> ${to}`);
  }

  private assertActor(handoff: Handoff, actorSession: string, role: "recipient"): Handoff {
    if (!actorSession.trim()) throw new Error("actorSession is required");
    if (role === "recipient" && handoff.target.sessionId && handoff.target.sessionId !== actorSession) {
      throw new Error("This handoff is addressed to another session");
    }
    if (handoff.claimedBySession && handoff.claimedBySession !== actorSession) {
      throw new Error(`Handoff is already claimed by ${handoff.claimedBySession}`);
    }
    return handoff;
  }

  private recordDelivery(handoffId: string, recipientSession: string | null, state: string, detail: string | null): void {
    this.database
      .prepare(
        `INSERT INTO ag_handoff_deliveries(
          delivery_id, handoff_id, recipient_session, state, detail, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id("delivery"), handoffId, recipientSession, state, detail, this.clock());
  }
}

function validateCreate(input: CreateHandoffInput): void {
  if (!input.fromSession?.trim()) throw new Error("fromSession is required");
  if (!input.objective?.trim()) throw new Error("objective is required");
  if (Buffer.byteLength(input.objective, "utf8") > 32 * 1024) throw new Error("Handoff objective exceeds 32 KiB");
  if (!input.target || !Object.values(input.target).some((value) => typeof value === "string" && value.trim())) {
    throw new Error("At least one handoff target selector is required");
  }
  if ((input.maxHops ?? 2) < 0 || (input.maxHops ?? 2) > 20) throw new Error("maxHops must be between 0 and 20");
  if ((input.hopCount ?? 0) < 0) throw new Error("hopCount cannot be negative");
  if (input.expiresAt && !Number.isFinite(Date.parse(input.expiresAt))) throw new Error("expiresAt must be an ISO date");
}

function mapHandoff(row: HandoffRow): Handoff {
  const target: HandoffTarget = {};
  if (row.target_session !== null) target.sessionId = row.target_session;
  if (row.target_provider !== null) target.provider = row.target_provider;
  if (row.target_repository !== null) target.repository = row.target_repository;
  if (row.target_capability !== null) target.capability = row.target_capability;
  return {
    id: row.handoff_id,
    fromSession: row.from_session,
    target,
    objective: row.objective,
    state: row.state,
    deliveryMode: row.delivery_mode,
    requiresAck: row.requires_ack === 1,
    contextRefs: parseJsonArray(row.context_refs_json),
    artifactRefs: parseJsonArray(row.artifact_refs_json),
    causalChain: parseJsonArray(row.causal_chain_json),
    hopCount: row.hop_count,
    maxHops: row.max_hops,
    claimedBySession: row.claimed_by_session,
    resultSummary: row.result_summary,
    error: row.error,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acknowledgedAt: row.acknowledged_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}
