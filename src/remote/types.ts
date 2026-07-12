export type RemoteSensitivity = "public" | "team" | "private";

export type RemoteRecordType =
  | "memory"
  | "artifact"
  | "handoff"
  | "tombstone"
  | "supersession";

export interface RemoteNamespace {
  teamId: string;
  repositoryId: string;
}

export interface RemoteProvenance {
  source: string;
  sourceRecordId: string;
  occurredAt: string;
  originHostId?: string;
  originAgent?: string;
  originSessionId?: string;
  repositoryRevision?: string;
}

export interface RemoteRecordInput {
  idempotencyKey: string;
  type: RemoteRecordType;
  subjectId: string;
  payload: Record<string, unknown>;
  provenance: RemoteProvenance;
  sensitivity: RemoteSensitivity;
}

export interface RemoteRecord extends RemoteRecordInput, RemoteNamespace {
  /** Authenticated hub token identity. This value is always server-stamped. */
  actorTokenId: string;
  cursor: number;
  receivedAt: string;
}

export interface PushRequest extends RemoteNamespace {
  records: RemoteRecordInput[];
}

export interface PushResponse {
  accepted: number;
  duplicates: number;
  latestCursor: number;
  authenticatedActorTokenId: string;
}

export interface PullRequest extends RemoteNamespace {
  afterCursor: number;
  limit?: number;
  waitMs?: number;
}

export interface PullResponse extends RemoteNamespace {
  records: RemoteRecord[];
  latestCursor: number;
  authenticatedActorTokenId: string;
}

export interface AuthPrincipal {
  tokenId: string;
  teamId: string;
  repositoryIds: string[];
}

export interface Authenticator {
  authenticate(token: string, nowMs: number): AuthPrincipal | null | Promise<AuthPrincipal | null>;
}

export type RemoteClock = () => number;

export interface LocalSyncState extends RemoteNamespace {
  version: 1;
  cursor: number;
  pending: RemoteRecordInput[];
  publishedKeys: string[];
  inbox: RemoteRecord[];
  remoteBindings: Record<string, string>;
  authenticatedActorTokenId: string | null;
  /** Highest local memory mutation durably staged into the remote outbox. */
  localMutationCursor: number;
  updatedAt: string;
}

export interface RemoteSyncStatus {
  enabled: boolean;
  namespace: RemoteNamespace;
  statePath: string;
  cursor: number;
  pendingCount: number;
  inboxCount: number;
  updatedAt: string | null;
}
