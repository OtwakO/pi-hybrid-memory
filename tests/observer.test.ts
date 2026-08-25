import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Context, Message, Model, ToolCall } from "@earendil-works/pi-ai";

import { CacheTelemetry } from "../src/cache-telemetry.js";
import {
  runObserver,
  type ObserverParams,
} from "../src/om/observer.js";
import { Runtime } from "../src/runtime.js";

const model = {
  provider: "test-provider",
  id: "test-model",
  api: "openai-completions",
  contextWindow: 100_000,
  maxTokens: 16_000,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
} as Model<Api>;

const usage = {
  input: 100,
  output: 10,
  cacheRead: 300,
  cacheWrite: 20,
  totalTokens: 430,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.025, total: 0.355 },
};

const assistant = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage => ({
  role: "assistant",
  api: model.api,
  provider: model.provider,
  model: model.id,
  content,
  stopReason,
  errorMessage,
  usage,
  timestamp: Date.now(),
});

const toolCall = (
  arguments_: Record<string, unknown>,
  id = "call-1",
  name = "record_observations",
): ToolCall => ({ type: "toolCall", id, name, arguments: arguments_ });

const params = {
  model,
  contextMessages: [{ role: "user" as const, content: "baseline", timestamp: 1 }],
  prompts: [{ role: "user" as const, content: "[Source entry id: source01]\n[User]: durable fact", timestamp: 2 }],
  allowedSourceEntryIds: ["source01"],
};

type ObserverComplete = ObserverParams["complete"];

const completionQueue = (...messages: AssistantMessage[]) => {
  const complete = vi.fn<ObserverComplete>();
  for (const message of messages) complete.mockResolvedValueOnce(message);
  return complete;
};

describe("Runtime model selection", () => {
  const context = () => ({
    model,
    modelRegistry: {
      find: vi.fn(),
    },
  });

  it("uses the active session model when no override is configured", () => {
    const result = new Runtime().resolveModel(context());
    expect(result).toEqual({ ok: true, model });
  });

  it("uses the configured model when it exists", () => {
    const runtime = new Runtime();
    const override = { ...model, id: "override" } as Model<Api>;
    runtime.config.hybrid.compactionModel = { provider: "test-provider", id: "override" };
    const ctx = context();
    ctx.modelRegistry.find.mockReturnValue(override);

    expect(runtime.resolveModel(ctx)).toEqual({ ok: true, model: override });
  });

  it("reports a missing configured model", () => {
    const runtime = new Runtime();
    runtime.config.hybrid.compactionModel = { provider: "missing", id: "model" };

    expect(runtime.resolveModel(context())).toEqual({
      ok: false,
      reason: "configured compaction model missing/model not found",
    });
  });
});

describe("observer deliberate-empty backoff", () => {
  it("waits for one more observation threshold on the same boundary", () => {
    const runtime = new Runtime();
    runtime.recordEmptyObserverResult("boundary-a", 1_200);

    expect(runtime.shouldBackOffEmptyObserver("boundary-a", 2_199, 1_000)).toBe(true);
    expect(runtime.shouldBackOffEmptyObserver("boundary-a", 2_200, 1_000)).toBe(false);
  });

  it("clears automatically when the observation boundary changes", () => {
    const runtime = new Runtime();
    runtime.recordEmptyObserverResult("boundary-a", 1_200);

    expect(runtime.shouldBackOffEmptyObserver("boundary-b", 1_200, 1_000)).toBe(false);
    expect(runtime.observerEmptyBackoff).toBeNull();
  });
});

describe("Pi-native observer inference", () => {
  let complete: ReturnType<typeof vi.fn<ObserverComplete>>;

  beforeEach(() => {
    complete = vi.fn<ObserverComplete>();
  });

  it("runs a bounded native tool continuation and returns the exact transcript suffix", async () => {
    const first = assistant([toolCall({
      observations: [{
        content: "durable fact",
        relevance: "high",
        sourceEntryIds: ["source01"],
      }],
    })], "toolUse");
    const final = assistant([{ type: "text", text: "covered" }]);
    complete.mockResolvedValueOnce(first).mockResolvedValueOnce(final);

    const result = await runObserver({
      ...params,
      complete,
      cacheOptions: {
        sessionId: "pi-hybrid-memory:session-123:observer",
        cacheRetention: "long",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      content: "durable fact",
      relevance: "high",
      sourceEntryIds: ["source01"],
    });
    expect(result.transcriptSuffix).toEqual([
      params.prompts[0],
      first,
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "record_observations",
        isError: false,
      }),
      final,
    ]);
    expect(complete).toHaveBeenCalledTimes(2);
    const [receivedModel, firstContext, options] = complete.mock.calls[0];
    expect(receivedModel).toBe(model);
    expect(firstContext).toMatchObject<Partial<Context>>({
      messages: [...params.contextMessages, ...params.prompts],
      tools: [{
        name: "record_observations",
        constrainedSampling: { type: "json_schema", strict: "prefer" },
      }],
    });
    expect(options).toMatchObject({
      sessionId: "pi-hybrid-memory:session-123:observer",
      cacheRetention: "long",
      maxRetries: 0,
    });
    expect(complete.mock.calls[1][1].messages).toEqual([
      ...params.contextMessages,
      ...result.transcriptSuffix.slice(0, -1),
    ]);
  });

  it("uses all current source ids when provenance is omitted", async () => {
    complete = completionQueue(
      assistant([toolCall({ observations: [{ content: "whole chunk", relevance: "medium" }] })], "toolUse"),
      assistant([{ type: "text", text: "done" }]),
    );

    const result = await runObserver({
      ...params,
      allowedSourceEntryIds: ["source01", "source02"],
      complete,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.records[0].sourceEntryIds).toEqual(["source01", "source02"]);
  });

  it("allows a later valid tool call to correct invalid provenance", async () => {
    complete = completionQueue(
      assistant([toolCall({
        observations: [{
          content: "wrong citation",
          relevance: "high",
          sourceEntryIds: ["old-source"],
        }],
      })], "toolUse"),
      assistant([toolCall({
        observations: [{
          content: "corrected fact",
          relevance: "high",
          sourceEntryIds: ["source01"],
        }],
      }, "call-2")], "toolUse"),
      assistant([{ type: "text", text: "done" }]),
    );

    const result = await runObserver({ ...params, complete });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records).toHaveLength(1);
    expect(result.records[0].content).toBe("corrected fact");
    expect(result.transcriptSuffix).toContainEqual(expect.objectContaining({
      role: "toolResult",
      toolCallId: "call-1",
      isError: true,
    }));
  });

  it("fails closed when the final tool attempt remains invalid", async () => {
    complete = completionQueue(
      assistant([toolCall({
        observations: [{ content: "valid fact", relevance: "high" }],
      })], "toolUse"),
      assistant([toolCall({
        observations: [{
          content: "unsupported fact",
          relevance: "critical",
          sourceEntryIds: ["old-source"],
        }],
      }, "call-2")], "toolUse"),
      assistant([{ type: "text", text: "done" }]),
    );

    const result = await runObserver({ ...params, complete });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("sourceEntryIds");
  });

  it("rejects toolUse termination without an actual tool call", async () => {
    complete.mockResolvedValue(assistant([], "toolUse"));

    const result = await runObserver({ ...params, complete });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("without a tool call");
  });

  it("fails closed on an unknown tool even if the model then stops", async () => {
    complete = completionQueue(
      assistant([toolCall({}, "call-unknown", "other_tool")], "toolUse"),
      assistant([{ type: "text", text: "done" }]),
    );

    const result = await runObserver({ ...params, complete });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("other_tool");
  });

  it.each([
    ["length", "truncated"],
    ["error", "provider failed"],
    ["aborted", "aborted"],
  ] as const)("classifies terminal %s responses", async (stopReason, expected) => {
    complete.mockResolvedValue(assistant([], stopReason, stopReason === "error" ? "provider failed" : undefined));

    const result = await runObserver({ ...params, complete });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(expected);
  });

  it("fails when the model exhausts the global continuation turn limit", async () => {
    complete.mockImplementation(async () => assistant([toolCall({ observations: [] })], "toolUse"));

    const result = await runObserver({ ...params, complete });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("turn limit");
    expect(complete).toHaveBeenCalledTimes(8);
  });

  it("classifies caller cancellation separately from provider failure", async () => {
    const controller = new AbortController();
    complete.mockImplementation(async (_model, _context, options) => {
      controller.abort();
      throw options.signal?.reason ?? new Error("aborted");
    });

    const result = await runObserver({ ...params, complete, signal: controller.signal });

    expect(result).toEqual({ ok: false, reason: "observer aborted", rawResponse: "" });
  });

  it("classifies provider startup rejection", async () => {
    complete.mockRejectedValue(new Error("provider unavailable"));

    const result = await runObserver({ ...params, complete });

    expect(result).toEqual({ ok: false, reason: "observer completion failed", rawResponse: "" });
  });

  it("times out even when the native completion ignores cancellation", async () => {
    vi.useFakeTimers();
    complete.mockImplementation(() => new Promise(() => {}));

    const pending = runObserver({ ...params, complete, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual(expect.objectContaining({ ok: false, reason: "observer timed out" }));
    vi.useRealTimers();
  });

  it("records provider usage from every native completion turn", async () => {
    const telemetry = new CacheTelemetry();
    complete = completionQueue(
      assistant([toolCall({ observations: [] })], "toolUse"),
      assistant([{ type: "text", text: "done" }]),
    );

    const result = await runObserver({ ...params, complete, telemetry });

    expect(result.ok).toBe(true);
    expect(telemetry.calls()).toHaveLength(2);
    expect(telemetry.calls()[0]).toMatchObject({
      operation: "observer",
      provider: "test-provider",
      model: "test-model",
      usage: { cacheRead: 300 },
    });
  });
});
