export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  contextId: string;
  provider: "codex" | "claude";
  status: {
    state: "submitted" | "working" | "completed" | "failed" | "canceled";
    timestamp: string;
    message?: unknown;
  };
  artifacts: Array<{
    artifactId: string;
    name: string;
    parts: Array<{ kind: "text"; text: string }>;
  }>;
}
