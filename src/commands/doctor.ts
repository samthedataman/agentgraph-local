import { runDoctor } from "../setup/doctor.js";
import { takeFlag } from "../util/args.js";
import { writeJson, writeLine } from "../util/output.js";

export async function run(args: string[], json: boolean): Promise<number> {
  const requireTransparent = takeFlag(args, "--transparent");
  if (args.length > 0) throw new Error(`Unknown doctor option: ${args[0]}`);
  const report = await runDoctor({ requireTransparent });
  if (json) {
    writeJson(report);
  } else {
    for (const check of report.checks) {
      const marker = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
      writeLine(`${marker} ${check.name}: ${check.message}`);
    }
    writeLine(report.ok ? "\nAgentGraph is ready." : "\nAgentGraph needs attention. Run `agentgraph setup` and retry.");
  }
  return report.ok ? 0 : 1;
}
