import { describe, expect, it } from "vitest";
import { normalizeClaudeHook, normalizeCodexHook } from "../src/hooks/normalize.js";
import { neutralHookOutput } from "../src/hooks/protocol.js";

describe("hook normalization", () => {
  it("normalizes a Codex resume without confusing run id and process id", () => {
    const event = normalizeCodexHook({
      hook_event_name: "SessionStart",
      session_id: "thr_123",
      source: "resume",
      cwd: "/repo",
      future_field: { okay: true },
      api_key: "sk-this-value-must-never-be-stored"
    }, {
      now: "2026-07-12T12:00:00Z",
      env: { AGENTGRAPH_RUN_ID: "run_123" }
    });

    expect(event.schema).toBe("local.agent.event/1");
    expect(event.kind).toBe("session.resumed");
    expect(event.provider_session_id).toBe("thr_123");
    expect(event.process_instance_id).toBeNull();
    expect(event.payload.agentgraph_run_id).toBe("run_123");
    expect(event.payload.api_key).toBe("[REDACTED]");
    expect(event.payload.future_field).toEqual({ okay: true });
  });

  it("uses the supervised process row id when the wrapper supplies one", () => {
    const event = normalizeClaudeHook({
      hook_event_name: "PreToolUse",
      session_id: "claude-session",
      turn_id: "turn-1",
      tool_name: "Bash",
      tool_input: { command: "curl -H 'Authorization: Bearer verysecretvalue1234' example.test" }
    }, {
      now: new Date("2026-07-12T12:00:00Z"),
      env: {
        AGENTGRAPH_RUN_ID: "run_1",
        AGENTGRAPH_PROCESS_INSTANCE_ID: "proc_1",
        AGENTGRAPH_TERMINAL_ID: "term_1"
      }
    });

    expect(event.kind).toBe("tool.started");
    expect(event.process_instance_id).toBe("proc_1");
    expect(event.terminal_id).toBe("term_1");
    expect(event.turn_id).toBe("turn-1");
    expect(JSON.stringify(event.payload)).not.toContain("verysecretvalue1234");
  });

  it("keeps unknown events instead of dropping forward-compatible data", () => {
    const event = normalizeClaudeHook(
      { hook_event_name: "SomeFutureEvent", session_id: "s1", new_data: 42 },
      { now: "2026-07-12T12:00:00Z", env: {} }
    );
    expect(event.kind).toBe("provider.event");
    expect(event.payload.new_data).toBe(42);
  });

  it("redacts camelCase credentials and common token formats", () => {
    const event = normalizeClaudeHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "s1",
        accessToken: "should-not-survive",
        clientSecret: "also-private",
        output: "received AKIAABCDEFGHIJKLMNOP and eyJabcdefgh.ijklmnop.qrstuvwx"
      },
      { now: "2026-07-12T12:00:00Z", env: {} }
    );
    const payload = JSON.stringify(event.payload);
    expect(payload).not.toContain("should-not-survive");
    expect(payload).not.toContain("also-private");
    expect(payload).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(payload).not.toContain("eyJabcdefgh.ijklmnop.qrstuvwx");
  });

  it("emits only the neutral Codex Stop protocol response", () => {
    expect(neutralHookOutput("codex", "Stop")).toBe('{"continue":true}\n');
    expect(neutralHookOutput("codex", "PostToolUse")).toBeUndefined();
    expect(neutralHookOutput("claude", "Stop")).toBeUndefined();
  });
});
