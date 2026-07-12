export interface RpcClientLike {
  <T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface McpIdentity {
  runId?: string;
  sessionId?: string;
  provider?: string;
  repository?: string;
  worktree?: string;
}

/** Testable, transport-independent mapping between MCP concepts and daemon RPC. */
export class McpGateway {
  constructor(
    private readonly rpc: RpcClientLike,
    readonly identity: McpIdentity = {}
  ) {}

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.rpc<T>(method, params);
  }

  presenceList(filters: Record<string, unknown> = {}): Promise<unknown> {
    return this.call("process.list", filters);
  }

  private async resolvePresence(): Promise<{ identity: McpIdentity; process: Record<string, unknown> | null }> {
    const result = await this.presenceList({
      includeExited: false,
      ...(this.identity.provider ? { provider: this.identity.provider } : {}),
      ...(this.identity.repository ? { repositoryRoot: this.identity.repository } : {})
    });
    const processes = extractArray(result, "processes");
    let match = processes.find((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const item = candidate as Record<string, unknown>;
      return (
        (this.identity.runId !== undefined && item.runId === this.identity.runId) ||
        (this.identity.sessionId !== undefined && item.providerSessionId === this.identity.sessionId)
      );
    }) as Record<string, unknown> | undefined;
    if (!match) {
      const candidates = processes.filter((candidate): candidate is Record<string, unknown> => {
        if (!candidate || typeof candidate !== "object") return false;
        const item = candidate as Record<string, unknown>;
        if (typeof item.providerSessionId !== "string" || !item.providerSessionId) return false;
        if (this.identity.provider && item.provider !== this.identity.provider) return false;
        if (this.identity.repository && item.repositoryRoot !== this.identity.repository) return false;
        return true;
      });
      if (candidates.length === 1) match = candidates[0];
    }
    const resolved: McpIdentity = {
      ...this.identity,
      ...(typeof match?.runId === "string" ? { runId: match.runId } : {}),
      ...(typeof match?.providerSessionId === "string" ? { sessionId: match.providerSessionId } : {}),
      ...(typeof match?.provider === "string" ? { provider: match.provider } : {}),
      ...(typeof match?.repositoryRoot === "string" ? { repository: match.repositoryRoot } : {}),
      ...(typeof match?.worktreeRoot === "string" ? { worktree: match.worktreeRoot } : {})
    };
    return { identity: resolved, process: match ?? null };
  }

  async resolveIdentity(): Promise<McpIdentity> {
    return (await this.resolvePresence()).identity;
  }

  async whoAmI(): Promise<unknown> {
    const resolved = await this.resolvePresence();
    return {
      identity: resolved.identity,
      confidence: resolved.process?.confidence ?? (resolved.process ? "supervised" : "unresolved"),
      process: resolved.process
    };
  }

  async sessionGet(sessionId: string): Promise<unknown> {
    const [presence, events] = await Promise.all([
      this.presenceList({ includeExited: true }),
      this.call("event.list", { providerSessionId: sessionId, limit: 100 })
    ]);
    const process = extractArray(presence, "processes").find((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      return (candidate as Record<string, unknown>).providerSessionId === sessionId;
    });
    return { sessionId, process: process ?? null, events };
  }

  async contextPack(params: Record<string, unknown>): Promise<unknown> {
    return this.call("context.pack", withIdentity(params, await this.resolveIdentity()));
  }

  async inbox(params: Record<string, unknown>): Promise<unknown> {
    return this.call("handoff.inbox", withIdentity(params, await this.resolveIdentity()));
  }
}

export function withIdentity(params: Record<string, unknown>, identity: McpIdentity): Record<string, unknown> {
  const result = { ...params };
  if (result.sessionId === undefined && identity.sessionId !== undefined) result.sessionId = identity.sessionId;
  if (result.provider === undefined && identity.provider !== undefined) result.provider = identity.provider;
  if (result.repository === undefined && identity.repository !== undefined) result.repository = identity.repository;
  if (result.actorSession === undefined && identity.sessionId !== undefined) result.actorSession = identity.sessionId;
  return result;
}

/** Bind a mutating handoff action to the resolved caller when one is available. */
export function withActorIdentity(params: Record<string, unknown>, identity: McpIdentity): Record<string, unknown> {
  return {
    ...params,
    ...(identity.sessionId ? { actorSession: identity.sessionId } : {})
  };
}

/** Attach durable provenance to memory and artifacts created by an MCP caller. */
export function withSourceIdentity(params: Record<string, unknown>, identity: McpIdentity): Record<string, unknown> {
  return {
    ...params,
    ...(identity.sessionId ? { sourceSessionId: identity.sessionId } : {})
  };
}

function extractArray(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const candidate = (value as Record<string, unknown>)[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}
