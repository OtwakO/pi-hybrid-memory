import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";

import {
  createCompletionReflectionModel,
  type ReflectionComplete,
} from "../src/om/reflection-model.js";
import type { ReflectionRequestPlan } from "../src/om/reflection-budget.js";
import { CacheTelemetry } from "../src/cache-telemetry.js";

const plan: ReflectionRequestPlan = {
  maxOutputTokens: 4_096,
  maxReflections: 4,
  maxReflectionContentChars: 2_048,
  estimatedInputTokens: 100,
  providerOutputReserveTokens: 1_000,
  estimatedWorstCaseContractTokens: 1_000,
  estimatedWorstCaseOutputTokens: 2_000,
};

const model = {
  provider: "opencode-go",
  id: "deepseek-v4-flash",
  api: "openai-completions",
} as Model<Api>;

const usage = {
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const response = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage => ({
  role: "assistant",
  api: model.api,
  provider: model.provider,
  model: model.id,
  content,
  stopReason,
  usage,
  timestamp: Date.now(),
});

const params = {
  model,
  cacheOptions: { sessionId: "session-reflector", cacheRetention: "long" as const },
};

const toolCall = (arguments_: Record<string, unknown>, name = "submit_reflections") => ({
  type: "toolCall" as const,
  id: "call-1",
  name,
  arguments: arguments_,
});

describe("completion reflection model", () => {
  let complete: ReturnType<typeof vi.fn<ReflectionComplete>>;

  beforeEach(() => {
    complete = vi.fn<ReflectionComplete>();
  });

  it("uses Pi's native completion seam with a universal tool schema and bounded execution", async () => {
    complete.mockResolvedValue(response([
      toolCall({
        reflections: [{
          content: "durable reflection",
          supportingEvidenceHandles: ["aaaaaaaaaaaa"],
        }],
      }),
    ]));

    const result = await createCompletionReflectionModel({ complete, timeoutMs: 300_000 })
      .propose(params, "system", "evidence", plan);

    expect(result).toEqual({
      ok: true,
      proposal: {
        reflections: [{
          content: "durable reflection",
          supportingEvidenceHandles: ["aaaaaaaaaaaa"],
        }],
      },
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const [receivedModel, context, options] = complete.mock.calls[0];
    expect(receivedModel).toBe(model);
    expect(context).toMatchObject<Partial<Context>>({
      systemPrompt: "system",
      messages: [{ role: "user", content: "evidence" }],
      tools: [{
        name: "submit_reflections",
        constrainedSampling: { type: "json_schema", strict: "prefer" },
      }],
    });
    expect(options).toMatchObject({
      maxRetries: 0,
      cacheRetention: "long",
      sessionId: "session-reflector",
    });
    expect(options).not.toHaveProperty("maxTokens");
    expect(options).not.toHaveProperty("timeoutMs");
    expect(options).not.toHaveProperty("toolChoice");
    expect(options).not.toHaveProperty("reasoningEffort");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts an explicit empty submission", async () => {
    complete.mockResolvedValue(response([toolCall({ reflections: [] })]));

    const result = await createCompletionReflectionModel({ complete })
      .propose(params, "system", "evidence", plan);

    expect(result).toEqual({ ok: true, proposal: { reflections: [] } });
  });

  it("uses one bounded correction after a missing tool call", async () => {
    complete
      .mockResolvedValueOnce(response([{ type: "text", text: "prose only" }], "stop"))
      .mockResolvedValueOnce(response([toolCall({ reflections: [] })]));

    const result = await createCompletionReflectionModel({ complete })
      .propose(params, "system", "evidence", plan);

    expect(result).toEqual({ ok: true, proposal: { reflections: [] } });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("fails after one bounded correction for malformed tool arguments", async () => {
    complete.mockResolvedValue(response([toolCall({ reflections: [{ content: "missing provenance" }] })]));

    const result = await createCompletionReflectionModel({ complete })
      .propose(params, "system", "evidence", plan);

    expect(result).toEqual({ ok: false, reason: "invalid-output" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("rejects extra or multiple tool calls", async () => {
    complete.mockResolvedValue(response([
      toolCall({ reflections: [] }),
      { ...toolCall({}), id: "call-2", name: "unexpected_tool" },
    ]));

    const result = await createCompletionReflectionModel({ complete })
      .propose(params, "system", "evidence", plan);

    expect(result).toEqual({ ok: false, reason: "invalid-output" });
  });

  it("classifies length termination before parsing output", async () => {
    complete.mockResolvedValue(response([], "length"));

    const result = await createCompletionReflectionModel({ complete })
      .propose(params, "system", "evidence", plan);

    expect(result).toEqual({ ok: false, reason: "truncated-output" });
  });

  it("classifies caller cancellation separately from timeout", async () => {
    const controller = new AbortController();
    complete.mockImplementation(async (_model, _context, options) => {
      controller.abort();
      throw options.signal?.reason ?? new Error("aborted");
    });

    const result = await createCompletionReflectionModel({ complete })
      .propose({ ...params, signal: controller.signal }, "system", "evidence", plan);

    expect(result).toEqual({ ok: false, reason: "aborted" });
  });

  it("classifies a resolved deadline abort as timeout", async () => {
    vi.useFakeTimers();
    complete.mockImplementation((_model, _context, options) => new Promise(resolve => {
      options.signal?.addEventListener(
        "abort",
        () => resolve(response([], "aborted")),
        { once: true },
      );
    }));

    const pending = createCompletionReflectionModel({ complete, timeoutMs: 1_000 })
      .propose(params, "system", "evidence", plan);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
    vi.useRealTimers();
  });

  it("records a resolved deadline abort as a timeout call", async () => {
    vi.useFakeTimers();
    const telemetry = new CacheTelemetry();
    complete.mockImplementation((_model, _context, options) => new Promise(resolve => {
      options.signal?.addEventListener(
        "abort",
        () => resolve(response([], "aborted")),
        { once: true },
      );
    }));

    const pending = createCompletionReflectionModel({ complete, timeoutMs: 1_000 })
      .propose({ ...params, telemetry }, "system", "evidence", plan);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(telemetry.calls().at(-1)?.outcome).toBe("timeout");
    vi.useRealTimers();
  });

  it("reports when the single correction turn times out", async () => {
    vi.useFakeTimers();
    complete
      .mockResolvedValueOnce(response([{ type: "text", text: "prose only" }], "stop"))
      .mockImplementationOnce(() => new Promise(() => {}));

    const pending = createCompletionReflectionModel({ complete, timeoutMs: 1_000 })
      .propose(params, "system", "evidence", plan);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual({ ok: false, reason: "correction-timeout" });
    expect(complete).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("records correction stage and initial failure disposition", async () => {
    const telemetry = new CacheTelemetry();
    complete
      .mockResolvedValueOnce(response([{ type: "text", text: "prose only" }], "stop"))
      .mockResolvedValueOnce({
        ...response([], "error"),
        errorMessage: "Stream ended without finish_reason",
      });

    await createCompletionReflectionModel({ complete })
      .propose({ ...params, telemetry }, "system", "evidence", plan);

    expect(telemetry.reflectionCompletionDiagnostic()).toMatchObject({
      stage: "correction",
      initialDisposition: "missing-tool-call",
      terminalCategory: "stream-finalization",
      correctionUsed: true,
      elapsedMs: expect.any(Number),
    });
  });

  it("distinguishes rejected completion from stream finalization", async () => {
    const telemetry = new CacheTelemetry();
    complete.mockRejectedValueOnce(new Error("connection reset"));

    await createCompletionReflectionModel({ complete })
      .propose({ ...params, telemetry }, "system", "evidence", plan);

    expect(telemetry.reflectionCompletionDiagnostic()).toMatchObject({
      stage: "initial",
      terminalCategory: "rejected-completion",
      correctionUsed: false,
    });
  });

  it("distinguishes provider finish errors from stream finalization", async () => {
    const telemetry = new CacheTelemetry();
    complete.mockResolvedValueOnce({
      ...response([], "error"),
      errorMessage: "Provider finish_reason: content_filter",
    });

    await createCompletionReflectionModel({ complete })
      .propose({ ...params, telemetry }, "system", "evidence", plan);

    expect(telemetry.reflectionCompletionDiagnostic()).toMatchObject({
      stage: "initial",
      terminalCategory: "provider-finish-error",
      correctionUsed: false,
    });
  });

  it("reports correction provider errors without masking the prior invalid response", async () => {
    complete
      .mockResolvedValueOnce(response([{ type: "text", text: "prose only" }], "stop"))
      .mockRejectedValueOnce(new Error("correction transport failed"));

    const result = await createCompletionReflectionModel({ complete })
      .propose(params, "system", "evidence", plan);

    expect(result).toEqual({ ok: false, reason: "correction-error" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("classifies a returned correction error at the correction phase", async () => {
    complete
      .mockResolvedValueOnce(response([{ type: "text", text: "prose only" }], "stop"))
      .mockResolvedValueOnce(response([], "error"));

    const result = await createCompletionReflectionModel({ complete })
      .propose(params, "system", "evidence", plan);

    expect(result).toEqual({ ok: false, reason: "correction-error" });
  });

  it("propagates the deadline abort to the provider completion", async () => {
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    complete.mockImplementation((_model, _context, options) => {
      providerSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    });

    const telemetry = new CacheTelemetry();
    const pending = createCompletionReflectionModel({ complete, timeoutMs: 1_000 })
      .propose({ ...params, telemetry }, "system", "evidence", plan);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(providerSignal?.aborted).toBe(true);
    expect(telemetry.calls().at(-1)?.outcome).toBe("timeout");
    vi.useRealTimers();
  });

  it("bounds a completion that never settles even when it ignores cancellation", async () => {
    vi.useFakeTimers();
    complete.mockImplementation(() => new Promise(() => {}));

    const pending = createCompletionReflectionModel({ complete, timeoutMs: 1_000 })
      .propose(params, "system", "evidence", plan);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
    vi.useRealTimers();
  });

  it("dispatches non-OpenAI API models through the same Pi-native seam", async () => {
    const anthropicModel = { ...model, api: "anthropic-messages" } as Model<Api>;
    complete.mockResolvedValue({
      ...response([toolCall({ reflections: [] })]),
      api: "anthropic-messages",
    });

    const result = await createCompletionReflectionModel({ complete })
      .propose({ ...params, model: anthropicModel }, "system", "evidence", plan);

    expect(result).toEqual({ ok: true, proposal: { reflections: [] } });
    expect(complete.mock.calls[0][0]).toBe(anthropicModel);
  });
});
