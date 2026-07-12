import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { getPaths } from "../config/paths.js";
import type { HookEnvironment, NormalizedHookEvent } from "./types.js";

export interface SpoolOptions {
  directory?: string;
  env?: HookEnvironment;
  maxFiles?: number;
  maxEventBytes?: number;
}

export interface DrainSpoolResult {
  delivered: number;
  retried: number;
  quarantined: number;
}

const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_EVENT_BYTES = 512 * 1024;

export function defaultHookSpoolDirectory(
  env: HookEnvironment = process.env as HookEnvironment
): string {
  return getPaths(env as NodeJS.ProcessEnv).hookSpoolDir;
}

function safeEventName(eventId: string): string {
  return eventId.replaceAll(/[^A-Za-z0-9_.-]/g, "_");
}

async function enforceFileLimit(directory: string, maxFiles: number): Promise<void> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".event"));
  if (entries.length >= maxFiles) {
    throw new Error(`Hook spool is full (${entries.length}/${maxFiles} events)`);
  }
}

/**
 * Persist one event with write-then-rename semantics. A daemon can safely drain
 * only `*.event` files and will never observe a partially written event.
 */
export async function spoolHookEvent(
  event: NormalizedHookEvent,
  options: SpoolOptions = {}
): Promise<string> {
  const directory = options.directory ?? defaultHookSpoolDirectory(options.env);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const serialized = `${JSON.stringify({ event })}\n`;
  if (Buffer.byteLength(serialized) > maxEventBytes) {
    throw new Error(`Hook event exceeds spool limit of ${maxEventBytes} bytes`);
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await enforceFileLimit(directory, maxFiles);

  const base = `${Date.now()}-${safeEventName(event.event_id)}`;
  const temporaryPath = join(directory, `.${base}.${process.pid}.tmp`);
  const finalPath = join(directory, `${base}.event`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return finalPath;
}

export async function hookSpoolIsAccessible(directory: string): Promise<boolean> {
  try {
    await access(directory, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically claim and replay completed spool files. Delivery is idempotent at
 * the event store, malformed files are quarantined, and transient failures are
 * renamed back for the next drain pass.
 */
export async function drainHookSpool(
  directory: string,
  deliver: (event: NormalizedHookEvent) => void | Promise<void>,
  limit = DEFAULT_MAX_FILES
): Promise<DrainSpoolResult> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".event"))
    .sort()
    .slice(0, Math.max(1, limit));
  const result: DrainSpoolResult = { delivered: 0, retried: 0, quarantined: 0 };

  for (const name of names) {
    const eventPath = join(directory, name);
    const processingPath = join(directory, `${name.slice(0, -6)}.processing`);
    try {
      await rename(eventPath, processingPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    let event: NormalizedHookEvent;
    try {
      const parsed = JSON.parse(await readFile(processingPath, "utf8")) as { event?: unknown };
      if (!parsed.event || typeof parsed.event !== "object" || Array.isArray(parsed.event)) {
        throw new Error("Spool record does not contain an event object");
      }
      event = parsed.event as NormalizedHookEvent;
    } catch {
      await rename(processingPath, `${processingPath}.invalid`);
      result.quarantined += 1;
      continue;
    }

    try {
      await deliver(event);
      await rm(processingPath, { force: true });
      result.delivered += 1;
    } catch {
      await rename(processingPath, eventPath);
      result.retried += 1;
    }
  }
  return result;
}
