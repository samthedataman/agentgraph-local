export type ScopeKind = "global" | "repository" | "worktree" | "session";

export interface MemoryScope {
  kind: ScopeKind;
  key: string;
}

export type MemoryKind =
  | "fact"
  | "decision"
  | "constraint"
  | "preference"
  | "procedure"
  | "open_question"
  | "warning"
  | "session_summary"
  | "handoff_summary";

export type Sensitivity = "public" | "private" | "secret";

export interface MemorySourceInput {
  type: "event" | "session" | "artifact" | "user" | "agent" | "file";
  id: string;
  excerpt?: string;
}

export interface CommitMemoryInput {
  kind: MemoryKind;
  text: string;
  scope: MemoryScope;
  sourceSessionId?: string;
  sources?: MemorySourceInput[];
  confidence?: number;
  importance?: number;
  sensitivity?: Sensitivity;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface MemorySource extends MemorySourceInput {
  memoryId: string;
}

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  text: string;
  scope: MemoryScope;
  sourceSessionId: string | null;
  sources: MemorySource[];
  confidence: number;
  importance: number;
  sensitivity: Sensitivity;
  status: "current" | "superseded" | "deleted";
  supersededBy: string | null;
  expiresAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  score?: number;
}

export type MemoryMutationOperation = "commit" | "delete" | "supersede";

/**
 * Immutable snapshot of a local memory mutation. `memory` is the committed
 * item for commit/delete and the replacement item for supersede.
 * `supersedes` is present only for supersede and contains the prior item after
 * its status was changed to `superseded`.
 */
export interface MemoryMutation {
  cursor: number;
  mutationId: string;
  operation: MemoryMutationOperation;
  memoryId: string;
  supersedesMemoryId: string | null;
  memory: MemoryItem;
  supersedes: MemoryItem | null;
  createdAt: string;
}

export interface ReadMemoryMutationsInput {
  afterCursor: number;
  limit?: number;
  scope?: MemoryScope;
}

export interface MemoryMutationBatch {
  mutations: MemoryMutation[];
  nextCursor: number;
  latestCursor: number;
  hasMore: boolean;
}

export interface SearchMemoryInput {
  query: string;
  scope: MemoryScope;
  includeGlobal?: boolean;
  includeSecret?: boolean;
  kinds?: MemoryKind[];
  limit?: number;
  now?: string;
}

export interface GraphNodeInput {
  id?: string;
  type: string;
  canonicalKey: string;
  label: string;
  scope: MemoryScope;
  metadata?: Record<string, unknown>;
}

export interface GraphNode {
  id: string;
  type: string;
  canonicalKey: string;
  label: string;
  scope: MemoryScope;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface GraphEdgeInput {
  id?: string;
  fromNodeId: string;
  toNodeId: string;
  type: string;
  evidenceEventId?: string;
  confidence?: number;
  validFrom?: string;
  validUntil?: string;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: string;
  evidenceEventId: string | null;
  confidence: number;
  validFrom: string;
  validUntil: string | null;
  metadata: Record<string, unknown>;
}

export interface ArtifactInput {
  name: string;
  scope: MemoryScope;
  mediaType?: string;
  content?: string;
  contentRef?: string;
  sourceSessionId?: string;
  sourceEventId?: string;
  sensitivity?: Sensitivity;
  metadata?: Record<string, unknown>;
}

export interface Artifact {
  id: string;
  name: string;
  scope: MemoryScope;
  mediaType: string;
  sha256: string;
  byteLength: number;
  contentRef: string;
  content?: string;
  sourceSessionId: string | null;
  sourceEventId: string | null;
  sensitivity: Sensitivity;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SessionSnapshotInput {
  sessionId: string;
  scope: MemoryScope;
  activity?: string;
  objective?: string;
  summary?: string;
  sourceEventId?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionSnapshot {
  sessionId: string;
  scope: MemoryScope;
  activity: string | null;
  objective: string | null;
  summary: string | null;
  sourceEventId: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface ContextPackInput {
  scope: MemoryScope;
  query?: string;
  includeGlobal?: boolean;
  sessionId?: string;
  provider?: string;
  maxBytes?: number;
  maxApproxTokens?: number;
  memoryLimit?: number;
}

export interface ContextPack {
  text: string;
  byteLength: number;
  approximateTokens: number;
  truncated: boolean;
  memoryIds: string[];
  handoffIds: string[];
  artifactIds: string[];
  generatedAt: string;
}
