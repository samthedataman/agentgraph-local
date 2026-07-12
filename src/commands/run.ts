import { runSupervised } from "../daemon/wrapper.js";
import { takeOption } from "../util/args.js";

export async function run(args: string[], _json: boolean): Promise<number> {
  const separator = args.indexOf("--");
  const ownArgs = separator === -1 ? [...args] : args.slice(0, separator);
  const commandArgs = separator === -1 ? [] : args.slice(separator + 1);
  const provider = takeOption(ownArgs, "--provider");
  const mode = takeOption(ownArgs, "--mode");
  const cwd = takeOption(ownArgs, "--cwd");
  let command: string | undefined;
  if (separator === -1) {
    command = ownArgs.shift();
    commandArgs.push(...ownArgs.splice(0));
  } else {
    command = commandArgs.shift();
    if (ownArgs.length) throw new Error(`Unknown run option: ${ownArgs[0]}`);
  }
  if (!provider) throw new Error("run requires --provider <codex|claude|custom>");
  if (!command) throw new Error("run requires an executable after --");
  if (mode && !new Set(["interactive", "background", "managed"]).has(mode)) {
    throw new Error("--mode must be interactive, background, or managed");
  }
  const result = await runSupervised({
    provider,
    executable: command,
    args: commandArgs,
    ...(cwd ? { cwd } : {}),
    ...(mode ? { mode: mode as "interactive" | "background" | "managed" } : {})
  });
  return result.exitCode;
}
