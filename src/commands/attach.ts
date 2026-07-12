import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { rpc } from "../ipc/client.js";
import type { DiscoveredProcess, ProcessPresence } from "../protocol/types.js";
import { takeFlag, takeOption } from "../util/args.js";
import { writeJson, writeLine } from "../util/output.js";

function describe(candidate: DiscoveredProcess, index?: number): string {
  const prefix = index === undefined ? "" : `${index + 1}. `;
  return `${prefix}${candidate.provider.padEnd(7)} PID ${String(candidate.pid).padEnd(7)} ${candidate.tty ?? "no tty"}  ${candidate.cwd ?? "unknown cwd"}`;
}

export async function run(args: string[], json: boolean): Promise<number> {
  const listOnly = takeFlag(args, "--list");
  const pidRaw = takeOption(args, "--pid") ?? args.shift();
  if (args.length) throw new Error(`Unknown attach option: ${args[0]}`);
  const candidates = await rpc<DiscoveredProcess[]>("process.discover");

  if (listOnly || (json && !pidRaw)) {
    if (json) writeJson(candidates);
    else candidates.forEach((candidate) => writeLine(describe(candidate)));
    return 0;
  }

  let pid: number;
  if (pidRaw) {
    pid = Number(pidRaw);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("PID must be a positive integer");
  } else {
    if (!candidates.length) {
      writeLine("No unattached Codex or Claude processes were discovered.");
      return 1;
    }
    if (!stdin.isTTY) throw new Error("Pass --pid <number> when stdin is not interactive");
    candidates.forEach((candidate, index) => writeLine(describe(candidate, index)));
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await readline.question("Attach which session? ");
      const selected = Number(answer) - 1;
      const candidate = candidates[selected];
      if (!candidate) throw new Error("Invalid selection");
      pid = candidate.pid;
    } finally {
      readline.close();
    }
  }

  const presence = await rpc<ProcessPresence>("process.attach", { pid });
  if (json) writeJson(presence);
  else writeLine(`Attached ${presence.provider} PID ${presence.pid} as ${presence.id} (${presence.confidence})`);
  return 0;
}

