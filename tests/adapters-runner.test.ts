import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInvocation } from "../src/adapters/runner.js";

describe("managed adapter runner", () => {
  it("captures JSONL events and a final response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentgraph-runner-"));
    const fixture = join(directory, "fixture.mjs");
    await writeFile(
      fixture,
      [
        'console.log(JSON.stringify({type:"session",session_id:"s-1"}));',
        'console.log(JSON.stringify({type:"result",result:"finished"}));'
      ].join("\n"),
      "utf8"
    );

    const result = await runInvocation(
      "claude",
      { command: process.execPath, args: [fixture] },
      { provider: "claude", prompt: "test", cwd: directory },
      (value, state) => {
        const event = value as Record<string, unknown>;
        if (typeof event.session_id === "string") state.sessionId = event.session_id;
        if (typeof event.result === "string") state.finalResponse = event.result;
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("s-1");
    expect(result.finalResponse).toBe("finished");
    expect(result.events.some((event) => event.type === "completed")).toBe(true);
  });

  it("drops an oversized JSONL record and resumes at the next bounded record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentgraph-runner-bounded-"));
    const fixture = join(directory, "fixture.mjs");
    await writeFile(
      fixture,
      'console.log("x".repeat(100_000)); console.log(JSON.stringify({type:"result",result:"safe"}));',
      "utf8"
    );
    const result = await runInvocation(
      "claude",
      { command: process.execPath, args: [fixture] },
      { provider: "claude", prompt: "test", cwd: directory, maxCapturedBytes: 16 * 1024 },
      (value, state) => {
        const event = value as Record<string, unknown>;
        if (event.type === "result" && typeof event.result === "string") state.finalResponse = event.result;
      }
    );
    expect(result.finalResponse).toBe("safe");
    expect(result.events.some((event) => event.type === "stream_truncated")).toBe(true);
  });
});
