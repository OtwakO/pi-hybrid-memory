import { beforeEach, describe, expect, it, vi } from "vitest";

const agentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("@mariozechner/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-agent-core")>();
  return { ...actual, agentLoop: agentLoopMock };
});

import { createAgentLoopReflectionModel } from "../src/om/reflection-model.js";
import type { ReflectionRequestPlan } from "../src/om/reflection-budget.js";

const plan: ReflectionRequestPlan = {
  maxOutputTokens: 4_096,
  maxReflections: 4,
  maxReflectionContentChars: 2_048,
  estimatedInputTokens: 100,
  estimatedWorstCaseOutputTokens: 2_000,
};

const params = {
  model: { provider: "test-provider", id: "test-model" },
  apiKey: "key",
};

const stream = (run?: (context: any, config: any) => Promise<void> | void, events: unknown[] = []) => ({
  async *[Symbol.asyncIterator]() {
    const [, context, config] = agentLoopMock.mock.calls.at(-1)!;
    await run?.(context, config);
    for (const event of events) yield event;
  },
  result: vi.fn().mockResolvedValue([]),
});

describe("agent-loop reflection model", () => {
  beforeEach(() => agentLoopMock.mockReset());

  it("uses a constrained terminating submission tool with medium reasoning and a bounded output", async () => {
    agentLoopMock.mockImplementation((_prompts, context, config) => stream(async () => {
      await context.tools[0].execute("call", {
        reflections: [{
          content: "durable reflection",
          supportingObservationIds: ["aaaaaaaaaaaa"],
        }],
      });
    }));

    const result = await createAgentLoopReflectionModel().propose(params, "system", "evidence", plan);

    expect(result).toEqual({
      ok: true,
      proposal: {
        reflections: [{
          content: "durable reflection",
          supportingObservationIds: ["aaaaaaaaaaaa"],
        }],
      },
    });
    const [, context, config] = agentLoopMock.mock.calls[0];
    expect(context.tools[0]).toMatchObject({
      name: "submit_reflections",
      constrainedSampling: { type: "json_schema", strict: "prefer" },
    });
    expect(config).toMatchObject({
      reasoning: "medium",
      maxTokens: plan.maxOutputTokens,
      toolExecution: "sequential",
    });
  });

  it("accepts an explicit empty submission as deliberate empty evidence", async () => {
    agentLoopMock.mockImplementation((_prompts, context) => stream(async () => {
      await context.tools[0].execute("call", { reflections: [] });
    }));

    const result = await createAgentLoopReflectionModel().propose(params, "system", "evidence", plan);

    expect(result).toEqual({ ok: true, proposal: { reflections: [] } });
  });

  it("fails when the model stops without calling the submission tool", async () => {
    agentLoopMock.mockReturnValue(stream());

    const result = await createAgentLoopReflectionModel().propose(params, "system", "evidence", plan);

    expect(result).toEqual({ ok: false, reason: "missing-tool-call" });
  });

  it("allows a valid corrective submission after a length-limited first turn", async () => {
    agentLoopMock.mockImplementation((_prompts, context) => stream(async () => {
      await context.tools[0].execute("corrected", { reflections: [] });
    }, [{
      type: "turn_end",
      message: { role: "assistant", stopReason: "length", content: [] },
      toolResults: [],
    }]));

    const result = await createAgentLoopReflectionModel().propose(params, "system", "evidence", plan);

    expect(result).toEqual({ ok: true, proposal: { reflections: [] } });
  });

  it("classifies a final length termination without correction as truncation", async () => {
    agentLoopMock.mockReturnValue(stream(undefined, [{
      type: "turn_end",
      message: { role: "assistant", stopReason: "length", content: [] },
      toolResults: [],
    }]));

    const result = await createAgentLoopReflectionModel().propose(params, "system", "evidence", plan);

    expect(result).toEqual({ ok: false, reason: "truncated-output" });
  });

  it("stops after two unsuccessful assistant turns even for unknown tools", async () => {
    let config: any;
    agentLoopMock.mockImplementation((_prompts, _context, receivedConfig) => {
      config = receivedConfig;
      return stream(undefined, [
        { type: "tool_execution_start", toolCallId: "a", toolName: "unknown", args: {} },
        { type: "turn_end", message: { role: "assistant", stopReason: "toolUse", content: [] }, toolResults: [] },
        { type: "tool_execution_start", toolCallId: "b", toolName: "unknown", args: {} },
        { type: "turn_end", message: { role: "assistant", stopReason: "toolUse", content: [] }, toolResults: [] },
      ]);
    });

    const result = await createAgentLoopReflectionModel().propose(params, "system", "evidence", plan);

    expect(result).toEqual({ ok: false, reason: "invalid-output" });
    expect(config.shouldStopAfterTurn()).toBe(true);
  });

  it("rejects multiple valid complete submissions", async () => {
    agentLoopMock.mockImplementation((_prompts, context) => stream(async () => {
      await context.tools[0].execute("first", { reflections: [] });
      await expect(context.tools[0].execute("second", { reflections: [] })).rejects.toThrow("exactly once");
    }));

    const result = await createAgentLoopReflectionModel().propose(params, "system", "evidence", plan);

    expect(result).toEqual({ ok: false, reason: "invalid-output" });
  });
});
