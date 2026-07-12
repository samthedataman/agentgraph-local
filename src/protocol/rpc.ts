export const RPC_VERSION = "1.0" as const;

export interface RpcRequest {
  jsonrpc: typeof RPC_VERSION;
  id: string;
  method: string;
  params?: unknown;
}

export interface RpcErrorData {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcSuccessResponse<T = unknown> {
  jsonrpc: typeof RPC_VERSION;
  id: string;
  result: T;
}

export interface RpcFailureResponse {
  jsonrpc: typeof RPC_VERSION;
  id: string | null;
  error: RpcErrorData;
}

export type RpcResponse<T = unknown> = RpcSuccessResponse<T> | RpcFailureResponse;

export function isRpcRequest(value: unknown): value is RpcRequest {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<RpcRequest>;
  return candidate.jsonrpc === RPC_VERSION && typeof candidate.id === "string" && typeof candidate.method === "string";
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<RpcResponse>;
  if (candidate.jsonrpc !== RPC_VERSION || !("id" in candidate)) return false;
  return "result" in candidate || "error" in candidate;
}

