import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { getPaths } from "../config/paths.js";
import { RemoteSyncClient } from "../remote/client.js";
import { RemoteMemoryBridge } from "../remote/memory-bridge.js";
import { startRemoteHub } from "../remote/hub.js";
import { RemoteHubStore } from "../remote/store.js";
import type { RemoteRecordInput } from "../remote/types.js";
import { takeFlag, takeOption } from "../util/args.js";
import { writeJson, writeLine } from "../util/output.js";

export async function run(inputArgs: string[], json: boolean): Promise<number> {
  const args = [...inputArgs];
  const area = args.shift();
  if (!area || area === "help" || area === "--help" || area === "-h") {
    help();
    return 0;
  }
  if (area === "hub") return runHub(args, json);
  if (area === "sync") return runSync(args, json);
  throw new Error(`Unknown remote command: ${area}`);
}

async function runHub(args: string[], json: boolean): Promise<number> {
  const action = args.shift();
  if (action !== "serve") throw new Error("Usage: agentgraph remote hub serve [options]");
  const enabled = takeFlag(args, "--enable-remote-preview") || process.env.AGENTGRAPH_REMOTE_ENABLED === "1";
  if (!enabled) throw new Error("remote team sync is disabled; pass --enable-remote-preview to start the hub");
  const host = takeOption(args, "--host") ?? "127.0.0.1";
  const port = positiveInteger(takeOption(args, "--port") ?? "4320", "--port", true);
  const teamId = required(takeOption(args, "--team") ?? process.env.AGENTGRAPH_REMOTE_TEAM, "--team is required");
  const repositoryIds = required(
    takeOption(args, "--repositories") ?? takeOption(args, "--repository") ?? process.env.AGENTGRAPH_REMOTE_REPOSITORY,
    "--repository or --repositories is required"
  ).split(",").map((item) => item.trim()).filter(Boolean);
  const token = required(takeOption(args, "--token") ?? process.env.AGENTGRAPH_REMOTE_TOKEN, "AGENTGRAPH_REMOTE_TOKEN or --token is required");
  const tokenId = takeOption(args, "--token-id") ?? "bootstrap";
  const paths = getPaths();
  const databasePath = resolve(takeOption(args, "--database") ?? join(paths.homeDir, "remote-hub.sqlite3"));
  const certPath = takeOption(args, "--tls-cert");
  const keyPath = takeOption(args, "--tls-key");
  if ((certPath === undefined) !== (keyPath === undefined)) throw new Error("--tls-cert and --tls-key must be supplied together");
  const allowedHosts = commaList(takeOption(args, "--allowed-hosts"));
  const allowedOrigins = commaList(takeOption(args, "--allowed-origins"));
  const maxConcurrentRequests = optionalPositiveInteger(takeOption(args, "--max-concurrency"), "--max-concurrency");
  const rateLimitPerMinute = optionalPositiveInteger(takeOption(args, "--rate-per-minute"), "--rate-per-minute");
  if (args.length) throw new Error(`Unknown remote hub option: ${args[0]}`);

  const store = new RemoteHubStore(databasePath);
  try {
    store.putToken({ tokenId, token, teamId, repositoryIds });
    const hub = await startRemoteHub({
      enabled,
      host,
      port,
      store,
      ...(certPath && keyPath ? {
        tls: { cert: readFileSync(resolve(certPath)), key: readFileSync(resolve(keyPath)) }
      } : {}),
      ...(allowedHosts.length ? { allowedHosts } : {}),
      ...(allowedOrigins.length ? { allowedOrigins } : {}),
      ...(maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests }),
      ...(rateLimitPerMinute === undefined ? {} : { rateLimitPerMinute })
    });
    if (json) {
      writeJson({ status: "listening", url: hub.url, databasePath, teamId, repositoryIds, execution: false });
    } else {
      writeLine(`AgentGraph remote memory hub (developer preview): ${hub.url}`);
      writeLine(`Namespace: ${teamId} / ${repositoryIds.join(", ")}`);
      writeLine(`Separate hub database: ${databasePath}`);
      writeLine("Memory synchronization only; remote execution is not exposed.");
      writeLine("Press Ctrl-C to stop.");
    }
    await new Promise<void>((resolveStop) => {
      const stop = (): void => { void hub.close().finally(resolveStop); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  } finally {
    store.close();
  }
}

async function runSync(args: string[], json: boolean): Promise<number> {
  const action = args.shift();
  if (!action || !["once", "watch", "status", "drain"].includes(action)) {
    throw new Error("Usage: agentgraph remote sync <once|watch|status|drain> [options]");
  }
  const enabled = takeFlag(args, "--enable-remote-preview") || process.env.AGENTGRAPH_REMOTE_ENABLED === "1";
  const teamId = required(takeOption(args, "--team") ?? process.env.AGENTGRAPH_REMOTE_TEAM, "--team is required");
  const repositoryId = required(
    takeOption(args, "--repository") ?? process.env.AGENTGRAPH_REMOTE_REPOSITORY,
    "--repository is required"
  );
  const paths = getPaths();
  const statePath = resolve(takeOption(args, "--state") ?? join(paths.homeDir, "remote-sync", teamId, `${repositoryId}.json`));
  const url = takeOption(args, "--url") ?? process.env.AGENTGRAPH_REMOTE_URL ?? "http://127.0.0.1:4320";
  const suppliedToken = takeOption(args, "--token") ?? process.env.AGENTGRAPH_REMOTE_TOKEN;
  const token = action === "status" || action === "drain"
    ? suppliedToken ?? "status-only-placeholder-token"
    : required(suppliedToken, "AGENTGRAPH_REMOTE_TOKEN or --token is required");
  const recordsPath = takeOption(args, "--records");
  const waitMs = optionalPositiveInteger(takeOption(args, "--wait-ms"), "--wait-ms", true) ?? (action === "watch" ? 20_000 : 0);
  const bridgeMemory = takeFlag(args, "--bridge-memory");
  const sharePrivate = takeFlag(args, "--share-private");
  // Retained as a parsed compatibility option; durable mutation cursors now
  // replace query-based top-N memory snapshots for CLI synchronization.
  takeOption(args, "--query");
  const localScopeKey = resolve(takeOption(args, "--scope") ?? process.cwd());
  const originHostId = takeOption(args, "--origin-host") ?? process.env.AGENTGRAPH_HOST_ID ?? hostname();
  if (args.length) throw new Error(`Unknown remote sync option: ${args[0]}`);
  if (action !== "once" && recordsPath) throw new Error("--records is only valid with sync once");
  if ((action === "once" || action === "watch") && !enabled) {
    throw new Error("remote team sync is disabled; pass --enable-remote-preview");
  }

  const client = new RemoteSyncClient({ enabled, url, token, teamId, repositoryId, statePath });
  if (action === "status") {
    output(client.status(), json);
    return 0;
  }
  if (action === "drain") {
    output({ records: client.drainInbox() }, json);
    return 0;
  }
  const bridge = bridgeMemory ? new RemoteMemoryBridge({
    originHostId,
    ...(process.env.AGENTGRAPH_PROVIDER ? { originAgent: process.env.AGENTGRAPH_PROVIDER } : {}),
    ...(process.env.AGENTGRAPH_SESSION_ID ? { originSessionId: process.env.AGENTGRAPH_SESSION_ID } : {}),
    sharePrivate,
    localScope: { kind: "repository", key: localScopeKey }
  }) : null;
  let stagedMemory: Awaited<ReturnType<RemoteMemoryBridge["stageMemoryMutations"]>> | null = null;
  const stageMemoryMutations = async (): Promise<RemoteRecordInput[]> => {
    stagedMemory = bridge
      ? await bridge.stageMemoryMutations(client, { scope: { kind: "repository", key: localScopeKey } })
      : null;
    return [];
  };
  if (action === "watch") {
    const abort = new AbortController();
    const stop = (): void => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (!json) {
      writeLine(`Watching remote memory for ${teamId}/${repositoryId}; press Ctrl-C to stop.`);
      writeLine(bridge ? "Local memory bridge enabled (secret memories always excluded)." : "Transport-only mode; inbox records are not applied to local memory.");
    }
    try {
      await client.watch({
        signal: abort.signal,
        waitMs,
        beforeSync: stageMemoryMutations,
        onSync: async (syncResult) => {
          const applied = bridge ? await bridge.applyInbox(client) : null;
          output({
            sync: syncResult,
            ...(stagedMemory ? { memoryOutbox: stagedMemory } : {}),
            ...(applied ? { memoryBridge: applied } : {})
          }, json);
        },
        onError: (error, retryInMs) => {
          const event = { error: error.message, retryInMs };
          if (json) writeJson(event);
          else writeLine(`Remote sync error: ${error.message}; retrying in ${retryInMs}ms`);
        }
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return 0;
  }
  await stageMemoryMutations();
  const records = recordsPath ? readRecords(recordsPath) : [];
  const syncResult = await client.syncOnce(records, waitMs);
  const applied = bridge ? await bridge.applyInbox(client) : null;
  output({
    sync: syncResult,
    ...(stagedMemory ? { memoryOutbox: stagedMemory } : {}),
    ...(applied ? { memoryBridge: applied } : {})
  }, json);
  return 0;
}

function readRecords(path: string): RemoteRecordInput[] {
  const parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values as RemoteRecordInput[];
}

function positiveInteger(value: string, name: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function optionalPositiveInteger(value: string | undefined, name: string, allowZero = false): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, name, allowZero);
}

function commaList(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function output(value: unknown, json: boolean): void {
  if (json) writeJson(value);
  else writeLine(JSON.stringify(value, null, 2));
}

function help(): void {
  writeLine("AgentGraph remote team memory (opt-in developer preview)");
  writeLine("");
  writeLine("  agentgraph remote hub serve --enable-remote-preview --team TEAM --repository REPO");
  writeLine("  agentgraph remote sync once --enable-remote-preview --team TEAM --repository REPO [--records FILE]");
  writeLine("  agentgraph remote sync watch --enable-remote-preview --team TEAM --repository REPO --bridge-memory");
  writeLine("  agentgraph remote sync status --team TEAM --repository REPO");
  writeLine("  agentgraph remote sync drain --team TEAM --repository REPO");
  writeLine("");
  writeLine("Set AGENTGRAPH_REMOTE_TOKEN instead of placing bearer tokens in shell history.");
  writeLine("Non-loopback hubs require --tls-cert, --tls-key, and --allowed-hosts.");
}
