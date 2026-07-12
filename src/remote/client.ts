import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256, stableJson } from "../util/ids.js";
import { getProcessStartToken, processMatches } from "../daemon/process-inspection.js";
import type {
  LocalSyncState,
  PullResponse,
  PushResponse,
  RemoteClock,
  RemoteNamespace,
  RemoteRecord,
  RemoteRecordInput,
  RemoteSyncStatus
} from "./types.js";
import { validateActorTokenId, validateNamespace, validateRemoteRecord } from "./validation.js";

export interface RemoteSyncClientOptions extends RemoteNamespace {
  enabled?: boolean;
  url: string;
  token: string;
  statePath: string;
  fetchFn?: typeof fetch;
  clock?: RemoteClock;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
}

export interface SyncOnceResult {
  pushed: number;
  duplicates: number;
  pulled: number;
  cursor: number;
  pending: number;
  inbox: number;
}

export interface SyncWatchOptions {
  signal?: AbortSignal;
  waitMs?: number;
  minimumBackoffMs?: number;
  maximumBackoffMs?: number;
  beforeSync?: () => RemoteRecordInput[] | Promise<RemoteRecordInput[]>;
  onSync?: (result: SyncOnceResult) => void | Promise<void>;
  onError?: (error: Error, retryInMs: number) => void | Promise<void>;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function validateRemoteUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("remote URL must not include credentials, query parameters, or a fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw new Error("remote sync requires HTTPS except for loopback development hubs");
  }
  return url;
}

export function makeRemoteIdempotencyKey(
  record: Omit<RemoteRecordInput, "idempotencyKey">
): string {
  return `sync_${sha256(stableJson(record))}`;
}

function initialState(namespace: RemoteNamespace, nowMs: number): LocalSyncState {
  return {
    version: 1,
    ...namespace,
    cursor: 0,
    pending: [],
    publishedKeys: [],
    inbox: [],
    remoteBindings: {},
    authenticatedActorTokenId: null,
    localMutationCursor: 0,
    updatedAt: new Date(nowMs).toISOString()
  };
}

interface StateLockRecord {
  pid: number;
  processStartToken: string;
  leaseToken: string;
  acquiredAt: string;
}

function acquireStateLock(statePath: string): () => void {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const lockPath = `${statePath}.lock`;
  const processStartToken = getProcessStartToken(process.pid);
  if (!processStartToken) throw new Error("could not determine process identity for remote state lock");
  const leaseToken = randomUUID();
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 3 && descriptor === undefined; attempt += 1) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      let before: ReturnType<typeof statSync> | undefined;
      try {
        before = statSync(lockPath);
        const record = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<StateLockRecord>;
        stale = Number.isInteger(record.pid) && Number(record.pid) > 0 &&
          typeof record.processStartToken === "string" && record.processStartToken.length > 0 &&
          !processMatches(Number(record.pid), record.processStartToken);
        const after = statSync(lockPath);
        stale = stale && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;
      } catch {
        // Corrupt or concurrently replaced locks fail closed.
        stale = false;
      }
      if (stale && attempt < 2) {
        try {
          const current = statSync(lockPath);
          if (before && current.ino === before.ino && current.size === before.size && current.mtimeMs === before.mtimeMs) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Retry acquisition when the stale lock disappeared concurrently.
          continue;
        }
      }
      throw new Error(`remote sync state is locked by another process: ${statePath}`);
    }
  }
  if (descriptor === undefined) throw new Error(`could not acquire remote sync state lock: ${statePath}`);
  const record: StateLockRecord = {
    pid: process.pid,
    processStartToken,
    leaseToken,
    acquiredAt: new Date().toISOString()
  };
  try {
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(lockPath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(lockPath); } catch { /* preserve the original failure */ }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<StateLockRecord>;
      if (current.leaseToken === leaseToken && current.pid === process.pid &&
          current.processStartToken === processStartToken) {
        unlinkSync(lockPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}

function atomicWrite(path: string, value: LocalSyncState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function parseState(path: string, namespace: RemoteNamespace, nowMs: number): LocalSyncState {
  if (!existsSync(path)) return initialState(namespace, nowMs);
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`remote sync state is unreadable: ${path}`);
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid remote sync state");
  const state = input as Partial<LocalSyncState>;
  if (state.version !== 1 || state.teamId !== namespace.teamId || state.repositoryId !== namespace.repositoryId) {
    throw new Error("remote sync state belongs to a different team/repository namespace");
  }
  if (!Number.isSafeInteger(state.cursor) || (state.cursor ?? -1) < 0 || !Array.isArray(state.pending) || !Array.isArray(state.inbox)) {
    throw new Error("invalid remote sync state fields");
  }
  if (state.remoteBindings === undefined) state.remoteBindings = {};
  if (state.publishedKeys === undefined) state.publishedKeys = [];
  if (state.localMutationCursor === undefined) state.localMutationCursor = 0;
  if (state.authenticatedActorTokenId === undefined) state.authenticatedActorTokenId = null;
  if (!Array.isArray(state.publishedKeys) || state.publishedKeys.some((item) => typeof item !== "string")) {
    throw new Error("invalid remote sync published keys");
  }
  if (state.remoteBindings === null || typeof state.remoteBindings !== "object" || Array.isArray(state.remoteBindings)) {
    throw new Error("invalid remote sync state bindings");
  }
  if (!Number.isSafeInteger(state.localMutationCursor) || (state.localMutationCursor ?? -1) < 0) {
    throw new Error("invalid remote sync local mutation cursor");
  }
  if (state.authenticatedActorTokenId !== null) {
    state.authenticatedActorTokenId = validateActorTokenId(state.authenticatedActorTokenId);
  }
  state.remoteBindings = Object.assign(Object.create(null) as Record<string, string>, state.remoteBindings);
  state.inbox = state.inbox.map((item) => ({
    ...item,
    actorTokenId: typeof (item as Partial<RemoteRecord>).actorTokenId === "string"
      ? validateActorTokenId((item as RemoteRecord).actorTokenId)
      : "legacy"
  }));
  return state as LocalSyncState;
}

function bindingKey(actorTokenId: string, remoteSubjectId: string): string {
  return `v2:${Buffer.from(JSON.stringify([actorTokenId, remoteSubjectId]), "utf8").toString("base64url")}`;
}

function enqueueIntoState(state: LocalSyncState, records: RemoteRecordInput[]): number {
  const checked = records.map((input) => validateRemoteRecord(input));
  const known = new Set([
    ...state.pending.map((item) => item.idempotencyKey),
    ...state.publishedKeys
  ]);
  let added = 0;
  for (const item of checked) {
    if (known.has(item.idempotencyKey)) continue;
    state.pending.push(item);
    known.add(item.idempotencyKey);
    added += 1;
  }
  return added;
}

function removeInboxCursors(state: LocalSyncState, selected: Set<number>): number {
  const before = state.inbox.length;
  state.inbox = state.inbox.filter((item) => !selected.has(item.cursor));
  return before - state.inbox.length;
}

export class RemoteSyncClient {
  readonly namespace: RemoteNamespace;
  readonly statePath: string;
  private readonly enabled: boolean;
  private readonly url: URL;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly clock: RemoteClock;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRequestBytes: number;

  constructor(options: RemoteSyncClientOptions) {
    this.namespace = validateNamespace(options);
    this.enabled = options.enabled === true;
    this.url = validateRemoteUrl(options.url);
    if (options.token.length < 24) throw new Error("remote bearer tokens must be at least 24 characters");
    this.token = options.token;
    this.statePath = resolve(options.statePath);
    this.fetchFn = options.fetchFn ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    this.maxRequestBytes = options.maxRequestBytes ?? 256 * 1024;
    for (const [name, value] of [["requestTimeoutMs", this.requestTimeoutMs], ["maxResponseBytes", this.maxResponseBytes], ["maxRequestBytes", this.maxRequestBytes]] as const) {
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    }
  }

  status(): RemoteSyncStatus {
    const exists = existsSync(this.statePath);
    const state = parseState(this.statePath, this.namespace, this.clock());
    return {
      enabled: this.enabled,
      namespace: this.namespace,
      statePath: this.statePath,
      cursor: state.cursor,
      pendingCount: state.pending.length,
      inboxCount: state.inbox.length,
      updatedAt: exists ? state.updatedAt : null
    };
  }

  enqueue(records: RemoteRecordInput[]): number {
    this.assertEnabled();
    const release = acquireStateLock(this.statePath);
    try {
      const state = parseState(this.statePath, this.namespace, this.clock());
      const added = enqueueIntoState(state, records);
      if (added > 0) {
        state.updatedAt = new Date(this.clock()).toISOString();
        atomicWrite(this.statePath, state);
      }
      return added;
    } finally {
      release();
    }
  }

  getLocalMutationCursor(): number {
    return parseState(this.statePath, this.namespace, this.clock()).localMutationCursor;
  }

  stageLocalMutations(records: RemoteRecordInput[], throughCursor: number): number {
    this.assertEnabled();
    if (!Number.isSafeInteger(throughCursor) || throughCursor < 0) {
      throw new Error("local mutation cursor must be a non-negative safe integer");
    }
    const release = acquireStateLock(this.statePath);
    try {
      const state = parseState(this.statePath, this.namespace, this.clock());
      if (throughCursor < state.localMutationCursor) {
        throw new Error("local mutation cursor cannot move backwards");
      }
      const added = enqueueIntoState(state, records);
      if (throughCursor > state.localMutationCursor || added > 0) {
        state.localMutationCursor = throughCursor;
        state.updatedAt = new Date(this.clock()).toISOString();
        atomicWrite(this.statePath, state);
      }
      return added;
    } finally {
      release();
    }
  }

  async syncOnce(records: RemoteRecordInput[] = [], waitMs = 0, signal?: AbortSignal): Promise<SyncOnceResult> {
    this.assertEnabled();
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) {
      throw new Error("waitMs must be between 0 and 25000");
    }
    const release = acquireStateLock(this.statePath);
    try {
      let state = parseState(this.statePath, this.namespace, this.clock());
      if (records.length > 0) {
        const added = enqueueIntoState(state, records);
        if (added > 0) {
          state.updatedAt = new Date(this.clock()).toISOString();
          atomicWrite(this.statePath, state);
        }
      }
      let pushed = 0;
      let duplicates = 0;
      while (state.pending.length > 0) {
        const batch = this.nextPushBatch(state.pending);
        const result = await this.request<PushResponse>("/v1/sync/push", {
          ...this.namespace,
          records: batch
        }, signal);
        if (!Number.isSafeInteger(result.accepted) || !Number.isSafeInteger(result.duplicates) ||
            result.accepted < 0 || result.duplicates < 0 || result.accepted + result.duplicates !== batch.length) {
          throw new Error("remote hub returned an invalid push acknowledgement");
        }
        const actorTokenId = validateActorTokenId(result.authenticatedActorTokenId);
        pushed += result.accepted;
        duplicates += result.duplicates;
        state.authenticatedActorTokenId = actorTokenId;
        state.publishedKeys.push(...batch.map((item) => item.idempotencyKey));
        state.pending.splice(0, batch.length);
        state.updatedAt = new Date(this.clock()).toISOString();
        atomicWrite(this.statePath, state);
      }

      const pulled = await this.request<PullResponse>("/v1/sync/pull", {
        ...this.namespace,
        afterCursor: state.cursor,
        limit: 500,
        waitMs
      }, signal);
      if (pulled.teamId !== this.namespace.teamId || pulled.repositoryId !== this.namespace.repositoryId) {
        throw new Error("remote hub returned records for the wrong namespace");
      }
      const authenticatedActorTokenId = validateActorTokenId(pulled.authenticatedActorTokenId);
      if (!Array.isArray(pulled.records) || !Number.isSafeInteger(pulled.latestCursor) || pulled.latestCursor < 0) {
        throw new Error("remote hub returned an invalid pull response");
      }
      const validated: RemoteRecord[] = [];
      let cursor = state.cursor;
      for (const raw of pulled.records) {
        if (raw.teamId !== this.namespace.teamId || raw.repositoryId !== this.namespace.repositoryId ||
            !Number.isSafeInteger(raw.cursor) || raw.cursor <= cursor) {
          throw new Error("remote hub returned an invalid or non-monotonic cursor");
        }
        const actorTokenId = validateActorTokenId(raw.actorTokenId);
        const record = validateRemoteRecord(raw);
        if (typeof raw.receivedAt !== "string" || !Number.isFinite(Date.parse(raw.receivedAt))) {
          throw new Error("remote hub returned an invalid receivedAt value");
        }
        validated.push({
          ...record,
          ...this.namespace,
          actorTokenId,
          cursor: raw.cursor,
          receivedAt: raw.receivedAt
        });
        cursor = raw.cursor;
      }
      const knownCursors = new Set(state.inbox.map((item) => item.cursor));
      for (const item of validated) if (!knownCursors.has(item.cursor)) state.inbox.push(item);
      state.authenticatedActorTokenId = authenticatedActorTokenId;
      state.cursor = cursor;
      state.updatedAt = new Date(this.clock()).toISOString();
      atomicWrite(this.statePath, state);
      return {
        pushed,
        duplicates,
        pulled: validated.length,
        cursor: state.cursor,
        pending: state.pending.length,
        inbox: state.inbox.length
      };
    } finally {
      release();
    }
  }

  drainInbox(): RemoteRecord[] {
    const release = acquireStateLock(this.statePath);
    try {
      const state = parseState(this.statePath, this.namespace, this.clock());
      const records = [...state.inbox];
      if (records.length > 0) {
        state.inbox = [];
        state.updatedAt = new Date(this.clock()).toISOString();
        atomicWrite(this.statePath, state);
      }
      return records;
    } finally {
      release();
    }
  }

  readInbox(): RemoteRecord[] {
    return [...parseState(this.statePath, this.namespace, this.clock()).inbox];
  }

  acknowledgeInbox(cursors: number[]): number {
    const release = acquireStateLock(this.statePath);
    try {
      const selected = new Set(cursors);
      const state = parseState(this.statePath, this.namespace, this.clock());
      const removed = removeInboxCursors(state, selected);
      if (removed > 0) {
        state.updatedAt = new Date(this.clock()).toISOString();
        atomicWrite(this.statePath, state);
      }
      return removed;
    } finally {
      release();
    }
  }

  getAuthenticatedActorTokenId(): string | null {
    return parseState(this.statePath, this.namespace, this.clock()).authenticatedActorTokenId;
  }

  isOwnRecord(record: RemoteRecord): boolean {
    const state = parseState(this.statePath, this.namespace, this.clock());
    return state.authenticatedActorTokenId !== null &&
      record.actorTokenId === state.authenticatedActorTokenId &&
      state.publishedKeys.includes(record.idempotencyKey);
  }

  getRemoteBinding(actorTokenId: string, remoteSubjectId: string): string | null {
    const checkedActorTokenId = validateActorTokenId(actorTokenId);
    if (!remoteSubjectId) throw new Error("remote subject id is required");
    const state = parseState(this.statePath, this.namespace, this.clock());
    const key = bindingKey(checkedActorTokenId, remoteSubjectId);
    if (Object.prototype.hasOwnProperty.call(state.remoteBindings, key)) return state.remoteBindings[key] ?? null;
    if (checkedActorTokenId === "legacy" && Object.prototype.hasOwnProperty.call(state.remoteBindings, remoteSubjectId)) {
      return state.remoteBindings[remoteSubjectId] ?? null;
    }
    return null;
  }

  setRemoteBinding(actorTokenId: string, remoteSubjectId: string, localMemoryId: string): void {
    const checkedActorTokenId = validateActorTokenId(actorTokenId);
    if (!remoteSubjectId || !localMemoryId) throw new Error("remote and local binding ids are required");
    const release = acquireStateLock(this.statePath);
    try {
      const state = parseState(this.statePath, this.namespace, this.clock());
      state.remoteBindings[bindingKey(checkedActorTokenId, remoteSubjectId)] = localMemoryId;
      state.updatedAt = new Date(this.clock()).toISOString();
      atomicWrite(this.statePath, state);
    } finally {
      release();
    }
  }

  bindRemoteAndAcknowledge(
    actorTokenId: string,
    remoteSubjectId: string,
    localMemoryId: string,
    cursor: number
  ): number {
    const checkedActorTokenId = validateActorTokenId(actorTokenId);
    if (!remoteSubjectId || !localMemoryId) throw new Error("remote and local binding ids are required");
    if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Error("inbox cursor must be a positive safe integer");
    const release = acquireStateLock(this.statePath);
    try {
      const state = parseState(this.statePath, this.namespace, this.clock());
      state.remoteBindings[bindingKey(checkedActorTokenId, remoteSubjectId)] = localMemoryId;
      const removed = removeInboxCursors(state, new Set([cursor]));
      state.updatedAt = new Date(this.clock()).toISOString();
      atomicWrite(this.statePath, state);
      return removed;
    } finally {
      release();
    }
  }

  async watch(options: SyncWatchOptions = {}): Promise<void> {
    this.assertEnabled();
    const waitMs = options.waitMs ?? 20_000;
    const minimumBackoffMs = options.minimumBackoffMs ?? 500;
    const maximumBackoffMs = options.maximumBackoffMs ?? 30_000;
    if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 25_000) throw new Error("watch waitMs must be between 1 and 25000");
    if (!Number.isInteger(minimumBackoffMs) || !Number.isInteger(maximumBackoffMs) ||
        minimumBackoffMs < 10 || maximumBackoffMs < minimumBackoffMs) {
      throw new Error("invalid watch reconnect backoff");
    }
    let backoffMs = minimumBackoffMs;
    while (!options.signal?.aborted) {
      try {
        const records = await options.beforeSync?.() ?? [];
        const result = await this.syncOnce(records, waitMs, options.signal);
        await options.onSync?.(result);
        backoffMs = minimumBackoffMs;
      } catch (error) {
        if (options.signal?.aborted) return;
        const normalized = error instanceof Error ? error : new Error(String(error));
        await options.onError?.(normalized, backoffMs);
        await abortableDelay(backoffMs, options.signal);
        backoffMs = Math.min(maximumBackoffMs, backoffMs * 2);
      }
    }
  }

  private nextPushBatch(pending: RemoteRecordInput[]): RemoteRecordInput[] {
    const batch: RemoteRecordInput[] = [];
    for (const record of pending.slice(0, 100)) {
      const candidate = [...batch, record];
      const body = { ...this.namespace, records: candidate };
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > this.maxRequestBytes) break;
      batch.push(record);
    }
    if (batch.length === 0) {
      throw new Error("a pending remote record exceeds the configured push request byte limit");
    }
    return batch;
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new Error("remote team sync is disabled; explicitly enable the developer preview");
    }
  }

  private async request<T>(path: string, body: unknown, externalSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    try {
      const requestBody = JSON.stringify(body);
      if (Buffer.byteLength(requestBody, "utf8") > this.maxRequestBytes) {
        throw new Error("remote sync request exceeded the local safety limit");
      }
      const response = await this.fetchFn(new URL(path, this.url), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json"
        },
        body: requestBody,
        signal: controller.signal
      });
      const bytes = await readBoundedResponse(response, this.maxResponseBytes, controller);
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      } catch {
        throw new Error("remote hub returned invalid JSON");
      }
      if (!response.ok) {
        const message = parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : `HTTP ${response.status}`;
        throw new Error(`remote sync failed: ${message}`);
      }
      return parsed as T;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abort);
    }
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  controller: AbortController
): Promise<Buffer> {
  const announced = response.headers.get("content-length");
  if (announced !== null) {
    const length = Number(announced);
    if (Number.isFinite(length) && length > maxBytes) {
      controller.abort();
      throw new Error("remote hub response exceeded the local safety limit");
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        await reader.cancel("response byte limit exceeded").catch(() => undefined);
        throw new Error("remote hub response exceeded the local safety limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });
  });
}
