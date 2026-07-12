import { runSupervised } from "../daemon/wrapper.js";
import { findVendorExecutable } from "../setup/process.js";

export async function run(args: string[], _json: boolean): Promise<number> {
  const executable = process.env.AGENTGRAPH_REAL_CLAUDE ?? await findVendorExecutable("claude");
  if (!executable) throw new Error("Could not find the Claude executable");
  return (await runSupervised({ provider: "claude", executable, args })).exitCode;
}

