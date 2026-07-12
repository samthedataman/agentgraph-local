import { rpc } from "../ipc/client.js";
import type { MemoryScope } from "../memory/types.js";
import { takeFlag, takeOption } from "../util/args.js";
import { writeJson, writeLine } from "../util/output.js";

export async function run(inputArgs: string[], json: boolean): Promise<number> {
  const args = [...inputArgs];
  const action = args.shift();
  if (!action || action === "help" || action === "--help" || action === "-h") {
    help();
    return 0;
  }

  if (action === "search") {
    const scope = takeScope(args);
    const limit = takeNumber(args, "--limit");
    const includeGlobal = takeFlag(args, "--include-global");
    const includeSecret = takeFlag(args, "--include-secret");
    const query = args.join(" ").trim();
    const result = await rpc("memory.search", {
      query,
      scope,
      includeGlobal,
      includeSecret,
      ...(limit === undefined ? {} : { limit })
    });
    output(result, json);
    return 0;
  }

  if (action === "put" || action === "commit") {
    const scope = takeScope(args);
    const kind = takeOption(args, "--type") ?? "fact";
    const sourceSessionId = takeOption(args, "--session") ?? process.env.AGENTGRAPH_SESSION_ID;
    const importance = takeDecimal(args, "--importance");
    const confidence = takeDecimal(args, "--confidence");
    const sensitivity = takeOption(args, "--sensitivity");
    const text = args.join(" ").trim();
    if (!text) throw new Error("memory put requires text");
    const result = await rpc("memory.commit", {
      kind,
      text,
      scope,
      ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(importance === undefined ? {} : { importance }),
      ...(confidence === undefined ? {} : { confidence }),
      ...(sensitivity ? { sensitivity } : {})
    });
    output(result, json);
    return 0;
  }

  if (action === "show") {
    const memoryId = required(args.shift(), "memory show requires a memory id");
    output(await rpc("memory.get", { memoryId }), json);
    return 0;
  }

  if (action === "supersede") {
    const memoryId = required(args.shift(), "memory supersede requires a memory id");
    const scope = takeScope(args);
    const kind = takeOption(args, "--type") ?? "fact";
    const sourceSessionId = takeOption(args, "--session") ?? process.env.AGENTGRAPH_SESSION_ID;
    const text = args.join(" ").trim();
    if (!text) throw new Error("memory supersede requires replacement text");
    output(
      await rpc("memory.supersede", {
        memoryId,
        replacement: { kind, text, scope, ...(sourceSessionId ? { sourceSessionId } : {}) }
      }),
      json
    );
    return 0;
  }

  if (action === "forget") {
    const memoryId = required(args.shift(), "memory forget requires a memory id");
    output(await rpc("memory.forget", { memoryId }), json);
    return 0;
  }

  throw new Error(`Unknown memory action: ${action}`);
}

function takeScope(args: string[]): MemoryScope {
  const kind = (takeOption(args, "--scope-kind") ?? "repository") as MemoryScope["kind"];
  const key =
    takeOption(args, "--scope") ??
    process.env.AGENTGRAPH_REPOSITORY_ROOT ??
    process.env.AGENTGRAPH_WORKTREE_ROOT ??
    process.cwd();
  return { kind, key };
}

function takeNumber(args: string[], name: string): number | undefined {
  const value = takeOption(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function takeDecimal(args: string[], name: string): number | undefined {
  const value = takeOption(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${name} must be between 0 and 1`);
  return parsed;
}

function output(value: unknown, json: boolean): void {
  if (json) writeJson(value);
  else writeLine(JSON.stringify(value, null, 2));
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function help(): void {
  writeLine("Usage:");
  writeLine('  agentgraph memory search "query" [--scope PATH] [--include-global] [--include-secret]');
  writeLine('  agentgraph memory put "durable fact" --type fact [--scope PATH]');
  writeLine("  agentgraph memory show <memory-id>");
  writeLine('  agentgraph memory supersede <memory-id> "replacement" --type decision');
  writeLine("  agentgraph memory forget <memory-id>");
}
