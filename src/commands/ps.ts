import { rpc } from "../ipc/client.js";
import type { ProcessPresence } from "../protocol/types.js";
import { takeFlag, takeOption } from "../util/args.js";
import { writeJson, writeLine } from "../util/output.js";

function age(iso: string | null): string {
  if (!iso) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function compact(value: string | null, width: number): string {
  if (!value) return "—";
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(1, width - 1))}…`;
}

function terminalLabel(process: ProcessPresence): string {
  return process.terminal?.tmuxPane ?? process.terminal?.tty?.replace("/dev/", "") ?? "—";
}

function repositoryLabel(process: ProcessPresence): string {
  const root = process.repositoryRoot;
  return root ? root.split("/").filter(Boolean).at(-1) ?? root : "—";
}

function renderTable(processes: ProcessPresence[]): string {
  if (!processes.length) return "No live agent sessions found.";
  const headers = ["ID", "AGENT", "STATE", "ACTIVITY", "TERMINAL", "REPOSITORY", "SESSION", "SEEN"];
  const rows = processes.map((entry) => [
    compact(entry.id, 11),
    entry.provider,
    entry.state,
    entry.activity,
    terminalLabel(entry),
    repositoryLabel(entry),
    compact(entry.providerSessionId, 13),
    age(entry.lastSeenAt)
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  return [headers, ...rows]
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd())
    .join("\n");
}

export async function run(args: string[], json: boolean): Promise<number> {
  const watch = takeFlag(args, "--watch") || takeFlag(args, "-w");
  const includeExited = takeFlag(args, "--recent") || takeFlag(args, "--all");
  const recentRaw = takeOption(args, "--recent-seconds");
  const repositoryRoot = takeOption(args, "--repo");
  const provider = takeOption(args, "--provider");
  if (args.length) throw new Error(`Unknown ps option: ${args[0]}`);
  const recentSeconds = recentRaw === undefined ? undefined : Number(recentRaw);
  if (recentSeconds !== undefined && (!Number.isFinite(recentSeconds) || recentSeconds <= 0)) {
    throw new Error("--recent-seconds must be a positive number");
  }
  const params = {
    includeExited: includeExited || recentSeconds !== undefined,
    ...(recentSeconds === undefined ? {} : { recentSeconds }),
    ...(repositoryRoot ? { repositoryRoot } : {}),
    ...(provider ? { provider } : {})
  };

  const show = async (): Promise<void> => {
    // Presence includes joined session metadata and can briefly wait on a
    // busy SQLite WAL. This read-only command gets a practical timeout.
    const processes = await rpc<ProcessPresence[]>("process.list", params, { timeoutMs: 15_000 });
    if (json) writeJson(processes);
    else writeLine(renderTable(processes));
  };
  await show();
  if (!watch) return 0;
  await new Promise<void>((resolve, reject) => {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      if (!json && process.stdout.isTTY) process.stdout.write("\u001b[2J\u001b[H");
      void show().catch(reject).finally(() => { running = false; });
    }, 1_000);
    const stop = (): void => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}
