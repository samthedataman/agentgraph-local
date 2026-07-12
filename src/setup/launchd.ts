import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { writeConfigFile, type WritePlan } from "./files.js";
import { runCommand, type CommandResult, type CommandRunner } from "./process.js";

export const LAUNCHD_LABEL = "com.agentgraph.daemon";

export interface LaunchdOptions {
  nodePath: string;
  cliPath: string;
  home?: string;
  path?: string;
  dryRun?: boolean;
  platform?: NodeJS.Platform;
  uid?: number;
  runner?: CommandRunner;
  now?: Date;
}

export interface LaunchdInstallResult {
  supported: boolean;
  loaded: boolean;
  reason?: string;
  write?: WritePlan;
  commands: Array<{ executable: string; args: string[] }>;
  results: CommandResult[];
}

export interface LaunchdUninstallOptions {
  home?: string;
  path?: string;
  dryRun?: boolean;
  platform?: NodeJS.Platform;
  uid?: number;
  runner?: CommandRunner;
}

export interface LaunchdUninstallResult {
  supported: boolean;
  removed: boolean;
  skipped: boolean;
  path: string;
  reason?: string;
  commands: Array<{ executable: string; args: string[] }>;
  results: CommandResult[];
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function launchAgentPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function renderLaunchAgent(options: {
  nodePath: string;
  cliPath: string;
  home: string;
}): string {
  const logDir = join(options.home, ".agentgraph", "logs");
  const args = [resolve(options.nodePath), resolve(options.cliPath), "daemon", "serve"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(options.home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(logDir, "daemon.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, "daemon.error.log"))}</string>
</dict>
</plist>
`;
}

export async function installLaunchAgent(options: LaunchdOptions): Promise<LaunchdInstallResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      supported: false,
      loaded: false,
      reason: "Automatic daemon installation currently supports macOS launchd only",
      commands: [],
      results: []
    };
  }
  const home = options.home ?? process.env.HOME ?? homedir();
  const path = options.path ?? launchAgentPath(home);
  const plist = renderLaunchAgent({ nodePath: options.nodePath, cliPath: options.cliPath, home });
  let before: string | null = null;
  try {
    before = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const write = await writeConfigFile(path, before, plist, {
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.now ? { now: options.now } : {})
  });
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) {
    return {
      supported: false,
      loaded: false,
      reason: "Could not determine the current user id for launchd",
      write,
      commands: [],
      results: []
    };
  }
  const domain = `gui/${uid}`;
  const commands = [
    { executable: "/bin/launchctl", args: ["bootout", domain, path] },
    { executable: "/bin/launchctl", args: ["bootstrap", domain, path] }
  ];
  if (options.dryRun) {
    return { supported: true, loaded: false, write, commands, results: [] };
  }

  await mkdir(join(home, ".agentgraph", "logs"), { recursive: true, mode: 0o700 });
  const runner = options.runner ?? runCommand;
  // bootout is intentionally best-effort: it returns non-zero on first install.
  const bootout = await runner(commands[0]?.executable ?? "/bin/launchctl", commands[0]?.args ?? [], {
    timeoutMs: 5_000
  });
  const bootstrap = await runner(commands[1]?.executable ?? "/bin/launchctl", commands[1]?.args ?? [], {
    timeoutMs: 5_000
  });
  return {
    supported: true,
    loaded: bootstrap.code === 0,
    ...(bootstrap.code === 0
      ? {}
      : { reason: bootstrap.stderr.trim() || bootstrap.stdout.trim() || "launchctl bootstrap failed" }),
    write,
    commands,
    results: [bootout, bootstrap]
  };
}

export async function uninstallLaunchAgent(
  options: LaunchdUninstallOptions = {}
): Promise<LaunchdUninstallResult> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? process.env.HOME ?? homedir();
  const path = options.path ?? launchAgentPath(home);
  if (platform !== "darwin") {
    return {
      supported: false,
      removed: false,
      skipped: true,
      path,
      reason: "Automatic daemon removal currently supports macOS launchd only",
      commands: [],
      results: []
    };
  }
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        supported: true,
        removed: false,
        skipped: false,
        path,
        reason: "AgentGraph LaunchAgent was not present",
        commands: [],
        results: []
      };
    }
    throw error;
  }
  if (!content.includes(`<string>${LAUNCHD_LABEL}</string>`) || !content.includes("daemon")) {
    return {
      supported: true,
      removed: false,
      skipped: true,
      path,
      reason: `Refusing to remove unrecognized launchd file at ${path}`,
      commands: [],
      results: []
    };
  }
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) {
    return {
      supported: false,
      removed: false,
      skipped: true,
      path,
      reason: "Could not determine the current user id for launchd",
      commands: [],
      results: []
    };
  }
  const command = {
    executable: "/bin/launchctl",
    args: ["bootout", `gui/${uid}`, path]
  };
  if (options.dryRun) {
    return {
      supported: true,
      removed: false,
      skipped: false,
      path,
      commands: [command],
      results: []
    };
  }
  const result = await (options.runner ?? runCommand)(command.executable, command.args, {
    timeoutMs: 5_000
  });
  // The file is still ours even when the service was already unloaded.
  await rm(path);
  return {
    supported: true,
    removed: true,
    skipped: false,
    path,
    commands: [command],
    results: [result]
  };
}
