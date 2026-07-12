import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { previewFleet, runFleet } from "../fleet/index.js";
import { takeFlag, takeOption } from "../util/args.js";
import { writeJson, writeLine } from "../util/output.js";

const MAX_PLAN_BYTES = 1024 * 1024;

async function readPlan(path: string): Promise<unknown> {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`Fleet plan is not a file: ${path}`);
  if (details.size > MAX_PLAN_BYTES) throw new Error(`Fleet plan exceeds ${MAX_PLAN_BYTES} bytes`);
  const source = await readFile(path, "utf8");
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Fleet plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function printPreview(preview: Awaited<ReturnType<typeof previewFleet>>): void {
  writeLine(`Fleet: ${preview.name}`);
  writeLine(`Tasks: ${preview.tasks.length} | concurrency: ${preview.root.maxConcurrency} | timeout: ${preview.root.timeoutMs}ms`);
  for (let index = 0; index < preview.waves.length; index += 1) {
    writeLine(`Wave ${index + 1}: ${(preview.waves[index] ?? []).join(", ")}`);
  }
  if (preview.preparationCommands.length > 0) {
    writeLine("Preparation commands (review, then run manually):");
    for (const command of preview.preparationCommands) writeLine(`  ${command}`);
  }
  for (const note of preview.executionNotes) writeLine(`Note: ${note}`);
  for (const warning of preview.warnings) writeLine(`Warning: ${warning}`);
}

export async function run(args: string[], json: boolean): Promise<number> {
  const dryRun = takeFlag(args, "--dry-run");
  const cwdOption = takeOption(args, "--cwd");
  const action = args.shift();
  if (action !== "run" && action !== "validate") {
    throw new Error("Usage: agentgraph fleet <validate|run> <plan.json> [--dry-run] [--cwd <directory>]");
  }
  const planArgument = args.shift();
  if (!planArgument || args.length > 0) {
    throw new Error("Usage: agentgraph fleet <validate|run> <plan.json> [--dry-run] [--cwd <directory>]");
  }
  const planPath = resolve(planArgument);
  const value = await readPlan(planPath);
  const options = { baseCwd: cwdOption ? resolve(cwdOption) : dirname(planPath) };
  if (dryRun || action === "validate") {
    const preview = await previewFleet(value, options);
    if (json) writeJson(preview);
    else printPreview(preview);
    return 0;
  }

  const result = await runFleet(value, options);
  if (json) writeJson(result);
  else {
    writeLine(`Fleet ${result.name}: ${result.status}`);
    writeLine(
      `${result.summary.succeeded} succeeded, ${result.summary.failed} failed, ` +
      `${result.summary.timedOut} timed out, ${result.summary.cancelled} cancelled, ${result.summary.skipped} skipped`
    );
    for (const task of result.tasks) writeLine(`${task.id} [${task.provider}]: ${task.status}`);
  }
  return result.status === "succeeded" ? 0 : 1;
}
