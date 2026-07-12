import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { getPaths } from "../config/paths.js";
import { rpc } from "../ipc/client.js";
import type { AgentActivity, ProcessMode, ProcessPresence, ProcessRegistration, Provider } from "../protocol/types.js";
import { ensureDaemonRunning } from "./lifecycle.js";
import { getProcessStartToken, terminalFingerprint } from "./process-inspection.js";
import { findRepositoryContext } from "./repository.js";

export interface SupervisedRunOptions {
  provider: Provider;
  executable: string;
  args?: string[];
  cwd?: string;
  mode?: ProcessMode;
  env?: NodeJS.ProcessEnv;
}

export interface SupervisedRunResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  presence: ProcessPresence;
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await Promise.race([
    once(child, "spawn").then(() => undefined),
    once(child, "error").then(([error]) => { throw error; })
  ]);
}

async function startToken(pid: number): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const token = getProcessStartToken(pid);
    if (token) return token;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Could not determine process start identity for PID ${pid}`);
}

export async function runSupervised(options: SupervisedRunOptions): Promise<SupervisedRunResult> {
  if (!options.executable) throw new Error("An executable is required");
  const paths = getPaths(options.env ?? process.env);
  await ensureDaemonRunning(paths);
  const runId = `run_${randomUUID().replaceAll("-", "")}`;
  const leaseToken = randomUUID();
  const cwd = options.cwd ?? process.cwd();
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    AGENTGRAPH_RUN_ID: runId,
    AGENTGRAPH_HOME: paths.homeDir,
    AGENTGRAPH_SOCKET_PATH: paths.socketPath
  };
  const child = spawn(options.executable, options.args ?? [], {
    cwd,
    env,
    stdio: "inherit",
    shell: false
  });
  // Subscribe before asynchronous registration work so a very short-lived
  // child cannot emit `close` before we begin waiting for it.
  const closePromise = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  await waitForSpawn(child);
  const pid = child.pid;
  if (!pid) throw new Error("Agent process did not provide a PID");
  const repository = findRepositoryContext(cwd);
  const registration: ProcessRegistration = {
    runId,
    leaseToken,
    provider: options.provider,
    mode: options.mode ?? "interactive",
    pid,
    processStartToken: await startToken(pid),
    executable: options.executable,
    // Prompts and secrets are sometimes passed as CLI arguments. Preserve the
    // executable and argument count without persisting argument contents.
    argv: [],
    cwd,
    repositoryRoot: repository.repositoryRoot,
    worktreeRoot: repository.worktreeRoot,
    terminal: terminalFingerprint(options.env ?? process.env),
    metadata: {
      wrapperPid: process.pid,
      argumentCount: options.args?.length ?? 0,
      transparentShim: process.env.AGENTGRAPH_TRANSPARENT_SHIM === "1"
    }
  };

  let presence: ProcessPresence;
  try {
    presence = await rpc<ProcessPresence>("process.register", registration, { socketPath: paths.socketPath });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  await rpc("event.append", { event: {
    provider: options.provider,
    source: "wrapper",
    process_instance_id: presence.id,
    terminal_id: presence.terminalId,
    kind: "process.registered",
    payload: { run_id: runId, pid },
    idempotency_key: `wrapper:${runId}:registered`
  } }, { socketPath: paths.socketPath, timeoutMs: 500 }).catch(() => undefined);

  let heartbeatInFlight = false;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    void rpc("process.heartbeat", { runId, leaseToken }, { socketPath: paths.socketPath, timeoutMs: 1_500 })
      .catch(() => undefined)
      .finally(() => { heartbeatInFlight = false; });
  }, 3_000);
  heartbeat.unref();

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  const [exitCode, signal] = await closePromise;
  clearInterval(heartbeat);
  for (const registeredSignal of signals) {
    const handler = signalHandlers.get(registeredSignal);
    if (handler) process.off(registeredSignal, handler);
  }
  const normalizedCode = exitCode ?? (signal ? 1 : 0);
  try {
    presence = await rpc<ProcessPresence>("process.exit", {
      runId,
      leaseToken,
      exitCode,
      exitSignal: signal
    }, { socketPath: paths.socketPath, timeoutMs: 1_000 });
    await rpc("event.append", { event: {
      provider: options.provider,
      source: "wrapper",
      process_instance_id: presence.id,
      terminal_id: presence.terminalId,
      kind: "process.exited",
      payload: { run_id: runId, pid, exit_code: exitCode, exit_signal: signal },
      idempotency_key: `wrapper:${runId}:exited`
    } }, { socketPath: paths.socketPath, timeoutMs: 500 });
  } catch {
    // The lease reconciler will mark a dead child exited after daemon recovery.
  }
  return { exitCode: normalizedCode, signal, presence };
}

export async function setSupervisedActivity(runId: string, leaseToken: string, activity: AgentActivity): Promise<ProcessPresence> {
  return await rpc<ProcessPresence>("process.heartbeat", { runId, leaseToken, activity });
}
