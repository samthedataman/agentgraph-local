import { startA2AServer } from "../a2a/server.js";
import { takeOption } from "../util/args.js";
import { writeJson, writeLine } from "../util/output.js";

export async function run(args: string[], json: boolean): Promise<number> {
  const action = args.shift() ?? "serve";
  if (action !== "serve") throw new Error("Usage: agentgraph a2a serve [--port 4319]");
  const port = Number(takeOption(args, "--port") ?? 4319);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be between 0 and 65535");
  const host = takeOption(args, "--host") ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("The experimental A2A server is local-only; bind to 127.0.0.1");
  }
  const providerText = takeOption(args, "--provider");
  const defaultProvider = providerText === "claude" ? "claude" : "codex";
  const cwd = takeOption(args, "--cwd") ?? process.cwd();
  const suppliedToken = takeOption(args, "--token") ?? process.env.AGENTGRAPH_A2A_TOKEN;
  const maxConcurrentTasks = numericOption(
    args,
    "--max-concurrency",
    process.env.AGENTGRAPH_A2A_MAX_CONCURRENCY
  );
  const maxRequestBytes = numericOption(
    args,
    "--max-request-bytes",
    process.env.AGENTGRAPH_A2A_MAX_REQUEST_BYTES
  );
  const maxOutputBytes = numericOption(
    args,
    "--max-output-bytes",
    process.env.AGENTGRAPH_A2A_MAX_OUTPUT_BYTES
  );
  if (args.length) throw new Error(`Unknown a2a option: ${args[0]}`);
  const server = await startA2AServer({
    host,
    port,
    defaultProvider,
    cwd,
    ...(suppliedToken ? { token: suppliedToken } : {}),
    ...(maxConcurrentTasks === undefined ? {} : { maxConcurrentTasks }),
    ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes })
  });
  if (json) {
    writeJson({
      status: "listening",
      url: server.url,
      authentication: suppliedToken ? "supplied bearer token" : "generated bearer token",
      ...(suppliedToken ? {} : { bearerToken: server.token })
    });
  } else {
    writeLine(`AgentGraph experimental A2A façade: ${server.url}`);
    writeLine(`Agent Card: ${server.url}/.well-known/agent-card.json`);
    writeLine(suppliedToken
      ? "Bearer token: using the supplied --token/AGENTGRAPH_A2A_TOKEN value (not echoed)."
      : `Bearer token (shown once): ${server.token}`);
    writeLine("Press Ctrl-C to stop.");
  }

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void server.close().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

function numericOption(args: string[], name: string, envValue: string | undefined): number | undefined {
  const raw = takeOption(args, name) ?? envValue;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
