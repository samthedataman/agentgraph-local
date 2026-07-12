import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { z } from "zod";
import { VERSION } from "../version.js";
import {
  McpGateway,
  type McpIdentity,
  type RpcClientLike,
  withActorIdentity,
  withSourceIdentity
} from "./gateway.js";

const scopeKind = z.enum(["global", "repository", "worktree", "session"]);
const memoryKind = z.enum([
  "fact",
  "decision",
  "constraint",
  "preference",
  "procedure",
  "open_question",
  "warning",
  "session_summary",
  "handoff_summary"
]);
const sensitivity = z.enum(["public", "private", "secret"]);
const scope = z.object({ kind: scopeKind, key: z.string().min(1) });

export function createMcpServer(rpc: RpcClientLike, identity: McpIdentity = {}): McpServer {
  const gateway = new McpGateway(rpc, identity);
  const server = new McpServer({ name: "agentgraph", version: VERSION });

  server.registerTool(
    "presence_list",
    {
      title: "List local agent presence",
      description: "List live or recent Codex, Claude, and managed agent processes known to AgentGraph.",
      inputSchema: {
        includeExited: z.boolean().optional(),
        provider: z.string().optional(),
        repositoryRoot: z.string().optional(),
        recentSeconds: z.number().int().positive().max(86_400).optional()
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (args) => toolResult(await gateway.presenceList(args))
  );

  server.registerTool(
    "presence_whoami",
    {
      title: "Resolve the calling agent",
      description: "Resolve this MCP process to its supervised AgentGraph process/session identity.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () => toolResult(await gateway.whoAmI())
  );

  server.registerTool(
    "session_get",
    {
      description: "Get the presence record and recent event envelope for a provider session.",
      inputSchema: { sessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ sessionId }) => {
      const value = await gateway.sessionGet(sessionId);
      assertSessionResultAccess(value, identity);
      return toolResult(value);
    }
  );

  server.registerTool(
    "session_context",
    {
      description: "Build a bounded, provenance-bearing context pack for a session and repository scope.",
      inputSchema: {
        scope,
        query: z.string().optional(),
        includeGlobal: z.boolean().optional(),
        sessionId: z.string().optional(),
        provider: z.string().optional(),
        maxBytes: z.number().int().min(512).max(1_048_576).optional(),
        maxApproxTokens: z.number().int().min(128).max(262_144).optional()
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (args) => {
      assertScopeAccess(args.scope, identity);
      return toolResult(await gateway.contextPack(args));
    }
  );

  server.registerTool(
    "session_events",
    {
      description: "Read normalized recent events for one provider session.",
      inputSchema: {
        sessionId: z.string().min(1),
        kind: z.string().optional(),
        limit: z.number().int().positive().max(500).optional()
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ sessionId, ...filters }) => {
      const session = await gateway.sessionGet(sessionId);
      assertSessionResultAccess(session, identity);
      return toolResult(await gateway.call("event.list", { providerSessionId: sessionId, ...filters }));
    }
  );

  server.registerTool(
    "memory_search",
    {
      description: "Search current shared memory inside an explicit repository, worktree, session, or global scope.",
      inputSchema: {
        query: z.string(),
        scope,
        includeGlobal: z.boolean().optional(),
        includeSecret: z.boolean().optional(),
        kinds: z.array(memoryKind).optional(),
        limit: z.number().int().positive().max(100).optional()
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (args) => {
      assertScopeAccess(args.scope, identity);
      return toolResult(await gateway.call("memory.search", args));
    }
  );

  server.registerTool(
    "memory_neighbors",
    {
      description: "Read evidence-backed graph nodes and edges adjacent to a node.",
      inputSchema: {
        nodeId: z.string().min(1),
        direction: z.enum(["in", "out", "both"]).optional(),
        edgeTypes: z.array(z.string().min(1)).optional(),
        limit: z.number().int().positive().max(250).optional()
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (args) => {
      const value = await gateway.call("graph.neighbors", args);
      assertGraphResultAccess(value, identity);
      return toolResult(value);
    }
  );

  server.registerTool(
    "artifact_get",
    {
      description: "Read artifact metadata and optionally its bounded inline content.",
      inputSchema: { artifactId: z.string().min(1), includeContent: z.boolean().optional() },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (args) => {
      const value = await gateway.call("artifact.get", args);
      assertScopedEntityAccess(value, identity);
      return toolResult(value);
    }
  );

  server.registerTool(
    "handoff_inbox",
    {
      description: "List durable pending handoffs addressed to this or another explicit session.",
      inputSchema: {
        sessionId: z.string().optional(),
        provider: z.string().optional(),
        repository: z.string().optional(),
        states: z
          .array(z.enum(["queued", "delivered", "acknowledged", "claimed", "running"]))
          .optional(),
        limit: z.number().int().positive().max(100).optional()
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (args) => {
      assertRepositoryAccess(args.repository, identity);
      return toolResult(await gateway.inbox(args));
    }
  );

  server.registerTool(
    "memory_commit",
    {
      description: "Intentionally commit a durable fact, decision, constraint, procedure, or question with provenance.",
      inputSchema: {
        kind: memoryKind,
        text: z.string().min(1).max(65_536),
        scope,
        sourceSessionId: z.string().optional(),
        sources: z
          .array(
            z.object({
              type: z.enum(["event", "session", "artifact", "user", "agent", "file"]),
              id: z.string().min(1),
              excerpt: z.string().optional()
            })
          )
          .optional(),
        confidence: z.number().min(0).max(1).optional(),
        importance: z.number().min(0).max(1).optional(),
        sensitivity: sensitivity.optional(),
        expiresAt: z.string().optional(),
        metadata: z.record(z.unknown()).optional()
      }
    },
    async (args) => {
      const caller = await requireMutationIdentity(gateway);
      assertScopeAccess(args.scope, caller);
      return toolResult(await gateway.call("memory.commit", withSourceIdentity(args, caller)));
    }
  );

  server.registerTool(
    "memory_supersede",
    {
      description: "Replace a current memory while retaining an auditable SUPERSEDES relationship.",
      inputSchema: {
        memoryId: z.string().min(1),
        replacement: z.object({
          kind: memoryKind,
          text: z.string().min(1).max(65_536),
          scope,
          sourceSessionId: z.string().optional(),
          confidence: z.number().min(0).max(1).optional(),
          importance: z.number().min(0).max(1).optional(),
          sensitivity: sensitivity.optional()
        })
      }
    },
    async (args) => {
      const caller = await requireMutationIdentity(gateway);
      assertScopeAccess(args.replacement.scope, caller);
      const replacement = {
        ...args.replacement,
        sourceSessionId: caller.sessionId
      };
      return toolResult(await gateway.call("memory.supersede", { ...args, replacement }));
    }
  );

  server.registerTool(
    "artifact_publish",
    {
      description: "Publish bounded inline text or a content reference as a handoff artifact.",
      inputSchema: {
        name: z.string().min(1),
        scope,
        mediaType: z.string().optional(),
        content: z.string().max(262_144).optional(),
        contentRef: z.string().optional(),
        sourceSessionId: z.string().optional(),
        sourceEventId: z.string().optional(),
        sensitivity: sensitivity.optional(),
        metadata: z.record(z.unknown()).optional()
      }
    },
    async (args) => {
      const caller = await requireMutationIdentity(gateway);
      assertScopeAccess(args.scope, caller);
      return toolResult(await gateway.call("artifact.publish", withSourceIdentity(args, caller)));
    }
  );

  server.registerTool(
    "handoff_create",
    {
      description: "Create a bounded durable handoff. This queues work but does not start or control an agent.",
      inputSchema: {
        fromSession: z.string().optional(),
        target: z.object({
          sessionId: z.string().optional(),
          provider: z.string().optional(),
          repository: z.string().optional(),
          capability: z.string().optional()
        }),
        objective: z.string().min(1).max(32_768),
        contextRefs: z.array(z.string()).optional(),
        artifactRefs: z.array(z.string()).optional(),
        deliveryMode: z.enum(["next_turn", "manual_pull", "immediate_managed", "preview_channel"]).optional(),
        requiresAck: z.boolean().optional(),
        causalChain: z.array(z.string()).optional(),
        hopCount: z.number().int().min(0).max(20).optional(),
        maxHops: z.number().int().min(0).max(20).optional(),
        expiresAt: z.string().optional()
      }
    },
    async (args) => {
      const caller = await requireMutationIdentity(gateway);
      const params = { ...args } as Record<string, unknown>;
      params.fromSession = caller.sessionId;
      return toolResult(await gateway.call("handoff.create", params));
    }
  );

  server.registerTool(
    "handoff_acknowledge",
    {
      description: "Acknowledge that this session received a handoff.",
      inputSchema: { handoffId: z.string().min(1), actorSession: z.string().optional() }
    },
    async (args) => {
      const caller = await requireMutationIdentity(gateway);
      return toolResult(await gateway.call("handoff.acknowledge", withActorIdentity(args, caller)));
    }
  );

  server.registerTool(
    "handoff_claim",
    {
      description: "Claim an acknowledged or queued handoff for this recipient session.",
      inputSchema: { handoffId: z.string().min(1), actorSession: z.string().optional() }
    },
    async (args) => {
      const caller = await requireMutationIdentity(gateway);
      return toolResult(await gateway.call("handoff.claim", withActorIdentity(args, caller)));
    }
  );

  server.registerTool(
    "handoff_start",
    {
      description: "Mark a claimed or acknowledged handoff as actively running in this recipient session.",
      inputSchema: { handoffId: z.string().min(1), actorSession: z.string().optional() }
    },
    async (args) => {
      const caller = await requireMutationIdentity(gateway);
      return toolResult(await gateway.call("handoff.start", withActorIdentity(args, caller)));
    }
  );

  server.registerTool(
    "handoff_complete",
    {
      description: "Mark a claimed/running handoff complete and attach a concise result and artifact references.",
      inputSchema: {
        handoffId: z.string().min(1),
        actorSession: z.string().optional(),
        resultSummary: z.string().optional(),
        artifactRefs: z.array(z.string()).optional()
      }
    },
    async (args) => {
      const caller = await requireMutationIdentity(gateway);
      return toolResult(await gateway.call("handoff.complete", withActorIdentity(args, caller)));
    }
  );

  server.registerTool(
    "handoff_fail",
    {
      description: "Mark a handoff failed with a concise reason.",
      inputSchema: {
        handoffId: z.string().min(1),
        actorSession: z.string().optional(),
        error: z.string().min(1).max(32_768)
      }
    },
    async (args) => {
      const caller = await requireMutationIdentity(gateway);
      return toolResult(await gateway.call("handoff.fail", withActorIdentity(args, caller)));
    }
  );

  server.registerTool(
    "handoff_decline",
    {
      description: "Decline a queued, delivered, or acknowledged handoff without starting it.",
      inputSchema: {
        handoffId: z.string().min(1),
        actorSession: z.string().optional(),
        reason: z.string().max(32_768).optional()
      }
    },
    async (args) => {
      const caller = await requireMutationIdentity(gateway);
      return toolResult(await gateway.call("handoff.decline", withActorIdentity(args, caller)));
    }
  );

  server.registerTool(
    "handoff_cancel",
    {
      description: "Cancel a non-terminal handoff created by this sender session.",
      inputSchema: {
        handoffId: z.string().min(1),
        actorSession: z.string().optional(),
        reason: z.string().max(32_768).optional()
      }
    },
    async (args) => {
      const caller = await requireMutationIdentity(gateway);
      return toolResult(await gateway.call("handoff.cancel", withActorIdentity(args, caller)));
    }
  );

  server.registerResource(
    "live-sessions",
    "agentgraph://sessions/live",
    { description: "Current AgentGraph process/session presence", mimeType: "application/json" },
    async (uri) => resourceResult(uri, await gateway.presenceList({ includeExited: false }))
  );

  server.registerResource(
    "session",
    new ResourceTemplate("agentgraph://sessions/{id}", { list: undefined }),
    { description: "One provider session and its recent events", mimeType: "application/json" },
    async (uri, variables) => {
      const value = await gateway.sessionGet(String(variables.id));
      assertSessionResultAccess(value, identity);
      return resourceResult(uri, value);
    }
  );

  server.registerResource(
    "handoff",
    new ResourceTemplate("agentgraph://handoffs/{id}", { list: undefined }),
    { description: "One durable AgentGraph handoff", mimeType: "application/json" },
    async (uri, variables) => {
      const value = await gateway.call("handoff.get", { handoffId: String(variables.id) });
      assertHandoffAccess(value, identity);
      return resourceResult(uri, value);
    }
  );

  server.registerResource(
    "artifact",
    new ResourceTemplate("agentgraph://artifacts/{id}", { list: undefined }),
    { description: "Artifact metadata; content is not included automatically", mimeType: "application/json" },
    async (uri, variables) => {
      const value = await gateway.call("artifact.get", { artifactId: String(variables.id) });
      assertScopedEntityAccess(value, identity);
      return resourceResult(uri, value);
    }
  );

  return server;
}

export async function startMcpServer(rpc: RpcClientLike, identity: McpIdentity = {}): Promise<void> {
  const server = createMcpServer(rpc, identity);
  await server.connect(new StdioServerTransport());
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: pretty(value) }], structuredContent: jsonObject(value) };
}

function resourceResult(uri: URL, value: unknown) {
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: pretty(value) }] };
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

export function assertScopeAccess(scopeValue: unknown, identity: McpIdentity): void {
  if (!scopeValue || typeof scopeValue !== "object" || Array.isArray(scopeValue)) return;
  const scopeRecord = scopeValue as Record<string, unknown>;
  const kind = scopeRecord.kind;
  const key = scopeRecord.key;
  if (typeof kind !== "string" || typeof key !== "string") return;

  if (kind === "repository" && identity.repository && !samePath(key, identity.repository)) {
    throw new Error(`Repository scope ${key} does not match this MCP session's repository`);
  }
  if (kind === "worktree" && identity.worktree && !samePath(key, identity.worktree)) {
    throw new Error(`Worktree scope ${key} does not match this MCP session's worktree`);
  }
  if (kind === "session" && identity.sessionId && key !== identity.sessionId) {
    throw new Error("Session-scoped memory must use the resolved MCP session identity");
  }
}

function assertRepositoryAccess(repository: string | undefined, identity: McpIdentity): void {
  if (repository && identity.repository && !samePath(repository, identity.repository)) {
    throw new Error(`Repository ${repository} does not match this MCP session's repository`);
  }
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function assertScopedEntityAccess(value: unknown, identity: McpIdentity): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (record.sensitivity === "secret") {
    throw new Error("Secret artifacts are not exposed through the general MCP retrieval surface");
  }
  if (record.scope) assertScopeAccess(record.scope, identity);
}

function assertGraphResultAccess(value: unknown, identity: McpIdentity): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const nodes = (value as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) assertScopedEntityAccess(node, identity);
}

function assertSessionResultAccess(value: unknown, identity: McpIdentity): void {
  if (!identity.repository) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Session could not be resolved inside this repository");
  }
  const processRecord = (value as Record<string, unknown>).process;
  if (!processRecord || typeof processRecord !== "object" || Array.isArray(processRecord)) {
    throw new Error("Session could not be resolved inside this repository");
  }
  const repositoryRoot = (processRecord as Record<string, unknown>).repositoryRoot;
  if (typeof repositoryRoot !== "string" || !samePath(repositoryRoot, identity.repository)) {
    throw new Error("Session belongs to another repository");
  }
}

function assertHandoffAccess(value: unknown, identity: McpIdentity): void {
  if (!identity.repository || !value || typeof value !== "object" || Array.isArray(value)) return;
  const target = (value as Record<string, unknown>).target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return;
  const repository = (target as Record<string, unknown>).repository;
  if (typeof repository === "string" && !samePath(repository, identity.repository)) {
    throw new Error("Handoff belongs to another repository");
  }
}

async function requireMutationIdentity(gateway: McpGateway): Promise<McpIdentity & { sessionId: string }> {
  const identity = await gateway.resolveIdentity();
  if (!identity.sessionId) {
    throw new Error(
      "AgentGraph could not resolve this MCP caller to one live provider session; use an AgentGraph wrapper or attach the session before mutating shared state"
    );
  }
  return identity as McpIdentity & { sessionId: string };
}
