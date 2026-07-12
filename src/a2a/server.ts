import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { delegate } from "../adapters/index.js";
import { id } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import type { A2ATask, JsonRpcRequest } from "./types.js";
import type { DelegateOptions, DelegateResult } from "../adapters/types.js";

const DEFAULT_MAX_CONCURRENT_TASKS = 2;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_STORED_TASKS = 100;

export interface A2AServerOptions {
  host?: string;
  port?: number;
  defaultProvider?: "codex" | "claude";
  cwd?: string;
  token?: string;
  maxConcurrentTasks?: number;
  maxRequestBytes?: number;
  maxOutputBytes?: number;
  maxStoredTasks?: number;
  delegateFn?: (options: DelegateOptions) => Promise<DelegateResult>;
}

class RequestBodyTooLargeError extends Error {}

class InvalidJsonError extends Error {}

function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError(`Request exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch (error) {
        reject(new InvalidJsonError(error instanceof Error ? error.message : String(error)));
      }
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function send(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers
  });
  response.end(body);
}

function positiveInteger(value: number | undefined, fallback: number, name: string, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function hasSafeHost(request: IncomingMessage): boolean {
  const value = request.headers.host;
  if (!value) return false;
  try {
    const parsed = new URL(`http://${value}`);
    return !parsed.username && !parsed.password && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function hasSafeOrigin(request: IncomingMessage): boolean {
  const value = request.headers.origin;
  if (value === undefined) return true;
  if (Array.isArray(value) || value === "null") return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:")
      && !parsed.username
      && !parsed.password
      && isLoopbackHostname(parsed.hostname)
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash
    );
  } catch {
    return false;
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization;
  if (typeof value !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (!match?.[1]) return false;
  const actual = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function boundedText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "\n[AgentGraph output truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) return marker.slice(0, maxBytes);
  const source = Buffer.from(value, "utf8");
  let end = maxBytes - markerBytes;
  let prefix = "";
  while (end > 0) {
    try {
      prefix = new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }
  return `${prefix}${marker}`;
}

function pruneTasks(tasks: Map<string, A2ATask>, maxStoredTasks: number): void {
  while (tasks.size >= maxStoredTasks) {
    const candidate = [...tasks.entries()].find(([, task]) => task.status.state !== "working");
    if (!candidate) return;
    tasks.delete(candidate[0]);
  }
}

function textFromParams(params: Record<string, unknown> | undefined): string {
  const message = params?.message;
  if (typeof message !== "object" || message === null) return "";
  const parts = (message as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const record = part as Record<string, unknown>;
      return record.kind === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function startA2AServer(options: A2AServerOptions = {}): Promise<{
  close: () => Promise<void>;
  url: string;
  token: string;
}> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHostname(host)) throw new Error("The A2A server must bind to a loopback host");
  const port = options.port ?? 4319;
  let boundPort = port;
  const token = options.token ?? randomBytes(32).toString("base64url");
  if (Buffer.byteLength(token, "utf8") < 32) throw new Error("A2A bearer token must be at least 32 bytes");
  const maxConcurrentTasks = positiveInteger(
    options.maxConcurrentTasks,
    DEFAULT_MAX_CONCURRENT_TASKS,
    "maxConcurrentTasks",
    32
  );
  const maxRequestBytes = positiveInteger(
    options.maxRequestBytes,
    DEFAULT_MAX_REQUEST_BYTES,
    "maxRequestBytes",
    1024 * 1024
  );
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
    1024 * 1024
  );
  const maxStoredTasks = positiveInteger(options.maxStoredTasks, DEFAULT_MAX_STORED_TASKS, "maxStoredTasks", 1_000);
  if (maxStoredTasks < maxConcurrentTasks) {
    throw new Error("maxStoredTasks cannot be lower than maxConcurrentTasks");
  }
  const runDelegate = options.delegateFn ?? delegate;
  const tasks = new Map<string, A2ATask>();
  const controllers = new Map<string, AbortController>();
  let activeTasks = 0;

  const server = createServer(async (request, response) => {
    try {
      if (!hasSafeHost(request)) {
        send(response, 403, { error: "A loopback Host header is required" });
        return;
      }
      if (!hasSafeOrigin(request)) {
        send(response, 403, { error: "Cross-origin A2A requests are forbidden" });
        return;
      }
      if (!authorized(request, token)) {
        send(response, 401, { error: "A valid AgentGraph bearer token is required" }, {
          "www-authenticate": "Bearer realm=\"agentgraph-a2a\""
        });
        return;
      }
      if (request.method === "GET" && request.url === "/.well-known/agent-card.json") {
        send(response, 200, {
          name: "AgentGraph Local Relay",
          description: "Delegate local coding tasks to supervised Codex and Claude agents.",
          protocolVersion: "1.0.0",
          version: "0.1.0",
          url: `http://${host}:${boundPort}/a2a`,
          capabilities: { streaming: false, pushNotifications: false },
          defaultInputModes: ["text"],
          defaultOutputModes: ["text"],
          skills: [
            { id: "codex-engineering", name: "Codex engineering", tags: ["code", "codex"] },
            { id: "claude-review", name: "Claude review", tags: ["code", "review", "claude"] }
          ]
        });
        return;
      }
      if (request.method !== "POST" || request.url !== "/a2a") {
        send(response, 404, { error: "Not found" });
        return;
      }

      const rpc = (await readJson(request, maxRequestBytes)) as JsonRpcRequest;
      const result = (value: unknown): void => send(response, 200, { jsonrpc: "2.0", id: rpc.id ?? null, result: value });
      const failure = (code: number, message: string, status = 200): void => send(response, status, {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: { code, message }
      });

      if (rpc.method === "tasks/get") {
        const taskId = String(rpc.params?.id ?? "");
        const task = tasks.get(taskId);
        task ? result(task) : failure(-32001, "Task not found");
        return;
      }
      if (rpc.method === "tasks/cancel") {
        const taskId = String(rpc.params?.id ?? "");
        const task = tasks.get(taskId);
        if (!task) {
          failure(-32001, "Task not found");
          return;
        }
        controllers.get(taskId)?.abort();
        task.status = { state: "canceled", timestamp: nowIso() };
        result(task);
        return;
      }
      if (rpc.method !== "message/send") {
        failure(-32601, "Method not found");
        return;
      }
      if (activeTasks >= maxConcurrentTasks) {
        failure(-32002, `A2A concurrency limit reached (${maxConcurrentTasks})`, 429);
        return;
      }

      const prompt = textFromParams(rpc.params);
      if (!prompt) {
        failure(-32602, "A text message part is required");
        return;
      }
      const metadata = rpc.params?.metadata;
      const providerValue = typeof metadata === "object" && metadata !== null
        ? (metadata as Record<string, unknown>).provider
        : undefined;
      const provider = providerValue === "claude" || providerValue === "codex"
        ? providerValue
        : options.defaultProvider ?? "codex";
      const taskId = id("task");
      const contextId = String(rpc.params?.contextId ?? id("ctx"));
      const task: A2ATask = {
        id: taskId,
        contextId,
        provider,
        status: { state: "working", timestamp: nowIso() },
        artifacts: []
      };
      pruneTasks(tasks, maxStoredTasks);
      tasks.set(taskId, task);
      const controller = new AbortController();
      controllers.set(taskId, controller);

      activeTasks += 1;
      try {
        const delegated = await runDelegate({
          provider,
          prompt,
          cwd: options.cwd ?? process.cwd(),
          signal: controller.signal,
          timeoutMs: 900_000,
          maxCapturedBytes: maxOutputBytes
        });
        if (task.status.state !== "canceled") {
          task.status = {
            state: delegated.exitCode === 0 ? "completed" : "failed",
            timestamp: nowIso()
          };
        }
        task.artifacts.push({
          artifactId: id("artifact"),
          name: `${provider} response`,
          parts: [{
            kind: "text",
            text: boundedText(delegated.finalResponse || delegated.stderr, maxOutputBytes)
          }]
        });
        result(task);
      } finally {
        activeTasks -= 1;
        controllers.delete(taskId);
      }
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        send(response, 413, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32003, message: error.message }
        });
        return;
      }
      if (error instanceof InvalidJsonError) {
        send(response, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid JSON" }
        });
        return;
      }
      send(response, 500, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) boundPort = address.port;
      resolve({
        url: `http://${host}:${boundPort}`,
        token,
        close: () => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()))
      });
    });
  });
}
