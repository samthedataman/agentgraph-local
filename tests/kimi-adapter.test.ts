import { describe, expect, it } from "vitest";
import { extractKimiEvent, kimiArgs } from "../src/adapters/kimi.js";

const base = {
  provider: "kimi" as const,
  prompt: "Review auth",
  cwd: "/repo",
  allowProviderAutoPermissions: true
};

describe("Kimi Code managed adapter", () => {
  it("uses the documented non-interactive stream-json contract without bypass flags", () => {
    const args = kimiArgs({ ...base, sessionId: "kimi-session", model: "kimi-code/kimi-for-coding" });
    expect(args).toEqual([
      "--session",
      "kimi-session",
      "--model",
      "kimi-code/kimi-for-coding",
      "--prompt",
      "Review auth",
      "--output-format",
      "stream-json"
    ]);
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("--auto");
  });

  it("extracts session identity and final assistant text from JSONL messages", () => {
    const state: { sessionId?: string; finalResponse: string } = { finalResponse: "" };
    extractKimiEvent({ session_id: "kimi-1", role: "assistant", content: [{ type: "text", text: "Done" }] }, state);
    expect(state).toEqual({ sessionId: "kimi-1", finalResponse: "Done" });
    extractKimiEvent({ type: "result", result: "Final result" }, state);
    expect(state.finalResponse).toBe("Final result");
  });

  it("fails closed for undocumented turn and dollar-budget flags", () => {
    expect(() => kimiArgs({ ...base, maxTurns: 2 })).toThrow("does not expose a documented max-turns");
    expect(() => kimiArgs({ ...base, maxBudgetUsd: 1 })).toThrow("does not expose a documented CLI budget");
  });

  it("requires explicit acknowledgement of Kimi's non-interactive auto permission policy", () => {
    expect(() => kimiArgs({ provider: "kimi", prompt: "Review", cwd: "/repo" })).toThrow("--allow-provider-auto");
  });
});
