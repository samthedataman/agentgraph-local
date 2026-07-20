import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { ensureDirectories, getPaths, type AgentGraphPaths } from "../config/paths.js";
import { loadConfig, type AgentGraphConfig } from "../config/config.js";
import { isRpcRequest, RPC_VERSION, type RpcFailureResponse } from "../protocol/rpc.js";
import { Store } from "../store/store.js";
import { drainHookSpool } from "../hooks/spool.js";
import {
  createCoreDispatcher,
  eventFromParams,
  loadDomainHandlers,
  type DaemonControl,
  type RpcContext,
  type RpcDispatcher
} from "./dispatcher.js";
import { LeaseReconciler } from "./reconciler.js";
import { daemonPidRecordMatches, readDaemonPidRecord, writeDaemonPidRecord } from "./pid-file.js";

const MAX_LINE_BYTES = 1_048_576;
const SPOOL_DRAIN_BATCH_SIZE = 5;
const SPOOL_DRAIN_INTERVAL_MS = 100;

export interface DaemonServerOptions {
  paths?: AgentGraphPaths;
  config?: AgentGraphConfig;
  store?: Store;
  dispatcher?: RpcDispatcher;
}

export interface DaemonServer {
  server: Server;
  store: Store;
  dispatcher: RpcDispatcher;
  paths: AgentGraphPaths;
  close(): Promise<void>;
}

function cleanStaleRuntime(paths: AgentGraphPaths): void {
  if (!existsSync(paths.socketPath) && !existsSync(paths.pidPath)) return;
  const owner = readDaemonPidRecord(paths.pidPath);
  if (owner && owner.pid !== process.pid && daemonPidRecordMatches(owner)) {
    throw new Error(`AgentGraph daemon is already running (PID ${owner.pid})`);
  }
  if (!owner && existsSync(paths.pidPath) && existsSync(paths.socketPath)) {
    throw new Error("Refusing to replace an unverifiable AgentGraph runtime; remove stale socket/PID files manually");
  }
  for (const path of [paths.socketPath, paths.pidPath]) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function send(socket: Socket, response: unknown): void {
  if (socket.destroyed || !socket.writable) return;
  try {
    socket.write(`${JSON.stringify(response)}\n`, (error) => {
      if (error) socket.destroy();
    });
  } catch {
    socket.destroy();
  }
}

export async function startDaemonServer(options: DaemonServerOptions = {}): Promise<DaemonServer> {
  const paths = ensureDirectories(options.paths ?? getPaths());
  const config = options.config ?? loadConfig(paths);
  cleanStaleRuntime(paths);
  const ownsStore = options.store === undefined;
  const store = options.store ?? new Store(paths.databasePath, {
    hostId: config.hostId,
    leaseDurationMs: config.leaseDurationMs
  });
  const dispatcher = options.dispatcher ?? createCoreDispatcher(store, paths, config);
  if (!options.dispatcher) await loadDomainHandlers(dispatcher, store);
  try {
    // Reserve daemon ownership before listen(2), closing the small race where
    // two startup commands both observe no socket.
    writeDaemonPidRecord(paths.pidPath);
  } catch (error) {
    if (ownsStore) store.close();
    throw error;
  }
  const reconciler = new LeaseReconciler(store, config.reconciliationIntervalMs);
  let spoolTimer: NodeJS.Timeout | null = null;
  let closing: Promise<void> | null = null;
  let server!: Server;

  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = new Promise<void>((resolve, reject) => {
      reconciler.stop();
      if (spoolTimer) clearInterval(spoolTimer);
      server.close((error) => {
        try {
          if (existsSync(paths.socketPath)) unlinkSync(paths.socketPath);
          if (existsSync(paths.pidPath)) unlinkSync(paths.pidPath);
          if (ownsStore) store.close();
        } catch (cleanupError) {
          reject(cleanupError);
          return;
        }
        if (error) reject(error);
        else resolve();
      });
    });
    return closing;
  };

  const control: DaemonControl = { shutdown: close };
  server = createServer((socket) => {
    socket.setEncoding("utf8");
    // A client can time out while a request is still executing. Never let a
    // late response to that closed peer turn EPIPE into a daemon-wide crash.
    socket.on("error", () => socket.destroy());
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        const response: RpcFailureResponse = {
          jsonrpc: RPC_VERSION,
          id: null,
          error: { code: -32700, message: "RPC request exceeded 1 MB" }
        };
        send(socket, response);
        socket.end();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void handleLine(line, socket, dispatcher, store, paths, config, control);
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(paths.socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    try {
      if (existsSync(paths.pidPath)) unlinkSync(paths.pidPath);
      if (existsSync(paths.socketPath)) unlinkSync(paths.socketPath);
    } finally {
      if (ownsStore) store.close();
    }
    throw error;
  }
  chmodSync(paths.socketPath, 0o600);
  reconciler.start();
  let drainInFlight = false;
  const drain = async (): Promise<void> => {
    if (drainInFlight) return;
    drainInFlight = true;
    try {
      await drainHookSpool(paths.hookSpoolDir, (event) => {
        store.appendEvent(eventFromParams({ event }, store));
      }, SPOOL_DRAIN_BATCH_SIZE);
    } finally {
      drainInFlight = false;
    }
  };
  // Accept health/presence requests immediately. Large crash-recovery spools
  // drain in small background batches instead of blocking daemon readiness.
  setImmediate(() => void drain().catch(() => undefined));
  spoolTimer = setInterval(() => void drain().catch(() => undefined), SPOOL_DRAIN_INTERVAL_MS);
  spoolTimer.unref();
  return { server, store, dispatcher, paths, close };
}

async function handleLine(
  line: string,
  socket: Socket,
  dispatcher: RpcDispatcher,
  store: Store,
  paths: AgentGraphPaths,
  config: AgentGraphConfig,
  control: DaemonControl
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    send(socket, { jsonrpc: RPC_VERSION, id: null, error: { code: -32700, message: "Invalid JSON" } });
    return;
  }
  if (!isRpcRequest(parsed)) {
    send(socket, { jsonrpc: RPC_VERSION, id: null, error: { code: -32600, message: "Invalid RPC request" } });
    return;
  }
  const context: RpcContext = {
    store,
    socket,
    paths,
    config,
    control,
    requestedAt: new Date().toISOString()
  };
  send(socket, await dispatcher.dispatch(parsed, context));
}
