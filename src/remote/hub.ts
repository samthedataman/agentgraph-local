import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type ServerOptions as HttpsServerOptions } from "node:https";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { StoreAuthenticator } from "./auth.js";
import { RemoteHubStore } from "./store.js";
import type { Authenticator, AuthPrincipal, PullResponse, RemoteClock, RemoteRecord } from "./types.js";
import {
  assertAuthorizedNamespace,
  RemoteValidationError,
  validateActorTokenId,
  validatePullRequest,
  validatePushRequest
} from "./validation.js";

export interface RemoteTlsOptions {
  key: string | Buffer;
  cert: string | Buffer;
}

export interface RemoteHubOptions {
  enabled?: boolean;
  host?: string;
  port?: number;
  databasePath?: string;
  store?: RemoteHubStore;
  authenticator?: Authenticator;
  tls?: RemoteTlsOptions;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxRecordsPerPush?: number;
  maxConcurrentRequests?: number;
  rateLimitPerMinute?: number;
  maxLongPollMs?: number;
  clock?: RemoteClock;
}

export interface RunningRemoteHub {
  url: string;
  store: RemoteHubStore;
  close(): Promise<void>;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function hostHeaderName(header: string): string | null {
  try {
    return normalizeHostname(new URL(`http://${header}`).hostname);
  } catch {
    return null;
  }
}

export function validateRemoteHubSecurity(options: RemoteHubOptions): void {
  if (options.enabled !== true) {
    throw new Error("remote team sync is disabled; explicitly set enabled: true (developer preview)");
  }
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) {
    if (!options.tls?.key || !options.tls.cert) {
      throw new Error("non-loopback remote hubs require an explicit TLS certificate and key");
    }
    if (!options.allowedHosts?.length) {
      throw new Error("non-loopback remote hubs require at least one explicit allowed host");
    }
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new RemoteValidationError("content-type must be application/json", 415);
  const announcedLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(announcedLength) && announcedLength > maxBytes) {
    throw new RemoteValidationError("request body is too large", 413);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new RemoteValidationError("request body is too large", 413);
    chunks.push(buffer);
  }
  if (bytes === 0) throw new RemoteValidationError("request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RemoteValidationError("request body must be valid JSON");
  }
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1] ?? null;
}

export async function startRemoteHub(options: RemoteHubOptions): Promise<RunningRemoteHub> {
  validateRemoteHubSecurity(options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4320;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("port must be between 0 and 65535");
  const clock = options.clock ?? Date.now;
  const maxRequestBytes = options.maxRequestBytes ?? 256 * 1024;
  const maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
  const maxRecordsPerPush = options.maxRecordsPerPush ?? 100;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? 32;
  const rateLimitPerMinute = options.rateLimitPerMinute ?? 120;
  const maxLongPollMs = options.maxLongPollMs ?? 25_000;
  for (const [name, value] of Object.entries({
    maxRequestBytes, maxResponseBytes, maxRecordsPerPush, maxConcurrentRequests, rateLimitPerMinute, maxLongPollMs
  })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  if (maxResponseBytes < 1_024) throw new Error("maxResponseBytes must be at least 1024 bytes");
  const ownsStore = options.store === undefined;
  const store = options.store ?? new RemoteHubStore(
    options.databasePath ?? ":memory:",
    options.clock ? { clock: options.clock } : {}
  );
  const authenticator = options.authenticator ?? new StoreAuthenticator(store);

  const allowedHosts = new Set((options.allowedHosts ?? []).map(normalizeHostname));
  if (isLoopback(host)) {
    allowedHosts.add("127.0.0.1");
    allowedHosts.add("localhost");
    allowedHosts.add("::1");
  } else {
    allowedHosts.add(normalizeHostname(host));
  }
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const rateWindows = new Map<string, RateWindow>();
  let activeRequests = 0;

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const suppliedHost = request.headers.host;
      const hostname = suppliedHost ? hostHeaderName(suppliedHost) : null;
      if (hostname === null || !allowedHosts.has(hostname)) {
        json(response, 403, { error: "host_not_allowed" });
        return;
      }
      const origin = request.headers.origin;
      if (origin) {
        let validOrigin = allowedOrigins.has(origin);
        if (!validOrigin && isLoopback(host)) {
          try {
            const parsed = new URL(origin);
            validOrigin = parsed.protocol === (options.tls ? "https:" : "http:") &&
              allowedHosts.has(normalizeHostname(parsed.hostname));
          } catch {
            validOrigin = false;
          }
        }
        if (!validOrigin) {
          json(response, 403, { error: "origin_not_allowed" });
          return;
        }
      }

      if (activeRequests >= maxConcurrentRequests) {
        response.setHeader("retry-after", "1");
        json(response, 429, { error: "concurrency_limit_exceeded" });
        return;
      }

      activeRequests += 1;
      try {
        const rateKey = request.socket.remoteAddress ?? "unknown";
        const now = clock();
        const current = rateWindows.get(rateKey);
        const window = !current || now - current.startedAt >= 60_000
          ? { startedAt: now, count: 0 }
          : current;
        window.count += 1;
        rateWindows.set(rateKey, window);
        if (window.count > rateLimitPerMinute) {
          response.setHeader("retry-after", "60");
          json(response, 429, { error: "rate_limit_exceeded" });
          return;
        }
        const token = bearerToken(request);
        const principal = token ? await authenticator.authenticate(token, now) : null;
        if (!principal) {
          response.setHeader("www-authenticate", 'Bearer realm="agentgraph-remote"');
          json(response, 401, { error: "unauthorized" });
          return;
        }
        await route(request, response, principal, store, {
          maxRequestBytes,
          maxResponseBytes,
          maxRecordsPerPush,
          maxLongPollMs
        });
      } finally {
        activeRequests -= 1;
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof RemoteValidationError) {
        json(response, error.statusCode, { error: "invalid_request", message: error.message });
      } else {
        json(response, 500, { error: "internal_error" });
      }
    }
  };

  const server: Server = options.tls
    ? createHttpsServer(options.tls as HttpsServerOptions, (request, response) => void handler(request, response))
    : createHttpServer((request, response) => void handler(request, response));
  server.requestTimeout = Math.max(30_000, maxLongPollMs + 5_000);
  server.headersTimeout = server.requestTimeout + 5_000;

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    if (ownsStore) store.close();
    throw error;
  }
  const address = server.address() as AddressInfo;
  const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const url = `${options.tls ? "https" : "http"}://${displayHost}:${address.port}`;
  return {
    url,
    store,
    close: async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeIdleConnections?.();
          server.closeAllConnections?.();
        });
      } finally {
        if (ownsStore) store.close();
      }
    }
  };
}

interface RouteLimits {
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxRecordsPerPush: number;
  maxLongPollMs: number;
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
  store: RemoteHubStore,
  limits: RouteLimits
): Promise<void> {
  const actorTokenId = validateActorTokenId(principal.tokenId);
  const url = new URL(request.url ?? "/", "http://agentgraph.invalid");
  if (request.method === "GET" && url.pathname === "/v1/health") {
    json(response, 200, {
      ok: true,
      service: "agentgraph-remote-memory",
      mode: "developer-preview",
      execution: false
    });
    return;
  }
  if (request.method !== "POST") {
    json(response, 404, { error: "not_found" });
    return;
  }
  if (url.pathname === "/v1/sync/push") {
    const input = validatePushRequest(await readJson(request, limits.maxRequestBytes), limits.maxRecordsPerPush);
    assertAuthorizedNamespace(principal, input);
    json(response, 200, {
      ...store.push(input, input.records, actorTokenId),
      authenticatedActorTokenId: actorTokenId
    });
    return;
  }
  if (url.pathname === "/v1/sync/pull") {
    const input = validatePullRequest(await readJson(request, limits.maxRequestBytes), 500, limits.maxLongPollMs);
    assertAuthorizedNamespace(principal, input);
    let records = store.pull(input, input.afterCursor, input.limit);
    if (records.length === 0 && (input.waitMs ?? 0) > 0) {
      const abort = new AbortController();
      const onClose = (): void => abort.abort();
      response.once("close", onClose);
      try {
        await store.waitForChange(input, input.afterCursor, input.waitMs ?? 0, abort.signal);
      } finally {
        response.off("close", onClose);
      }
      records = store.pull(input, input.afterCursor, input.limit);
    }
    const body = boundedPullResponse({
      teamId: input.teamId,
      repositoryId: input.repositoryId,
      records,
      latestCursor: store.latestCursor(input),
      authenticatedActorTokenId: actorTokenId
    }, limits.maxResponseBytes);
    json(response, 200, body);
    return;
  }
  json(response, 404, { error: "not_found" });
}

function boundedPullResponse(response: PullResponse, maxBytes: number): PullResponse {
  const selected: RemoteRecord[] = [];
  for (const record of response.records) {
    const candidate: PullResponse = { ...response, records: [...selected, record] };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxBytes) break;
    selected.push(record);
  }
  const bounded = { ...response, records: selected };
  const byteLength = Buffer.byteLength(JSON.stringify(bounded), "utf8");
  if (byteLength > maxBytes || (response.records.length > 0 && selected.length === 0)) {
    throw new RemoteValidationError(
      "configured pull response limit is too small for the next synchronized record",
      503
    );
  }
  return bounded;
}
