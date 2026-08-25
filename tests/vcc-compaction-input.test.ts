import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { prepareVccCompactionInput } from "../src/vcc/compaction-input.js";
import { VCC_SUMMARY_HEADER } from "../src/vcc/summary.js";

const preparation = (overrides: Record<string, unknown> = {}) => ({
  firstKeptEntryId: "kept",
  messagesToSummarize: [],
  turnPrefixMessages: [],
  isSplitTurn: false,
  tokensBefore: 100,
  fileOps: {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  },
  settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 2_000 },
  ...overrides,
}) as never;

const userMessage = (content: string): AgentMessage => ({
  role: "user",
  content,
  timestamp: 1,
});

const assistantMessage = (content: string): AgentMessage => ({
  role: "assistant",
  content: [{ type: "text", text: content }],
  api: "openai-completions",
  provider: "test",
  model: "model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
});

describe("prepareVccCompactionInput", () => {
  it("uses only Pi's removed messages and split-turn prefix in chronological order", () => {
    const input = prepareVccCompactionInput(preparation({
      messagesToSummarize: [userMessage("removed history")],
      turnPrefixMessages: [assistantMessage("removed turn prefix")],
      isSplitTurn: true,
    }));

    expect(input.messages).toHaveLength(2);
    expect(input.messages[0]).toMatchObject({ role: "user", content: "removed history" });
    expect(input.messages[1]).toMatchObject({ role: "assistant" });
  });

  it("uses Pi's canonical conversion for custom and branch-summary messages", () => {
    const input = prepareVccCompactionInput(preparation({
      messagesToSummarize: [
        {
          role: "custom",
          customType: "context",
          content: "extension context",
          display: true,
          timestamp: 1,
        },
        {
          role: "branchSummary",
          summary: "abandoned branch state",
          fromId: "branch-entry",
          timestamp: 2,
        },
      ],
    }));

    expect(input.messages).toHaveLength(2);
    expect(input.messages.every((message) => message.role === "user")).toBe(true);
    expect(input.messages[0].content).toEqual([{ type: "text", text: "extension context" }]);
    expect(input.messages[1].content).toEqual([{
      type: "text",
      text: expect.stringContaining("abandoned branch state"),
    }]);
  });

  it("passes through Pi's authoritative file-operation sets", () => {
    const read = new Set(["read.ts"]);
    const written = new Set(["created.ts"]);
    const edited = new Set(["edited.ts"]);

    const input = prepareVccCompactionInput(preparation({
      fileOps: { read, written, edited },
    }));

    expect(input.fileOps).toEqual({ read, written, edited });
  });

  it("extracts only the structural VCC body from a prior hybrid summary", () => {
    const previousSummary = [
      "## Memory (Observations & Reflections)",
      "memory text",
      "",
      "---",
      "",
      VCC_SUMMARY_HEADER + "[Session Goal]",
      "- Preserve the cache-stable design",
      "",
      "---",
      "",
      "[user]",
      "older removed history",
    ].join("\n");

    const input = prepareVccCompactionInput(preparation({ previousSummary }));

    expect(input.previousSummary).toBe(
      "[Session Goal]\n- Preserve the cache-stable design\n\n---\n\n[user]\nolder removed history",
    );
  });

  it("does not mistake unrelated summary text for prior VCC state", () => {
    const input = prepareVccCompactionInput(preparation({
      previousSummary: "## Memory (Observations & Reflections)\nSession State is discussed here.",
    }));

    expect(input.previousSummary).toBeUndefined();
  });
});
