import { once } from "node:events";
import { daemonHealth, ensureDaemonRunning, spawnDaemonDetached, stopDaemon } from "../daemon/lifecycle.js";
import { startDaemonServer } from "../daemon/server.js";
import { rpc } from "../ipc/client.js";
import { writeJson, writeLine } from "../util/output.js";

function print(value: unknown, json: boolean): void {
  if (json) writeJson(value);
  else if (typeof value === "string") writeLine(value);
  else writeLine(JSON.stringify(value, null, 2));
}

async function serve(json: boolean): Promise<number> {
  const daemon = await startDaemonServer();
  if (!json) writeLine(`AgentGraph daemon listening at ${daemon.paths.socketPath}`);
  const shutdown = (): void => { void daemon.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGHUP", shutdown);
  await once(daemon.server, "close");
  process.off("SIGINT", shutdown);
  process.off("SIGTERM", shutdown);
  process.off("SIGHUP", shutdown);
  return 0;
}

export async function run(args: string[], json: boolean): Promise<number> {
  const action = args.shift() ?? "status";
  if (args.length) throw new Error(`Unknown daemon option: ${args[0]}`);
  if (action === "serve" || action === "foreground" || action === "run") return await serve(json);
  if (action === "start") {
    try {
      const existing = await daemonHealth();
      print(existing, json);
      return 0;
    } catch {
      spawnDaemonDetached();
      const health = await ensureDaemonRunning();
      print(json ? health : `AgentGraph daemon started (PID ${health.pid})`, json);
      return 0;
    }
  }
  if (action === "stop") {
    const stopped = await stopDaemon();
    print(json ? { stopped } : stopped ? "AgentGraph daemon stopped" : "AgentGraph daemon was not running", json);
    return 0;
  }
  if (action === "restart") {
    await stopDaemon();
    spawnDaemonDetached();
    const health = await ensureDaemonRunning();
    print(json ? health : `AgentGraph daemon restarted (PID ${health.pid})`, json);
    return 0;
  }
  if (action === "status") {
    try {
      const health = await daemonHealth();
      print(health, json);
      return 0;
    } catch (error) {
      print(json
        ? { ok: false, error: error instanceof Error ? error.message : String(error) }
        : "AgentGraph daemon is not running", json);
      return 1;
    }
  }
  if (action === "reconcile") {
    const result = await rpc("process.reconcile");
    print(result, json);
    return 0;
  }
  throw new Error(`Unknown daemon action: ${action}`);
}

