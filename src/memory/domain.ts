import { HandoffStore } from "../handoff/store.js";
import type { CreateHandoffInput, Handoff } from "../handoff/types.js";
import { ArtifactStore } from "./artifacts.js";
import { ContextPackBuilder } from "./context-pack.js";
import type { SqliteDatabase } from "./database.js";
import { GraphStore } from "./graph.js";
import { SessionSnapshotStore } from "./snapshots.js";
import { MemoryStore } from "./store.js";
import type {
  Artifact,
  ArtifactInput,
  CommitMemoryInput,
  ContextPack,
  ContextPackInput,
  GraphEdge,
  GraphNode,
  MemoryItem,
  SearchMemoryInput,
  SessionSnapshot,
  SessionSnapshotInput
} from "./types.js";

/** Facade used by daemon RPC handlers. It also owns deterministic projections. */
export class MemoryDomain {
  readonly memories: MemoryStore;
  readonly graph: GraphStore;
  readonly artifacts: ArtifactStore;
  readonly snapshots: SessionSnapshotStore;
  readonly handoffs: HandoffStore;
  readonly contextPacks: ContextPackBuilder;

  constructor(database: SqliteDatabase) {
    this.memories = new MemoryStore(database);
    this.graph = new GraphStore(database);
    this.artifacts = new ArtifactStore(database);
    this.snapshots = new SessionSnapshotStore(database);
    this.handoffs = new HandoffStore(database);
    this.contextPacks = new ContextPackBuilder(
      this.memories,
      this.handoffs,
      this.artifacts,
      this.snapshots
    );
  }

  commitMemory(input: CommitMemoryInput): MemoryItem {
    const memory = this.memories.commit(input);
    this.projectMemory(memory);
    return memory;
  }

  supersedeMemory(memoryId: string, replacement: CommitMemoryInput): MemoryItem {
    const memory = this.memories.supersede(memoryId, replacement);
    this.projectMemory(memory);
    const previous = this.graph.upsertNode({
      type: "Memory",
      canonicalKey: memoryId,
      label: `Superseded memory ${memoryId}`,
      scope: memory.scope,
      metadata: { status: "superseded" }
    });
    const next = this.graph.upsertNode({
      type: "Memory",
      canonicalKey: memory.id,
      label: memory.text.slice(0, 160),
      scope: memory.scope,
      metadata: { kind: memory.kind, status: memory.status }
    });
    this.graph.addEdge({
      fromNodeId: next.id,
      toNodeId: previous.id,
      type: "SUPERSEDES",
      confidence: 1
    });
    return memory;
  }

  searchMemory(input: SearchMemoryInput): MemoryItem[] {
    return this.memories.search(input);
  }

  publishArtifact(input: ArtifactInput): Artifact {
    const artifact = this.artifacts.publish(input);
    this.graph.upsertNode({
      type: "Artifact",
      canonicalKey: artifact.id,
      label: artifact.name,
      scope: artifact.scope,
      metadata: { sha256: artifact.sha256, mediaType: artifact.mediaType, contentRef: artifact.contentRef }
    });
    return artifact;
  }

  createHandoff(input: CreateHandoffInput): Handoff {
    const handoff = this.handoffs.create(input);
    const scopeKey = input.target.repository ?? "coordination";
    this.graph.upsertNode({
      type: "Handoff",
      canonicalKey: handoff.id,
      label: handoff.objective.slice(0, 160),
      scope: { kind: input.target.repository ? "repository" : "global", key: scopeKey },
      metadata: { fromSession: handoff.fromSession, state: handoff.state }
    });
    return handoff;
  }

  upsertSnapshot(input: SessionSnapshotInput): SessionSnapshot {
    const snapshot = this.snapshots.upsert(input);
    this.graph.upsertNode({
      type: "AgentSession",
      canonicalKey: snapshot.sessionId,
      label: snapshot.objective ?? snapshot.sessionId,
      scope: snapshot.scope,
      metadata: { activity: snapshot.activity, updatedAt: snapshot.updatedAt }
    });
    return snapshot;
  }

  contextPack(input: ContextPackInput): ContextPack {
    return this.contextPacks.build(input);
  }

  private projectMemory(memory: MemoryItem): void {
    const memoryNode = this.graph.upsertNode({
      type: "Memory",
      canonicalKey: memory.id,
      label: memory.text.slice(0, 160),
      scope: memory.scope,
      metadata: { kind: memory.kind, confidence: memory.confidence, status: memory.status }
    });
    for (const source of memory.sources) {
      const sourceNode = this.graph.upsertNode({
        type: source.type === "event" ? "Event" : source.type === "artifact" ? "Artifact" : "Source",
        canonicalKey: `${source.type}:${source.id}`,
        label: source.excerpt?.slice(0, 160) ?? `${source.type}:${source.id}`,
        scope: memory.scope,
        metadata: { sourceType: source.type, sourceId: source.id }
      });
      this.graph.addEdge({
        fromNodeId: memoryNode.id,
        toNodeId: sourceNode.id,
        type: "SUPPORTED_BY",
        ...(source.type === "event" ? { evidenceEventId: source.id } : {}),
        confidence: memory.confidence
      });
    }
  }
}

export type { GraphEdge, GraphNode };

