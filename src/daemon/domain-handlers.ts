import type { CreateHandoffInput, HandoffState, InboxSelector } from "../handoff/types.js";
import { asDatabase } from "../memory/database.js";
import { MemoryDomain } from "../memory/domain.js";
import type {
  ArtifactInput,
  CommitMemoryInput,
  ContextPackInput,
  GraphEdgeInput,
  GraphNodeInput,
  MemoryKind,
  MemorySourceInput,
  SearchMemoryInput,
  Sensitivity,
  SessionSnapshotInput
} from "../memory/types.js";
import {
  boundedNumber,
  optionalString,
  parseScope,
  positiveInteger,
  requireRecord,
  requireString
} from "../memory/validation.js";

export type DomainRpcHandler = (params: unknown, context?: unknown) => unknown | Promise<unknown>;

export interface DomainDispatcher {
  register(method: string, handler: DomainRpcHandler): unknown;
}

export interface DomainStoreOwner {
  database: unknown;
}

const cachedHandlers = new WeakMap<object, Record<string, DomainRpcHandler>>();

/**
 * Core daemon integration point. `Store.database` is the sole production
 * writer; MCP and CLI clients reach these methods only through daemon RPC.
 */
export function createDomainHandlers(store: DomainStoreOwner): Record<string, DomainRpcHandler> {
  const cached = cachedHandlers.get(store);
  if (cached) return cached;
  const domain = new MemoryDomain(asDatabase(store.database));
  const handlers: Record<string, DomainRpcHandler> = {
    "memory.commit": (params) => domain.commitMemory(parseCommitMemory(params)),
    "memory.get": (params) => domain.memories.get(requireId(params, "memoryId")),
    "memory.search": (params) => domain.searchMemory(parseSearchMemory(params)),
    "memory.mutations": (params) => {
      const record = requireRecord(params);
      return domain.memories.mutationsAfter({
        afterCursor: nonNegativeInteger(record.afterCursor, "afterCursor"),
        ...(record.limit !== undefined ? { limit: positiveInteger(record.limit, "limit", 100, 500) } : {}),
        ...(record.scope !== undefined ? { scope: parseScope(record.scope) } : {})
      });
    },
    "memory.supersede": (params) => {
      const record = requireRecord(params);
      return domain.supersedeMemory(
        requireString(record.memoryId, "memoryId"),
        parseCommitMemory(record.replacement)
      );
    },
    "memory.forget": (params) => ({ forgotten: domain.memories.forget(requireId(params, "memoryId")) }),

    "graph.node.upsert": (params) => domain.graph.upsertNode(parseGraphNode(params)),
    "graph.node.get": (params) => domain.graph.getNode(requireId(params, "nodeId")),
    "graph.edge.add": (params) => domain.graph.addEdge(parseGraphEdge(params)),
    "graph.neighbors": (params) => {
      const record = requireRecord(params);
      const edgeTypes = stringArray(record.edgeTypes, "edgeTypes");
      const direction = optionalString(record.direction, "direction");
      if (direction && !new Set(["in", "out", "both"]).has(direction)) {
        throw new Error("direction must be in, out, or both");
      }
      return domain.graph.neighbors(requireString(record.nodeId, "nodeId"), {
        ...(direction ? { direction: direction as "in" | "out" | "both" } : {}),
        ...(edgeTypes ? { edgeTypes } : {}),
        ...(record.limit !== undefined ? { limit: positiveInteger(record.limit, "limit", 50, 250) } : {})
      });
    },

    "artifact.publish": (params) => domain.publishArtifact(parseArtifact(params)),
    "artifact.get": (params) => {
      const record = requireRecord(params);
      return domain.artifacts.get(
        requireString(record.artifactId, "artifactId"),
        record.includeContent === true
      );
    },
    "artifact.list": (params) => {
      const record = requireRecord(params);
      return domain.artifacts.list(
        parseScope(record.scope),
        positiveInteger(record.limit, "limit", 20, 100)
      );
    },

    "session.snapshot.upsert": (params) => domain.upsertSnapshot(parseSnapshot(params)),
    "session.snapshot.get": (params) => domain.snapshots.get(requireId(params, "sessionId")),
    "context.pack": (params) => domain.contextPack(parseContextPack(params)),

    "handoff.create": (params) => domain.createHandoff(parseCreateHandoff(params)),
    "handoff.get": (params) => domain.handoffs.get(requireId(params, "handoffId")),
    "handoff.list": (params) => {
      const record = params === undefined ? {} : requireRecord(params);
      return domain.handoffs.list({
        ...(optionalString(record.fromSession, "fromSession") ? { fromSession: String(record.fromSession) } : {}),
        ...(stringArray(record.states, "states") ? { states: parseStates(record.states) } : {}),
        ...(record.limit !== undefined ? { limit: positiveInteger(record.limit, "limit", 50, 200) } : {})
      });
    },
    "handoff.inbox": (params) => domain.handoffs.inbox(parseInbox(params)),
    "handoff.deliver": (params) => {
      const record = requireRecord(params);
      return domain.handoffs.deliver(
        requireString(record.handoffId, "handoffId"),
        requireString(record.actorSession, "actorSession"),
        optionalString(record.detail, "detail")
      );
    },
    "handoff.acknowledge": (params) => transitionParams(params, domain.handoffs.acknowledge.bind(domain.handoffs)),
    "handoff.claim": (params) => transitionParams(params, domain.handoffs.claim.bind(domain.handoffs)),
    "handoff.start": (params) => transitionParams(params, domain.handoffs.start.bind(domain.handoffs)),
    "handoff.complete": (params) => {
      const record = requireRecord(params);
      return domain.handoffs.complete(
        requireString(record.handoffId, "handoffId"),
        requireString(record.actorSession, "actorSession"),
        optionalString(record.resultSummary, "resultSummary"),
        stringArray(record.artifactRefs, "artifactRefs") ?? []
      );
    },
    "handoff.fail": (params) => {
      const record = requireRecord(params);
      return domain.handoffs.fail(
        requireString(record.handoffId, "handoffId"),
        requireString(record.actorSession, "actorSession"),
        requireString(record.error, "error")
      );
    },
    "handoff.decline": (params) => {
      const record = requireRecord(params);
      return domain.handoffs.decline(
        requireString(record.handoffId, "handoffId"),
        requireString(record.actorSession, "actorSession"),
        optionalString(record.reason, "reason")
      );
    },
    "handoff.cancel": (params) => {
      const record = requireRecord(params);
      return domain.handoffs.cancel(
        requireString(record.handoffId, "handoffId"),
        requireString(record.actorSession, "actorSession"),
        optionalString(record.reason, "reason")
      );
    },
    "handoff.deliveries": (params) => domain.handoffs.deliveries(requireId(params, "handoffId"))
  };
  cachedHandlers.set(store, handlers);
  return handlers;
}

export function registerDomainHandlers(dispatcher: DomainDispatcher, store: DomainStoreOwner): void {
  for (const [method, handler] of Object.entries(createDomainHandlers(store))) {
    dispatcher.register(method, handler);
  }
}

function parseCommitMemory(value: unknown): CommitMemoryInput {
  const record = requireRecord(value);
  const kind = requireString(record.kind, "kind") as MemoryKind;
  const allowedKinds = new Set([
    "fact",
    "decision",
    "constraint",
    "preference",
    "procedure",
    "open_question",
    "warning",
    "session_summary",
    "handoff_summary"
  ]);
  if (!allowedKinds.has(kind)) throw new Error(`Unsupported memory kind: ${kind}`);
  const sources = parseSources(record.sources);
  const sensitivity = optionalString(record.sensitivity, "sensitivity") as Sensitivity | undefined;
  if (sensitivity && !new Set(["public", "private", "secret"]).has(sensitivity)) {
    throw new Error(`Unsupported sensitivity: ${sensitivity}`);
  }
  return {
    kind,
    text: requireString(record.text, "text"),
    scope: parseScope(record.scope),
    ...(optionalString(record.sourceSessionId, "sourceSessionId")
      ? { sourceSessionId: String(record.sourceSessionId) }
      : {}),
    ...(sources ? { sources } : {}),
    ...(record.confidence !== undefined
      ? { confidence: boundedNumber(record.confidence, "confidence", 0.8) }
      : {}),
    ...(record.importance !== undefined
      ? { importance: boundedNumber(record.importance, "importance", 0.5) }
      : {}),
    ...(sensitivity ? { sensitivity } : {}),
    ...(optionalString(record.expiresAt, "expiresAt") ? { expiresAt: String(record.expiresAt) } : {}),
    ...(isRecord(record.metadata) ? { metadata: record.metadata } : {})
  };
}

function parseSearchMemory(value: unknown): SearchMemoryInput {
  const record = requireRecord(value);
  const kinds = stringArray(record.kinds, "kinds") as MemoryKind[] | undefined;
  return {
    query: typeof record.query === "string" ? record.query : "",
    scope: parseScope(record.scope),
    ...(record.includeGlobal === true ? { includeGlobal: true } : {}),
    ...(record.includeSecret === true ? { includeSecret: true } : {}),
    ...(kinds ? { kinds } : {}),
    ...(record.limit !== undefined ? { limit: positiveInteger(record.limit, "limit", 10, 100) } : {}),
    ...(optionalString(record.now, "now") ? { now: String(record.now) } : {})
  };
}

function parseGraphNode(value: unknown): GraphNodeInput {
  const record = requireRecord(value);
  return {
    ...(optionalString(record.id, "id") ? { id: String(record.id) } : {}),
    type: requireString(record.type, "type"),
    canonicalKey: requireString(record.canonicalKey, "canonicalKey"),
    label: requireString(record.label, "label"),
    scope: parseScope(record.scope),
    ...(isRecord(record.metadata) ? { metadata: record.metadata } : {})
  };
}

function parseGraphEdge(value: unknown): GraphEdgeInput {
  const record = requireRecord(value);
  return {
    ...(optionalString(record.id, "id") ? { id: String(record.id) } : {}),
    fromNodeId: requireString(record.fromNodeId, "fromNodeId"),
    toNodeId: requireString(record.toNodeId, "toNodeId"),
    type: requireString(record.type, "type"),
    ...(optionalString(record.evidenceEventId, "evidenceEventId")
      ? { evidenceEventId: String(record.evidenceEventId) }
      : {}),
    ...(record.confidence !== undefined
      ? { confidence: boundedNumber(record.confidence, "confidence", 0.8) }
      : {}),
    ...(optionalString(record.validFrom, "validFrom") ? { validFrom: String(record.validFrom) } : {}),
    ...(optionalString(record.validUntil, "validUntil") ? { validUntil: String(record.validUntil) } : {}),
    ...(isRecord(record.metadata) ? { metadata: record.metadata } : {})
  };
}

function parseArtifact(value: unknown): ArtifactInput {
  const record = requireRecord(value);
  const sensitivity = optionalString(record.sensitivity, "sensitivity") as Sensitivity | undefined;
  return {
    name: requireString(record.name, "name"),
    scope: parseScope(record.scope),
    ...(optionalString(record.mediaType, "mediaType") ? { mediaType: String(record.mediaType) } : {}),
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(optionalString(record.contentRef, "contentRef") ? { contentRef: String(record.contentRef) } : {}),
    ...(optionalString(record.sourceSessionId, "sourceSessionId")
      ? { sourceSessionId: String(record.sourceSessionId) }
      : {}),
    ...(optionalString(record.sourceEventId, "sourceEventId") ? { sourceEventId: String(record.sourceEventId) } : {}),
    ...(sensitivity ? { sensitivity } : {}),
    ...(isRecord(record.metadata) ? { metadata: record.metadata } : {})
  };
}

function parseSnapshot(value: unknown): SessionSnapshotInput {
  const record = requireRecord(value);
  return {
    sessionId: requireString(record.sessionId, "sessionId"),
    scope: parseScope(record.scope),
    ...(optionalString(record.activity, "activity") ? { activity: String(record.activity) } : {}),
    ...(optionalString(record.objective, "objective") ? { objective: String(record.objective) } : {}),
    ...(optionalString(record.summary, "summary") ? { summary: String(record.summary) } : {}),
    ...(optionalString(record.sourceEventId, "sourceEventId") ? { sourceEventId: String(record.sourceEventId) } : {}),
    ...(isRecord(record.metadata) ? { metadata: record.metadata } : {})
  };
}

function parseContextPack(value: unknown): ContextPackInput {
  const record = requireRecord(value);
  return {
    scope: parseScope(record.scope),
    ...(typeof record.query === "string" ? { query: record.query } : {}),
    ...(record.includeGlobal === true ? { includeGlobal: true } : {}),
    ...(optionalString(record.sessionId, "sessionId") ? { sessionId: String(record.sessionId) } : {}),
    ...(optionalString(record.provider, "provider") ? { provider: String(record.provider) } : {}),
    ...(record.maxBytes !== undefined
      ? { maxBytes: positiveInteger(record.maxBytes, "maxBytes", 16 * 1024, 1024 * 1024) }
      : {}),
    ...(record.maxApproxTokens !== undefined
      ? { maxApproxTokens: positiveInteger(record.maxApproxTokens, "maxApproxTokens", 4096, 262_144) }
      : {}),
    ...(record.memoryLimit !== undefined
      ? { memoryLimit: positiveInteger(record.memoryLimit, "memoryLimit", 12, 100) }
      : {})
  };
}

function parseCreateHandoff(value: unknown): CreateHandoffInput {
  const record = requireRecord(value);
  const targetRecord = requireRecord(record.target, "target");
  const target = {
    ...(optionalString(targetRecord.sessionId, "target.sessionId") ? { sessionId: String(targetRecord.sessionId) } : {}),
    ...(optionalString(targetRecord.provider, "target.provider") ? { provider: String(targetRecord.provider) } : {}),
    ...(optionalString(targetRecord.repository, "target.repository")
      ? { repository: String(targetRecord.repository) }
      : {}),
    ...(optionalString(targetRecord.capability, "target.capability")
      ? { capability: String(targetRecord.capability) }
      : {})
  };
  const deliveryMode = optionalString(record.deliveryMode, "deliveryMode") as CreateHandoffInput["deliveryMode"];
  if (deliveryMode && !new Set(["next_turn", "manual_pull", "immediate_managed", "preview_channel"]).has(deliveryMode)) {
    throw new Error(`Unsupported deliveryMode: ${deliveryMode}`);
  }
  const contextRefs = stringArray(record.contextRefs, "contextRefs");
  const artifactRefs = stringArray(record.artifactRefs, "artifactRefs");
  const causalChain = stringArray(record.causalChain, "causalChain");
  return {
    fromSession: requireString(record.fromSession, "fromSession"),
    target,
    objective: requireString(record.objective, "objective"),
    ...(contextRefs ? { contextRefs } : {}),
    ...(artifactRefs ? { artifactRefs } : {}),
    ...(deliveryMode ? { deliveryMode } : {}),
    ...(typeof record.requiresAck === "boolean" ? { requiresAck: record.requiresAck } : {}),
    ...(causalChain ? { causalChain } : {}),
    ...(typeof record.hopCount === "number" ? { hopCount: record.hopCount } : {}),
    ...(typeof record.maxHops === "number" ? { maxHops: record.maxHops } : {}),
    ...(optionalString(record.expiresAt, "expiresAt") ? { expiresAt: String(record.expiresAt) } : {})
  };
}

function parseInbox(value: unknown): InboxSelector {
  const record = requireRecord(value);
  return {
    sessionId: requireString(record.sessionId, "sessionId"),
    ...(optionalString(record.provider, "provider") ? { provider: String(record.provider) } : {}),
    ...(optionalString(record.repository, "repository") ? { repository: String(record.repository) } : {}),
    ...(stringArray(record.states, "states") ? { states: parseStates(record.states) } : {}),
    ...(record.limit !== undefined ? { limit: positiveInteger(record.limit, "limit", 25, 100) } : {})
  };
}

function parseStates(value: unknown): HandoffState[] {
  const states = stringArray(value, "states") ?? [];
  const allowed = new Set([
    "created",
    "queued",
    "delivered",
    "acknowledged",
    "claimed",
    "running",
    "completed",
    "failed",
    "expired",
    "cancelled",
    "declined"
  ]);
  for (const state of states) if (!allowed.has(state)) throw new Error(`Unsupported handoff state: ${state}`);
  return states as HandoffState[];
}

function parseSources(value: unknown): MemorySourceInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("sources must be an array");
  return value.map((item, index) => {
    const source = requireRecord(item, `sources[${index}]`);
    const type = requireString(source.type, `sources[${index}].type`) as MemorySourceInput["type"];
    if (!new Set(["event", "session", "artifact", "user", "agent", "file"]).has(type)) {
      throw new Error(`Unsupported memory source type: ${type}`);
    }
    return {
      type,
      id: requireString(source.id, `sources[${index}].id`),
      ...(optionalString(source.excerpt, `sources[${index}].excerpt`) ? { excerpt: String(source.excerpt) } : {})
    };
  });
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function transitionParams(
  value: unknown,
  transition: (handoffId: string, actorSession: string) => unknown
): unknown {
  const record = requireRecord(value);
  return transition(
    requireString(record.handoffId, "handoffId"),
    requireString(record.actorSession, "actorSession")
  );
}

function requireId(value: unknown, key: string): string {
  const record = requireRecord(value);
  return requireString(record[key], key);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
