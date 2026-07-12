import { stableJson } from "../util/ids.js";
import type {
  PullRequest,
  PushRequest,
  RemoteNamespace,
  RemoteProvenance,
  RemoteRecordInput,
  RemoteRecordType,
  RemoteSensitivity
} from "./types.js";

const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/;
const RECORD_TYPES = new Set<RemoteRecordType>([
  "memory", "artifact", "handoff", "tombstone", "supersession"
]);
const SENSITIVITIES = new Set<RemoteSensitivity>(["public", "team", "private"]);
const MEMORY_KINDS = new Set([
  "fact", "decision", "constraint", "preference", "procedure", "open_question",
  "warning", "session_summary", "handoff_summary"
]);
const ACTOR_TOKEN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class RemoteValidationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "RemoteValidationError";
    this.statusCode = statusCode;
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteValidationError(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new RemoteValidationError(`${name} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

export function validateActorTokenId(value: unknown): string {
  const actorTokenId = string(value, "actorTokenId", 128);
  if (!ACTOR_TOKEN_ID_PATTERN.test(actorTokenId)) {
    throw new RemoteValidationError("actorTokenId contains unsupported characters");
  }
  return actorTokenId;
}

function validateUnitInterval(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RemoteValidationError(`${name} must be a finite number between 0 and 1`, 422);
  }
  return value;
}

function validateMemoryPayload(value: unknown, name: string): void {
  const payload = record(value, name);
  const kind = string(payload.kind, `${name}.kind`, 64);
  if (!MEMORY_KINDS.has(kind)) {
    throw new RemoteValidationError(`${name}.kind is not a supported memory kind`, 422);
  }
  const textValue = string(payload.text, `${name}.text`, 65_536);
  if (Buffer.byteLength(textValue, "utf8") > 64 * 1024) {
    throw new RemoteValidationError(`${name}.text must be at most 64 KiB`, 422);
  }
  validateUnitInterval(payload.confidence, `${name}.confidence`);
  validateUnitInterval(payload.importance, `${name}.importance`);
  if (payload.expiresAt !== null) {
    const expiresAt = string(payload.expiresAt, `${name}.expiresAt`, 64);
    if (!Number.isFinite(Date.parse(expiresAt))) {
      throw new RemoteValidationError(`${name}.expiresAt must be null or a valid date-time`, 422);
    }
  }
}

function assertBoundedJson(value: unknown, name: string): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 10_000 || current.depth > 32) {
      throw new RemoteValidationError(`${name} is too deeply nested or complex`);
    }
    if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      throw new RemoteValidationError(`${name} contains a non-finite number`);
    }
    if (["undefined", "function", "symbol", "bigint"].includes(typeof current.value)) {
      throw new RemoteValidationError(`${name} contains a value that cannot be represented as JSON`);
    }
    if (current.value !== null && typeof current.value === "object") {
      const values = Array.isArray(current.value)
        ? current.value
        : Object.values(current.value as Record<string, unknown>);
      for (const child of values) pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

export function validateNamespace(value: unknown): RemoteNamespace {
  const input = record(value, "namespace");
  const teamId = string(input.teamId, "teamId", 128);
  const repositoryId = string(input.repositoryId, "repositoryId", 128);
  for (const [name, part] of [["teamId", teamId], ["repositoryId", repositoryId]] as const) {
    if (!NAMESPACE_PATTERN.test(part) || part.includes("..")) {
      throw new RemoteValidationError(`${name} contains unsupported characters`);
    }
  }
  return { teamId, repositoryId };
}

function validateProvenance(value: unknown): RemoteProvenance {
  const input = record(value, "provenance");
  const occurredAt = string(input.occurredAt, "provenance.occurredAt", 64);
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new RemoteValidationError("provenance.occurredAt must be an ISO date-time");
  }
  const result: RemoteProvenance = {
    source: string(input.source, "provenance.source", 128),
    sourceRecordId: string(input.sourceRecordId, "provenance.sourceRecordId", 256),
    occurredAt: new Date(occurredAt).toISOString()
  };
  for (const key of ["originHostId", "originAgent", "originSessionId", "repositoryRevision"] as const) {
    const item = input[key];
    if (item !== undefined) result[key] = string(item, `provenance.${key}`, 256);
  }
  return result;
}

export function validateRemoteRecord(value: unknown, maxRecordBytes = 128 * 1024): RemoteRecordInput {
  const input = record(value, "record");
  const idempotencyKey = string(input.idempotencyKey, "idempotencyKey", 256);
  if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new RemoteValidationError("idempotencyKey must contain 16-256 stable identifier characters");
  }
  if (input.sensitivity === "secret") {
    throw new RemoteValidationError("secret records are local-only and can never be synchronized", 422);
  }
  if (!SENSITIVITIES.has(input.sensitivity as RemoteSensitivity)) {
    throw new RemoteValidationError("sensitivity must be public, team, or private");
  }
  if (!RECORD_TYPES.has(input.type as RemoteRecordType)) {
    throw new RemoteValidationError("unsupported record type");
  }
  const payload = record(input.payload, "payload");
  assertBoundedJson(payload, "payload");
  const type = input.type as RemoteRecordType;
  if (type === "memory") {
    validateMemoryPayload(payload, "payload");
  }
  if (type === "supersession") {
    string(payload.supersedesId, "payload.supersedesId", 256);
    validateMemoryPayload(payload.replacement, "payload.replacement");
  }
  if (type === "tombstone" && payload.reason !== undefined) {
    string(payload.reason, "payload.reason", 1_024);
  }
  const result: RemoteRecordInput = {
    idempotencyKey,
    type,
    subjectId: string(input.subjectId, "subjectId", 256),
    payload,
    provenance: validateProvenance(input.provenance),
    sensitivity: input.sensitivity as RemoteSensitivity
  };
  if (Buffer.byteLength(stableJson(result), "utf8") > maxRecordBytes) {
    throw new RemoteValidationError("record exceeds the maximum serialized size", 413);
  }
  return result;
}

export function validatePushRequest(value: unknown, maxRecords = 100): PushRequest {
  const input = record(value, "push request");
  const namespace = validateNamespace(input);
  if (!Array.isArray(input.records) || input.records.length === 0 || input.records.length > maxRecords) {
    throw new RemoteValidationError(`records must contain between 1 and ${maxRecords} items`);
  }
  return { ...namespace, records: input.records.map((item) => validateRemoteRecord(item)) };
}

export function validatePullRequest(value: unknown, maxLimit = 500, maxWaitMs = 25_000): PullRequest {
  const input = record(value, "pull request");
  const namespace = validateNamespace(input);
  const afterCursor = input.afterCursor;
  if (!Number.isSafeInteger(afterCursor) || (afterCursor as number) < 0) {
    throw new RemoteValidationError("afterCursor must be a non-negative safe integer");
  }
  const limit = input.limit === undefined ? 100 : input.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > maxLimit) {
    throw new RemoteValidationError(`limit must be between 1 and ${maxLimit}`);
  }
  const waitMs = input.waitMs === undefined ? 0 : input.waitMs;
  if (!Number.isInteger(waitMs) || (waitMs as number) < 0 || (waitMs as number) > maxWaitMs) {
    throw new RemoteValidationError(`waitMs must be between 0 and ${maxWaitMs}`);
  }
  return { ...namespace, afterCursor: afterCursor as number, limit: limit as number, waitMs: waitMs as number };
}

export function assertAuthorizedNamespace(
  principal: { teamId: string; repositoryIds: string[] },
  namespace: RemoteNamespace
): void {
  const repositoryAllowed = principal.repositoryIds.includes("*") ||
    principal.repositoryIds.includes(namespace.repositoryId);
  if (principal.teamId !== namespace.teamId || !repositoryAllowed) {
    throw new RemoteValidationError("token is not authorized for this team/repository namespace", 403);
  }
}
