import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type {
  AgentEventInput,
  AgentActivity,
  DiscoveredProcess,
  ProcessPresence,
  ProcessRegistration,
  RpcRequest,
  RpcResponse,
  TerminalFingerprint
} from "../protocol/index.js";
import { RPC_VERSION } from "../protocol/index.js";
import type { Store } from "../store/store.js";
import { VERSION } from "../version.js";
import type { AgentGraphPaths } from "../config/paths.js";
import type { AgentGraphConfig } from "../config/config.js";
import { discoverAgentProcesses, executableName } from "./process-inspection.js";
import { findRepositoryContext } from "./repository.js";
import { reconcileLeases } from "./reconciler.js";

export interface DaemonControl {
  shutdown(): Promise<void> | void;
}

export interface RpcContext {
  store: Store;
  socket: Socket;
  paths: AgentGraphPaths;
  config: AgentGraphConfig;
  control: DaemonControl;
  requestedAt: string;
}

export type RpcHandler = (params: unknown, context: RpcContext) => unknown | Promise<unknown>;

export class RpcMethodError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "RpcMethodError";
  }
}

export class RpcDispatcher {
  private readonly handlers = new Map<string, RpcHandler>();

  register(method: string, handler: RpcHandler): this {
    if (!method) throw new Error("RPC method cannot be empty");
    if (this.handlers.has(method)) throw new Error(`RPC method already registered: ${method}`);
    this.handlers.set(method, handler);
    return this;
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  methods(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async dispatch(request: RpcRequest, context: RpcContext): Promise<RpcResponse> {
    const handler = this.handlers.get(request.method);
    if (!handler) {
      return { jsonrpc: RPC_VERSION, id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
    }
    try {
      const result = await handler(request.params, context);
      return { jsonrpc: RPC_VERSION, id: request.id, result: result ?? null };
    } catch (error) {
      if (error instanceof RpcMethodError) {
        return {
          jsonrpc: RPC_VERSION,
          id: request.id,
          error: {
            code: error.code,
            message: error.message,
            ...(error.data === undefined ? {} : { data: error.data })
          }
        };
      }
      return {
        jsonrpc: RPC_VERSION,
        id: request.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
      };
    }
  }
}

function objectParams(params: unknown): Record<string, unknown> {
  if (params === undefined) return {};
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new RpcMethodError(-32602, "Parameters must be an object");
  }
  return params as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new RpcMethodError(-32602, `${key} is required`);
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RpcMethodError(-32602, `${key} must be a string`);
  return value;
}

function registrationFromParams(params: unknown): ProcessRegistration {
  const object = objectParams(params);
  const source = object.registration && typeof object.registration === "object"
    ? object.registration as Record<string, unknown>
    : object;
  return source as unknown as ProcessRegistration;
}

export function eventFromParams(params: unknown, store: Store): AgentEventInput {
  const object = objectParams(params);
  const candidate = object.event && typeof object.event === "object"
    ? object.event as Record<string, unknown>
    : object;
  if (!candidate.process_instance_id) {
    const payload = candidate.payload && typeof candidate.payload === "object" ? candidate.payload as Record<string, unknown> : {};
    const runId = typeof candidate.run_id === "string"
      ? candidate.run_id
      : typeof payload.run_id === "string"
        ? payload.run_id
        : typeof payload.agentgraph_run_id === "string"
          ? payload.agentgraph_run_id
          : null;
    if (runId) {
      const process = store.getProcessByRunId(runId);
      if (process) {
        candidate.process_instance_id = process.id;
        candidate.terminal_id ??= process.terminalId;
        candidate.host_id ??= store.hostId;
      }
    }
    if (!candidate.process_instance_id && candidate.source === "hook" && hookEventIsFresh(candidate, store)) {
      const process = resolveHookProcess(candidate, payload, store);
      if (process) {
        candidate.process_instance_id = process.id;
        candidate.terminal_id ??= process.terminalId;
        candidate.host_id ??= store.hostId;
      }
    }
  }
  return candidate as unknown as AgentEventInput;
}

function hookEventIsFresh(candidate: Record<string, unknown>, store: Store): boolean {
  const timestamp = typeof candidate.observed_at === "string"
    ? candidate.observed_at
    : typeof candidate.occurred_at === "string"
      ? candidate.occurred_at
      : null;
  if (!timestamp) return true;
  const eventTime = Date.parse(timestamp);
  if (!Number.isFinite(eventTime)) return true;
  return Date.now() - eventTime <= Math.max(60_000, store.leaseDurationMs * 2);
}

function resolveHookProcess(
  candidate: Record<string, unknown>,
  payload: Record<string, unknown>,
  store: Store
): ProcessPresence | null {
  const provider = typeof candidate.provider === "string" ? candidate.provider : null;
  if (!provider) return null;
  const providerSessionId = typeof candidate.provider_session_id === "string"
    ? candidate.provider_session_id
    : null;
  const cwd = typeof payload.cwd === "string"
    ? payload.cwd
    : typeof payload.working_directory === "string"
      ? payload.working_directory
      : null;
  const hookTty = typeof payload.agentgraph_hook_tty === "string"
    ? payload.agentgraph_hook_tty
    : null;
  const repository = cwd ? findRepositoryContext(cwd) : null;
  const known = store.listProcesses({
    provider,
    ...(repository?.repositoryRoot ? { repositoryRoot: repository.repositoryRoot } : {})
  });
  if (providerSessionId) {
    const exact = known.filter((process) => process.providerSessionId === providerSessionId);
    if (exact.length === 1) return exact[0] ?? null;
  }
  const sameTerminal = hookTty
    ? known.filter((process) => process.terminal?.tty === hookTty)
    : known;
  const sameCwd = cwd ? sameTerminal.filter((process) => process.cwd === cwd) : sameTerminal;
  if (sameCwd.length === 1) return sameCwd[0] ?? null;

  // Never run a full-machine provider scan for an ambiguous ordinary hook.
  // New hooks carry their TTY; legacy/no-TTY hooks remain durable but orphaned
  // instead of blocking the daemon or guessing among concurrent sessions.
  if (!hookTty) return null;

  const discovered = discoverAgentProcesses({
    provider,
    ...(hookTty ? { tty: hookTty } : {}),
    ...(cwd ? { cwd } : {})
  }).filter((process) => {
    if (!cwd) return true;
    if (process.cwd === cwd) return true;
    const processRepository = process.cwd ? findRepositoryContext(process.cwd).repositoryRoot : null;
    return repository?.repositoryRoot !== null && processRepository === repository?.repositoryRoot;
  });
  if (discovered.length !== 1) return null;
  return attachDiscoveredProcess(store, discovered[0]!, cwd ?? undefined, "hook_seen", true);
}

function attachDiscoveredProcess(
  store: Store,
  discovered: DiscoveredProcess,
  preferredCwd?: string,
  confidence: "heuristic" | "hook_seen" = "heuristic",
  autoAttachedFromHook = false
): ProcessPresence {
  const existing = store.getProcessByPid(discovered.pid, discovered.processStartToken);
  if (existing) return existing;
  const cwd = preferredCwd ?? discovered.cwd ?? process.cwd();
  const repository = findRepositoryContext(cwd);
  const terminal: TerminalFingerprint = {
    tty: discovered.tty,
    termProgram: null,
    termSessionId: null,
    itermSessionId: null,
    tmuxPane: null,
    parentPid: discovered.parentPid
  };
  return store.registerProcess({
    runId: `attached_${randomUUID().replaceAll("-", "")}`,
    leaseToken: randomUUID(),
    provider: discovered.provider,
    mode: "attached",
    pid: discovered.pid,
    processStartToken: discovered.processStartToken,
    executable: executableName(discovered.command),
    argv: [],
    cwd,
    repositoryRoot: repository.repositoryRoot,
    worktreeRoot: repository.worktreeRoot,
    terminal,
    metadata: { autoAttachedFromHook }
  }, { confidence, activity: "unknown" });
}

export function createCoreDispatcher(store: Store, paths: AgentGraphPaths, config: AgentGraphConfig): RpcDispatcher {
  const dispatcher = new RpcDispatcher();

  const health: RpcHandler = (_params, context) => ({
    ok: true,
    version: VERSION,
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    databasePath: context.paths.databasePath,
    socketPath: context.paths.socketPath,
    liveProcesses: context.store.listProcesses().length,
    now: context.requestedAt
  });
  dispatcher.register("health", health).register("ping", health);

  dispatcher.register("rpc.methods", () => dispatcher.methods());

  dispatcher.register("process.register", (params) => store.registerProcess(registrationFromParams(params)));

  dispatcher.register("process.heartbeat", (params) => {
    const object = objectParams(params);
    const activity = optionalString(object, "activity") as AgentActivity | undefined;
    return store.heartbeat(
      requiredString(object, "runId"),
      requiredString(object, "leaseToken"),
      activity,
      optionalString(object, "cwd")
    );
  });

  dispatcher.register("process.exit", (params) => {
    const object = objectParams(params);
    const code = object.exitCode;
    const signal = object.exitSignal;
    if (code !== undefined && code !== null && typeof code !== "number") throw new RpcMethodError(-32602, "exitCode must be a number or null");
    if (signal !== undefined && signal !== null && typeof signal !== "string") throw new RpcMethodError(-32602, "exitSignal must be a string or null");
    return store.markExited(
      requiredString(object, "runId"),
      requiredString(object, "leaseToken"),
      typeof code === "number" ? code : null,
      typeof signal === "string" ? signal : null
    );
  });

  dispatcher.register("process.get", (params) => {
    const object = objectParams(params);
    if (typeof object.id === "string") return store.getProcessById(object.id);
    if (typeof object.runId === "string") return store.getProcessByRunId(object.runId);
    throw new RpcMethodError(-32602, "id or runId is required");
  });

  dispatcher.register("process.list", (params) => {
    const object = objectParams(params);
    return store.listProcesses({
      includeExited: object.includeExited === true,
      ...(typeof object.recentSeconds === "number" ? { recentSeconds: object.recentSeconds } : {}),
      ...(typeof object.repositoryRoot === "string" ? { repositoryRoot: object.repositoryRoot } : {}),
      ...(typeof object.provider === "string" ? { provider: object.provider } : {})
    });
  });

  dispatcher.register("process.discover", () => discoverAgentProcesses());

  dispatcher.register("process.attach", (params) => {
    const object = objectParams(params);
    const pid = object.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) throw new RpcMethodError(-32602, "pid must be a positive integer");
    const discovered = discoverAgentProcesses().find((candidate) => candidate.pid === pid);
    if (!discovered) throw new RpcMethodError(404, `No attachable Codex or Claude process found for PID ${pid}`);
    return attachDiscoveredProcess(store, discovered, optionalString(object, "cwd"));
  });

  dispatcher.register("process.reconcile", () => reconcileLeases(store));

  const appendEvent: RpcHandler = (params) => store.appendEvent(eventFromParams(params, store));
  dispatcher.register("event.append", appendEvent);
  dispatcher.register("events.ingest", appendEvent);

  const listEvents: RpcHandler = (params) => {
    const object = objectParams(params);
    return store.listEvents({
      ...(typeof object.processInstanceId === "string" ? { processInstanceId: object.processInstanceId } : {}),
      ...(typeof object.providerSessionId === "string" ? { providerSessionId: object.providerSessionId } : {}),
      ...(typeof object.kind === "string" ? { kind: object.kind } : {}),
      ...(typeof object.limit === "number" ? { limit: object.limit } : {})
    });
  };
  dispatcher.register("event.list", listEvents).register("events.list", listEvents);

  dispatcher.register("session.get", (params) => {
    const object = objectParams(params);
    return store.getSession(requiredString(object, "sessionId"), {
      ...(typeof object.provider === "string" ? { provider: object.provider } : {}),
      ...(typeof object.repositoryRoot === "string" ? { repositoryRoot: object.repositoryRoot } : {}),
      ...(typeof object.worktreeRoot === "string" ? { worktreeRoot: object.worktreeRoot } : {})
    });
  });

  dispatcher.register("session.search", (params) => {
    const object = objectParams(params);
    const limit = object.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) <= 0 || (limit as number) > 100)) {
      throw new RpcMethodError(-32602, "limit must be an integer between 1 and 100");
    }
    return store.searchSessions({
      query: requiredString(object, "query"),
      ...(typeof object.provider === "string" ? { provider: object.provider } : {}),
      ...(typeof object.repositoryRoot === "string" ? { repositoryRoot: object.repositoryRoot } : {}),
      ...(typeof object.worktreeRoot === "string" ? { worktreeRoot: object.worktreeRoot } : {}),
      ...(typeof object.excludeSessionId === "string" ? { excludeSessionId: object.excludeSessionId } : {}),
      ...(typeof limit === "number" ? { limit } : {})
    });
  });

  dispatcher.register("daemon.shutdown", (_params, context) => {
    setImmediate(() => void context.control.shutdown());
    return { accepted: true };
  });

  return dispatcher;
}

type DomainModule = {
  registerDomainHandlers?: (dispatcher: RpcDispatcher, store: Store) => void | Promise<void>;
  createDomainHandlers?: (store: Store) => Record<string, RpcHandler> | Promise<Record<string, RpcHandler>>;
};

/** Loads optional memory/handoff handlers without making the presence daemon depend on them. */
export async function loadDomainHandlers(dispatcher: RpcDispatcher, store: Store): Promise<boolean> {
  const moduleName = "./domain-handlers.js";
  let domain: DomainModule;
  try {
    domain = await import(moduleName) as DomainModule;
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException;
    if (candidate.code === "ERR_MODULE_NOT_FOUND" && candidate.message.includes("domain-handlers")) return false;
    throw error;
  }
  if (domain.registerDomainHandlers) await domain.registerDomainHandlers(dispatcher, store);
  if (domain.createDomainHandlers) {
    const handlers = await domain.createDomainHandlers(store);
    for (const [method, handler] of Object.entries(handlers)) {
      if (!dispatcher.has(method)) dispatcher.register(method, handler);
    }
  }
  return true;
}
