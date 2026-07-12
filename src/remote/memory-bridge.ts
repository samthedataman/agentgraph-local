import { rpc } from "../ipc/client.js";
import type {
  CommitMemoryInput,
  MemoryItem,
  MemoryMutation,
  MemoryMutationBatch,
  MemoryScope,
  Sensitivity
} from "../memory/types.js";
import type { RemoteSyncClient } from "./client.js";
import type { RemoteProvenance, RemoteRecord, RemoteRecordInput } from "./types.js";
import { makeRemoteIdempotencyKey } from "./client.js";

export type RemoteRpcCall = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export interface MemoryBridgeOptions {
  rpcCall?: RemoteRpcCall;
  originHostId: string;
  originAgent?: string;
  originSessionId?: string;
  sharePrivate?: boolean;
  localScope?: MemoryScope;
}

export interface ExportMemoryOptions {
  query?: string;
  scope: MemoryScope;
  includeGlobal?: boolean;
  limit?: number;
}

export interface StageMemoryMutationsOptions {
  scope: MemoryScope;
  pageSize?: number;
  maxPages?: number;
}

export interface StageMemoryMutationsResult {
  scanned: number;
  staged: number;
  cursor: number;
  hasMore: boolean;
}

export interface ApplyInboxResult {
  applied: number;
  skipped: number;
  failed: Array<{ cursor: number; error: string }>;
}

interface RemoteMemoryPayload extends Record<string, unknown> {
  kind: CommitMemoryInput["kind"];
  text: string;
  confidence: number;
  importance: number;
  expiresAt: string | null;
}

function isMemoryPayload(value: Record<string, unknown>): value is Record<string, unknown> & RemoteMemoryPayload {
  return typeof value.kind === "string" && typeof value.text === "string" &&
    typeof value.confidence === "number" && typeof value.importance === "number" &&
    (value.expiresAt === null || typeof value.expiresAt === "string");
}

export class RemoteMemoryBridge {
  private readonly rpcCall: RemoteRpcCall;
  private readonly options: MemoryBridgeOptions;

  constructor(options: MemoryBridgeOptions) {
    if (!options.originHostId) throw new Error("originHostId is required for synchronized-memory provenance");
    this.options = options;
    this.rpcCall = options.rpcCall ?? rpc;
  }

  async exportMemories(options: ExportMemoryOptions): Promise<RemoteRecordInput[]> {
    const memories = await this.rpcCall<MemoryItem[]>("memory.search", {
      query: options.query ?? "",
      scope: options.scope,
      includeGlobal: options.includeGlobal === true,
      includeSecret: false,
      limit: options.limit ?? 100
    });
    return memories.flatMap((memory) => {
      const mapped = this.memoryToRecord(memory);
      return mapped ? [mapped] : [];
    });
  }

  /**
   * Stage durable local memory mutations into the client's pending queue. The
   * client advances its local outbox cursor in the same locked state write that
   * stores the derived remote records, so a crash cannot silently skip a local
   * mutation. A bounded number of pages is processed per sync cycle.
   */
  async stageMemoryMutations(
    client: RemoteSyncClient,
    options: StageMemoryMutationsOptions
  ): Promise<StageMemoryMutationsResult> {
    const pageSize = boundedInteger(options.pageSize ?? 100, "pageSize", 1, 500);
    const maxPages = boundedInteger(options.maxPages ?? 20, "maxPages", 1, 100);
    let cursor = client.getLocalMutationCursor();
    let scanned = 0;
    let staged = 0;
    let hasMore = false;
    for (let page = 0; page < maxPages; page += 1) {
      const batch = await this.rpcCall<MemoryMutationBatch>("memory.mutations", {
        afterCursor: cursor,
        limit: pageSize,
        scope: options.scope
      });
      validateMutationBatch(batch, cursor);
      const records: RemoteRecordInput[] = [];
      for (const mutation of batch.mutations) {
        scanned += 1;
        if (!sameScope(mutation.memory.scope, options.scope)) continue;
        const mapped = this.mutationToRecords(mutation);
        records.push(...mapped);
      }
      staged += client.stageLocalMutations(records, batch.nextCursor);
      cursor = batch.nextCursor;
      hasMore = batch.hasMore;
      if (!batch.hasMore || batch.mutations.length === 0) break;
    }
    return { scanned, staged, cursor, hasMore };
  }

  memoryToRecord(memory: MemoryItem): RemoteRecordInput | null {
    // This check is deliberately independent of the daemon query flag. It is
    // the final fail-closed boundary preventing secret synchronization.
    if (memory.sensitivity === "secret") return null;
    if (memory.sensitivity === "private" && this.options.sharePrivate !== true) return null;
    if (memory.metadata.remoteSync !== undefined) return null;
    const provenance: RemoteProvenance = {
      source: "agentgraph-local-memory",
      sourceRecordId: memory.id,
      occurredAt: memory.updatedAt,
      originHostId: this.options.originHostId,
      ...(this.options.originAgent ? { originAgent: this.options.originAgent } : {}),
      ...(this.options.originSessionId ? { originSessionId: this.options.originSessionId } : {})
    };
    const withoutId: Omit<RemoteRecordInput, "idempotencyKey"> = {
      type: memory.status === "deleted" ? "tombstone" : "memory",
      subjectId: memory.id,
      payload: memory.status === "deleted" ? { reason: "deleted at origin" } : {
        kind: memory.kind,
        text: memory.text,
        confidence: memory.confidence,
        importance: memory.importance,
        expiresAt: memory.expiresAt
      },
      provenance,
      sensitivity: memory.sensitivity === "public" ? "public" : "private"
    };
    return { ...withoutId, idempotencyKey: makeRemoteIdempotencyKey(withoutId) };
  }

  mutationToRecords(mutation: MemoryMutation): RemoteRecordInput[] {
    const memory = mutation.memory;
    if (memory.sensitivity === "secret") {
      if (mutation.operation === "supersede" && deletableRemoteCandidate(mutation.supersedes)) {
        return [this.tombstoneForMutation(mutation, mutation.supersedes!.id, "superseded by a local-only memory")];
      }
      return [];
    }
    if (memory.metadata.remoteSync !== undefined || mutation.supersedes?.metadata.remoteSync !== undefined) return [];
    // Deletions carry only an opaque subject id. Emit them for private items
    // too: this lets a team remove a private memory that was shared during an
    // earlier --share-private run even if that flag is no longer enabled.
    if (mutation.operation === "delete") {
      return [this.tombstoneForMutation(mutation, memory.id, "deleted at origin")];
    }
    if (memory.sensitivity === "private" && this.options.sharePrivate !== true) {
      if (mutation.operation === "supersede" && deletableRemoteCandidate(mutation.supersedes)) {
        return [this.tombstoneForMutation(mutation, mutation.supersedes!.id, "superseded by a private memory")];
      }
      return [];
    }
    if (mutation.operation === "supersede") {
      const supersedes = mutation.supersedes;
      if (!supersedes || !mutation.supersedesMemoryId) return [];
      if (!shareableMutationMemory(supersedes, this.options.sharePrivate)) {
        const provenance = this.mutationProvenance(mutation);
        const withoutId: Omit<RemoteRecordInput, "idempotencyKey"> = {
          type: "memory",
          subjectId: memory.id,
          payload: memoryPayload(memory),
          provenance,
          sensitivity: remoteSensitivity(memory.sensitivity)
        };
        return [{ ...withoutId, idempotencyKey: makeRemoteIdempotencyKey(withoutId) }];
      }
      const provenance = this.mutationProvenance(mutation);
      const withoutId: Omit<RemoteRecordInput, "idempotencyKey"> = {
        type: "supersession",
        subjectId: memory.id,
        payload: {
          supersedesId: mutation.supersedesMemoryId,
          replacement: memoryPayload(memory)
        },
        provenance,
        sensitivity: remoteSensitivity(memory.sensitivity)
      };
      return [{ ...withoutId, idempotencyKey: makeRemoteIdempotencyKey(withoutId) }];
    }
    // Backfilled non-current snapshots are history, not new current memories.
    if (memory.status !== "current") return [];
    const provenance = this.mutationProvenance(mutation);
    const withoutId: Omit<RemoteRecordInput, "idempotencyKey"> = {
      type: "memory",
      subjectId: memory.id,
      payload: memoryPayload(memory),
      provenance,
      sensitivity: remoteSensitivity(memory.sensitivity)
    };
    return [{ ...withoutId, idempotencyKey: makeRemoteIdempotencyKey(withoutId) }];
  }

  private mutationProvenance(mutation: MemoryMutation): RemoteProvenance {
    return {
      source: "agentgraph-local-memory-outbox",
      sourceRecordId: mutation.mutationId,
      occurredAt: mutation.createdAt,
      originHostId: this.options.originHostId,
      ...(this.options.originAgent ? { originAgent: this.options.originAgent } : {}),
      ...(this.options.originSessionId ? { originSessionId: this.options.originSessionId } : {})
    };
  }

  private tombstoneForMutation(mutation: MemoryMutation, subjectId: string, reason: string): RemoteRecordInput {
    const withoutId: Omit<RemoteRecordInput, "idempotencyKey"> = {
      type: "tombstone",
      subjectId,
      payload: { reason },
      provenance: this.mutationProvenance(mutation),
      sensitivity: "team"
    };
    return { ...withoutId, idempotencyKey: makeRemoteIdempotencyKey(withoutId) };
  }

  async applyInbox(client: RemoteSyncClient): Promise<ApplyInboxResult> {
    const result: ApplyInboxResult = { applied: 0, skipped: 0, failed: [] };
    for (const record of client.readInbox()) {
      try {
        const localId = await this.applyRecord(client, record);
        if (localId === null) result.skipped += 1;
        else result.applied += 1;
        if (localId !== null && (record.type === "memory" || record.type === "supersession")) {
          client.bindRemoteAndAcknowledge(
            record.actorTokenId,
            record.subjectId,
            localId,
            record.cursor
          );
        } else {
          client.acknowledgeInbox([record.cursor]);
        }
      } catch (error) {
        result.failed.push({ cursor: record.cursor, error: error instanceof Error ? error.message : String(error) });
        break;
      }
    }
    return result;
  }

  private async applyRecord(client: RemoteSyncClient, record: RemoteRecord): Promise<string | null> {
    if ((record.sensitivity as string) === "secret") return null;
    if (client.isOwnRecord(record)) return null;
    if (record.type === "memory") {
      if (!isMemoryPayload(record.payload)) throw new Error("remote memory payload is invalid");
      const existing = client.getRemoteBinding(record.actorTokenId, record.subjectId);
      if (existing) return existing;
      const committed = await this.rpcCall<MemoryItem>("memory.commit", {
        kind: record.payload.kind,
        text: record.payload.text,
        scope: this.options.localScope ?? { kind: "repository", key: client.namespace.repositoryId },
        confidence: record.payload.confidence,
        importance: record.payload.importance,
        ...(record.payload.expiresAt ? { expiresAt: record.payload.expiresAt } : {}),
        sensitivity: localSensitivity(record.sensitivity),
        sources: [{
          type: "agent",
          id: `remote-token:${record.actorTokenId}`,
          excerpt: `Untrusted remote peer memory ${record.idempotencyKey}`
        }],
        metadata: {
          trust: {
            level: "untrusted-peer",
            authenticatedActorTokenId: record.actorTokenId,
            claimedOriginAgent: record.provenance.originAgent ?? null,
            claimedOriginHostId: record.provenance.originHostId ?? null
          },
          remoteSync: {
            teamId: record.teamId,
            repositoryId: record.repositoryId,
            cursor: record.cursor,
            idempotencyKey: record.idempotencyKey,
            sourceRecordId: record.provenance.sourceRecordId,
            authenticatedActorTokenId: record.actorTokenId,
            trust: "untrusted-peer"
          }
        }
      });
      return committed.id;
    }
    if (record.type === "tombstone") {
      const localId = client.getRemoteBinding(record.actorTokenId, record.subjectId);
      if (!localId) return null;
      await this.rpcCall("memory.forget", { memoryId: localId });
      return localId;
    }
    if (record.type === "supersession") {
      const supersedesId = String(record.payload.supersedesId ?? "");
      const localId = client.getRemoteBinding(record.actorTokenId, supersedesId);
      const replacement = record.payload.replacement;
      if (!localId || replacement === null || typeof replacement !== "object" || Array.isArray(replacement)) return null;
      const replacementPayload = replacement as Record<string, unknown>;
      if (!isMemoryPayload(replacementPayload)) throw new Error("remote supersession replacement is invalid");
      const committed = await this.rpcCall<MemoryItem>("memory.supersede", {
        memoryId: localId,
        replacement: {
          kind: replacementPayload.kind,
          text: replacementPayload.text,
          scope: this.options.localScope ?? { kind: "repository", key: client.namespace.repositoryId },
          confidence: replacementPayload.confidence,
          importance: replacementPayload.importance,
          sensitivity: localSensitivity(record.sensitivity),
          metadata: {
            trust: {
              level: "untrusted-peer",
              authenticatedActorTokenId: record.actorTokenId
            },
            remoteSync: {
              cursor: record.cursor,
              idempotencyKey: record.idempotencyKey,
              authenticatedActorTokenId: record.actorTokenId,
              trust: "untrusted-peer"
            }
          }
        }
      });
      return committed.id;
    }
    // Artifact and handoff records need explicit product-level import policy;
    // this memory-only bridge acknowledges them without mutating local memory.
    return null;
  }
}

function localSensitivity(value: RemoteRecord["sensitivity"]): Sensitivity {
  return value === "public" ? "public" : "private";
}

function remoteSensitivity(value: Sensitivity): RemoteRecordInput["sensitivity"] {
  return value === "public" ? "public" : "private";
}

function memoryPayload(memory: MemoryItem): RemoteMemoryPayload {
  return {
    kind: memory.kind,
    text: memory.text,
    confidence: memory.confidence,
    importance: memory.importance,
    expiresAt: memory.expiresAt
  };
}

function shareableMutationMemory(memory: MemoryItem | null, sharePrivate: boolean | undefined): memory is MemoryItem {
  return memory !== null && memory.sensitivity !== "secret" &&
    memory.metadata.remoteSync === undefined &&
    (memory.sensitivity !== "private" || sharePrivate === true);
}

function deletableRemoteCandidate(memory: MemoryItem | null): memory is MemoryItem {
  return memory !== null && memory.sensitivity !== "secret" && memory.metadata.remoteSync === undefined;
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return left.kind === right.kind && left.key === right.key;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateMutationBatch(batch: MemoryMutationBatch, afterCursor: number): void {
  if (!Number.isSafeInteger(batch.nextCursor) || batch.nextCursor < afterCursor ||
      !Number.isSafeInteger(batch.latestCursor) || batch.latestCursor < batch.nextCursor ||
      !Array.isArray(batch.mutations) || typeof batch.hasMore !== "boolean") {
    throw new Error("memory mutation outbox returned an invalid cursor batch");
  }
  let cursor = afterCursor;
  for (const mutation of batch.mutations) {
    if (!Number.isSafeInteger(mutation.cursor) || mutation.cursor <= cursor) {
      throw new Error("memory mutation outbox returned a non-monotonic cursor");
    }
    cursor = mutation.cursor;
  }
  if (batch.mutations.length > 0 && cursor !== batch.nextCursor) {
    throw new Error("memory mutation outbox cursor does not match its final mutation");
  }
}
