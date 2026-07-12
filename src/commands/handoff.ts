import { rpc } from "../ipc/client.js";
import { takeFlag, takeOption } from "../util/args.js";
import { writeJson, writeLine } from "../util/output.js";

export async function run(inputArgs: string[], json: boolean): Promise<number> {
  const args = [...inputArgs];
  const action = args.shift();
  if (!action || action === "help" || action === "--help" || action === "-h") {
    help();
    return 0;
  }

  if (action === "create") {
    const fromSession = takeOption(args, "--from") ?? process.env.AGENTGRAPH_SESSION_ID;
    if (!fromSession) throw new Error("handoff create requires --from or AGENTGRAPH_SESSION_ID");
    const target = compact({
      sessionId: takeOption(args, "--to"),
      provider: takeOption(args, "--provider"),
      repository: takeOption(args, "--repo") ?? process.env.AGENTGRAPH_REPOSITORY_ROOT,
      capability: takeOption(args, "--capability")
    });
    const expiresAt = takeOption(args, "--expires");
    const deliveryMode = takeOption(args, "--delivery") ?? "next_turn";
    const requiresAck = !takeFlag(args, "--no-ack");
    const contextRefs = csv(takeOption(args, "--context"));
    const artifactRefs = csv(takeOption(args, "--artifacts"));
    const objective = args.join(" ").trim();
    if (!objective) throw new Error("handoff create requires an objective");
    output(
      await rpc("handoff.create", {
        fromSession,
        target,
        objective,
        deliveryMode,
        requiresAck,
        ...(expiresAt ? { expiresAt } : {}),
        ...(contextRefs.length ? { contextRefs } : {}),
        ...(artifactRefs.length ? { artifactRefs } : {})
      }),
      json
    );
    return 0;
  }

  if (action === "inbox") {
    const sessionId = takeOption(args, "--session") ?? process.env.AGENTGRAPH_SESSION_ID;
    if (!sessionId) throw new Error("handoff inbox requires --session or AGENTGRAPH_SESSION_ID");
    const provider = takeOption(args, "--provider") ?? process.env.AGENTGRAPH_PROVIDER;
    const repository = takeOption(args, "--repo") ?? process.env.AGENTGRAPH_REPOSITORY_ROOT;
    output(
      await rpc("handoff.inbox", {
        sessionId,
        ...(provider ? { provider } : {}),
        ...(repository ? { repository } : {})
      }),
      json
    );
    return 0;
  }

  if (action === "list") {
    const fromSession = takeOption(args, "--from");
    output(await rpc("handoff.list", fromSession ? { fromSession } : {}), json);
    return 0;
  }

  if (action === "show") {
    output(await rpc("handoff.get", { handoffId: need(args.shift(), "handoff show requires an id") }), json);
    return 0;
  }

  const handoffId = need(args.shift(), `handoff ${action} requires an id`);
  const actorSession = takeOption(args, "--session") ?? process.env.AGENTGRAPH_SESSION_ID;
  if (!actorSession) throw new Error(`handoff ${action} requires --session or AGENTGRAPH_SESSION_ID`);

  if (new Set(["ack", "acknowledge", "claim", "start"]).has(action)) {
    const method = action === "ack" ? "acknowledge" : action;
    output(await rpc(`handoff.${method}`, { handoffId, actorSession }), json);
    return 0;
  }
  if (action === "complete") {
    const artifactRefs = csv(takeOption(args, "--artifacts"));
    const resultSummary = args.join(" ").trim();
    output(
      await rpc("handoff.complete", {
        handoffId,
        actorSession,
        ...(resultSummary ? { resultSummary } : {}),
        ...(artifactRefs.length ? { artifactRefs } : {})
      }),
      json
    );
    return 0;
  }
  if (action === "fail") {
    const error = args.join(" ").trim();
    if (!error) throw new Error("handoff fail requires a reason");
    output(await rpc("handoff.fail", { handoffId, actorSession, error }), json);
    return 0;
  }
  if (action === "decline" || action === "cancel") {
    const reason = args.join(" ").trim();
    output(
      await rpc(`handoff.${action}`, { handoffId, actorSession, ...(reason ? { reason } : {}) }),
      json
    );
    return 0;
  }
  throw new Error(`Unknown handoff action: ${action}`);
}

function compact(value: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function csv(value: string | undefined): string[] {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function output(value: unknown, json: boolean): void {
  if (json) writeJson(value);
  else writeLine(JSON.stringify(value, null, 2));
}

function need(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function help(): void {
  writeLine("Usage:");
  writeLine('  agentgraph handoff create "objective" --from SESSION (--to SESSION | --provider claude)');
  writeLine("  agentgraph handoff inbox --session SESSION [--provider claude] [--repo PATH]");
  writeLine("  agentgraph handoff ack|claim|start <id> --session SESSION");
  writeLine('  agentgraph handoff complete <id> "result" --session SESSION [--artifacts id,id]');
  writeLine('  agentgraph handoff fail|decline|cancel <id> "reason" --session SESSION');
}

