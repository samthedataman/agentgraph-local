import { createRpcClient } from "../ipc/client.js";
import { startMcpServer } from "../mcp/server.js";
import type { McpIdentity } from "../mcp/gateway.js";
import { findRepositoryContext } from "../daemon/repository.js";
import { takeOption } from "../util/args.js";

export async function run(args: string[], _json: boolean): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write("Usage: agentgraph mcp [--provider codex|claude]\nStarts the local stdio MCP server.\n");
    return 0;
  }
  const providerOption = takeOption(args, "--provider");
  if (providerOption && providerOption !== "codex" && providerOption !== "claude") {
    throw new Error("--provider must be codex or claude");
  }
  if (args.length) throw new Error(`Unknown mcp option: ${args[0]}`);
  const repositoryContext = findRepositoryContext(process.cwd());
  const repository = process.env.AGENTGRAPH_REPOSITORY_ROOT
    ?? repositoryContext.repositoryRoot
    ?? process.cwd();
  const worktree = process.env.AGENTGRAPH_WORKTREE_ROOT
    ?? repositoryContext.worktreeRoot
    ?? repository;
  const provider = process.env.AGENTGRAPH_PROVIDER ?? providerOption;
  const identity: McpIdentity = {
    ...(process.env.AGENTGRAPH_RUN_ID ? { runId: process.env.AGENTGRAPH_RUN_ID } : {}),
    ...(process.env.AGENTGRAPH_SESSION_ID ? { sessionId: process.env.AGENTGRAPH_SESSION_ID } : {}),
    ...(provider ? { provider } : {}),
    repository,
    worktree
  };
  await startMcpServer(createRpcClient(), identity);
  return 0;
}
