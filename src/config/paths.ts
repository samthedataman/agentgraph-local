import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AgentGraphPaths {
  homeDir: string;
  runDir: string;
  socketPath: string;
  databasePath: string;
  pidPath: string;
  logDir: string;
  spoolDir: string;
  hookSpoolDir: string;
  configPath: string;
}

function absoluteFrom(base: string, value: string | undefined, fallback: string): string {
  return resolve(value ?? join(base, fallback));
}

export function getPaths(env: NodeJS.ProcessEnv = process.env): AgentGraphPaths {
  const homeDir = resolve(env.AGENTGRAPH_HOME ?? join(env.HOME ?? homedir(), ".agentgraph"));
  const runDir = absoluteFrom(homeDir, env.AGENTGRAPH_RUN_DIR, "run");
  const spoolDir = absoluteFrom(homeDir, env.AGENTGRAPH_SPOOL_DIR, "spool");
  return {
    homeDir,
    runDir,
    socketPath: absoluteFrom(runDir, env.AGENTGRAPH_SOCKET_PATH, "agentgraph.sock"),
    databasePath: absoluteFrom(homeDir, env.AGENTGRAPH_DATABASE_PATH, "agentgraph.sqlite3"),
    pidPath: absoluteFrom(runDir, env.AGENTGRAPH_PID_PATH, "agentgraph.pid"),
    logDir: absoluteFrom(homeDir, env.AGENTGRAPH_LOG_DIR, "logs"),
    spoolDir,
    hookSpoolDir: absoluteFrom(spoolDir, env.AGENTGRAPH_HOOK_SPOOL_DIR, "hooks"),
    configPath: absoluteFrom(homeDir, env.AGENTGRAPH_CONFIG_PATH, "config.json")
  };
}

export function ensureDirectories(paths: AgentGraphPaths = getPaths()): AgentGraphPaths {
  for (const directory of [paths.homeDir, paths.runDir, paths.logDir, paths.spoolDir, paths.hookSpoolDir]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Some network filesystems do not implement chmod; socket/database creation
      // will still fail closed if the user cannot write to the directory.
    }
  }
  return paths;
}

