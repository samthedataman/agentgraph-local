import { copyFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export type JsonObject = Record<string, unknown>;

export interface WritePlan {
  path: string;
  changed: boolean;
  created: boolean;
  backupPath?: string;
  before: string | null;
  after: string;
}

export async function readJsonObject(path: string): Promise<{ value: JsonObject; text: string | null }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: {}, text: null };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Refusing to change invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Refusing to change ${path}: the top level must be a JSON object`);
  }
  return { value: parsed as JsonObject, text };
}

export function prettyJson(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function backupName(path: string, now: Date): string {
  const stamp = now.toISOString().replaceAll(/[:.]/g, "-");
  return `${path}.agentgraph-backup-${stamp}`;
}

/** Atomic owner-only write, with a same-directory backup for existing files. */
export async function writeConfigFile(
  path: string,
  before: string | null,
  after: string,
  options: { dryRun?: boolean; now?: Date } = {}
): Promise<WritePlan> {
  const changed = before !== after;
  const plan: WritePlan = {
    path,
    changed,
    created: before === null,
    before,
    after
  };
  if (!changed || options.dryRun) return plan;

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let mode = 0o600;
  if (before !== null) {
    try {
      mode = (await stat(path)).mode & 0o777;
    } catch {
      mode = 0o600;
    }
    const backupPath = backupName(path, options.now ?? new Date());
    await copyFile(path, backupPath);
    plan.backupPath = backupPath;
  }

  const temporary = `${path}.agentgraph-${process.pid}-${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(after, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return plan;
}
