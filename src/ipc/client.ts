import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { getPaths } from "../config/paths.js";
import { RPC_VERSION, isRpcResponse, type RpcFailureResponse, type RpcRequest } from "../protocol/rpc.js";

export interface RpcOptions {
  timeoutMs?: number;
  socketPath?: string;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(response: RpcFailureResponse) {
    super(response.error.message);
    this.name = "RpcError";
    this.code = response.error.code;
    this.data = response.error.data;
  }
}

export function rpc<T = unknown>(method: string, params?: unknown, options: RpcOptions = {}): Promise<T> {
  const socketPath = options.socketPath ?? getPaths().socketPath;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const request: RpcRequest = {
    jsonrpc: RPC_VERSION,
    id: randomUUID(),
    method,
    ...(params === undefined ? {} : { params })
  };

  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`RPC ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref();

    function finish(error?: Error, value?: T): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value as T);
    }

    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        if (buffer.length > 2_000_000) finish(new Error("RPC response exceeded 2 MB"));
        return;
      }
      const line = buffer.slice(0, newline);
      try {
        const response: unknown = JSON.parse(line);
        if (!isRpcResponse(response) || response.id !== request.id) {
          finish(new Error("Invalid RPC response"));
        } else if ("error" in response) {
          finish(new RpcError(response));
        } else {
          finish(undefined, response.result as T);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) finish(new Error("RPC connection closed before a response was received"));
    });
  });
}

export function createRpcClient(defaults: RpcOptions = {}): <T = unknown>(method: string, params?: unknown, options?: RpcOptions) => Promise<T> {
  return <T = unknown>(method: string, params?: unknown, options: RpcOptions = {}) =>
    rpc<T>(method, params, { ...defaults, ...options });
}

