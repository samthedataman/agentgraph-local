import { runSupervised } from "../daemon/wrapper.js";
import { findVendorExecutable } from "../setup/process.js";

export async function run(args: string[], _json: boolean): Promise<number> {
  const executable = process.env.AGENTGRAPH_REAL_CODEX ?? await findVendorExecutable("codex");
  if (!executable) throw new Error("Could not find the Codex executable");
  return (await runSupervised({ provider: "codex", executable, args })).exitCode;
}

