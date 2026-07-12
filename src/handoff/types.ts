export type HandoffState =
  | "created"
  | "queued"
  | "delivered"
  | "acknowledged"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled"
  | "declined";

export type DeliveryMode = "next_turn" | "manual_pull" | "immediate_managed" | "preview_channel";

export interface HandoffTarget {
  sessionId?: string;
  provider?: string;
  repository?: string;
  capability?: string;
}

export interface CreateHandoffInput {
  fromSession: string;
  target: HandoffTarget;
  objective: string;
  contextRefs?: string[];
  artifactRefs?: string[];
  deliveryMode?: DeliveryMode;
  requiresAck?: boolean;
  causalChain?: string[];
  hopCount?: number;
  maxHops?: number;
  expiresAt?: string;
}

export interface Handoff {
  id: string;
  fromSession: string;
  target: HandoffTarget;
  objective: string;
  state: HandoffState;
  deliveryMode: DeliveryMode;
  requiresAck: boolean;
  contextRefs: string[];
  artifactRefs: string[];
  causalChain: string[];
  hopCount: number;
  maxHops: number;
  claimedBySession: string | null;
  resultSummary: string | null;
  error: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  claimedAt: string | null;
  completedAt: string | null;
}

export interface InboxSelector {
  sessionId: string;
  provider?: string;
  repository?: string;
  states?: HandoffState[];
  limit?: number;
}

export interface HandoffDelivery {
  id: string;
  handoffId: string;
  recipientSession: string | null;
  state: string;
  detail: string | null;
  createdAt: string;
}

