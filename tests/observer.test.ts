import { beforeEach, describe, expect, it, vi } from "vitest";

const agentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  return { ...actual, agentLoop: agentLoopMock };
});

import { runObserver } from "../src/om/observer.js";
import { Runtime } from "../src/runtime.js";
import { CacheTelemetry } from "../src/cache-telemetry.js";

const streamOf = (events: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    for (const event of events) yield event;
  },
  result: vi.fn().mockResolvedValue([]),
});

const params = {
  model: {},
  apiKey: "key",
  contextMessages: [],
  prompts: [{ role: "user", content: "[Source entry id: source01]\n[User]: durable fact", timestamp: 0 }],
  allowedSourceEntryIds: ["source01"],
};

const assistant = (stopReason: string, errorMessage?: string) => ({
  role: "assistant",
  content: [],
  stopReason,
  errorMessage,
});

const telemetryModel = {
  provider: "test-provider",
  id: "test-model",
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
};

describe("Runtime model auth resolution", () => {
  const context = (auth: { ok: boolean; apiKey?: string; headers?: Record<string, string> }) => ({
    model: { id: "session" },
    modelRegistry: {
      find: vi.fn(),
      getApiKeyAndHeaders: vi.fn().mockResolvedValue(auth),
    },
  });

  it("accepts a non-empty API key", async () => {
    const result = await new Runtime().resolveModel(context({ ok: true, apiKey: "secret" }));
    expect(result.ok).toBe(true);
  });

  it("accepts header-only OAuth credentials", async () => {
    const result = await new Runtime().resolveModel(context({
      ok: true,
      headers: { Authorization: "Bearer token" },
    }));
    expect(result.ok).toBe(true);
  });

  it.each([
    { ok: true },
    { ok: true, apiKey: "   " },
    { ok: true, headers: { Authorization: "" } },
  ])("rejects auth results without usable credentials", async (auth) => {
    const result = await new Runtime().resolveModel(context(auth));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("usable API key or auth header");
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

  it("can be cleared after a successful observation", () => {
    const runtime = new Runtime();
    runtime.recordEmptyObserverResult("boundary-a", 1_200);

    runtime.clearEmptyObserverBackoff();

    expect(runtime.shouldBackOffEmptyObserver("boundary-a", 1_200, 1_000)).toBe(false);
  });
});

describe("runObserver observation provenance", () => {
  beforeEach(() => {
    agentLoopMock.mockReset();
  });

  it("accepts a validated subset of source entry ids for each observation", async () => {
    agentLoopMock.mockImplementation((...args) => {
      const context = args.find((arg) => arg && Array.isArray(arg.tools));
      void context.tools[0].execute("call", {
        observations: [{
          content: "fact from the second source",
          relevance: "high",
          sourceEntryIds: ["source02", "source02"],
        }],
      });
      return streamOf([]);
    });

    const result = await runObserver({
      ...params,
      allowedSourceEntryIds: ["source01", "source02"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.records[0].sourceEntryIds).toEqual(["source02"]);
  });

  it("preserves legacy all-source provenance when the model omits the optional subset", async () => {
    agentLoopMock.mockImplementation((...args) => {
      const context = args.find((arg) => arg && Array.isArray(arg.tools));
      void context.tools[0].execute("call", {
        observations: [{ content: "fact from the chunk", relevance: "high" }],
      });
      return streamOf([]);
    });

    const result = await runObserver({
      ...params,
      allowedSourceEntryIds: ["source01", "source02"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.records[0].sourceEntryIds).toEqual(["source01", "source02"]);
  });

  it("recovers when the model corrects an invalid provenance subset in a later tool call", async () => {
    agentLoopMock.mockImplementation((...args) => {
      const context = args.find((arg) => arg && Array.isArray(arg.tools));
      return {
        async *[Symbol.asyncIterator]() {
          await context.tools[0].execute("invalid", {
            observations: [{
              content: "wrongly cited fact",
              relevance: "high",
              sourceEntryIds: ["previous-chunk-source"],
            }],
          }).catch(() => undefined);
          await context.tools[0].execute("corrected", {
            observations: [{
              content: "fact from the current source",
              relevance: "high",
              sourceEntryIds: ["source01"],
            }],
          });
        },
        result: vi.fn().mockResolvedValue([]),
      };
    });

    const result = await runObserver(params);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toHaveLength(1);
      expect(result.records[0].sourceEntryIds).toEqual(["source01"]);
    }
  });

  it("still fails when the final provenance attempt remains invalid", async () => {
    agentLoopMock.mockImplementation((...args) => {
      const context = args.find((arg) => arg && Array.isArray(arg.tools));
      return {
        async *[Symbol.asyncIterator]() {
          await context.tools[0].execute("valid", {
            observations: [{
              content: "fact from the current source",
              relevance: "high",
              sourceEntryIds: ["source01"],
            }],
          });
          await context.tools[0].execute("invalid", {
            observations: [{
              content: "wrongly cited fact",
              relevance: "high",
              sourceEntryIds: ["previous-chunk-source"],
            }],
          }).catch(() => undefined);
        },
        result: vi.fn().mockResolvedValue([]),
      };
    });

    const result = await runObserver(params);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("sourceEntryIds");
  });

  it("rejects a provenance subset containing a source outside the current chunk", async () => {
    agentLoopMock.mockImplementation((...args) => {
      const context = args.find((arg) => arg && Array.isArray(arg.tools));
      return streamOf([context.tools[0].execute("call", {
        observations: [{
          content: "unsupported fact",
          relevance: "critical",
          sourceEntryIds: ["other-source"],
        }],
      })]);
    });

    const result = await runObserver(params);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("sourceEntryIds");
  });
});

describe("runObserver terminal stream handling", () => {
  beforeEach(() => {
    agentLoopMock.mockReset();
  });

  it.each([
    { type: "message_end", message: assistant("error", "provider failed") },
    { type: "turn_end", message: assistant("aborted", "request aborted"), toolResults: [] },
    { type: "agent_end", messages: [assistant("error", "terminal failure")] },
  ])("reports terminal $type failure when no observations were recorded", async (event) => {
    agentLoopMock.mockReturnValue(streamOf([event]));

    const result = await runObserver(params);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(event.type === "turn_end" ? "request aborted" : "fail");
  });

  it("rejects partial observations when a later terminal error leaves coverage unknown", async () => {
    agentLoopMock.mockImplementation((...args) => {
      const context = args.find((arg) => arg && Array.isArray(arg.tools));
      void context.tools[0].execute("call", {
        observations: [{ content: "recorded before failure", relevance: "high" }],
      });
      return streamOf([{ type: "message_end", message: assistant("error", "late failure") }]);
    });

    const result = await runObserver(params);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("late failure");
      expect(result.rawResponse).toBe("");
    }
  });

  it("passes stable cache identity and long retention to the observer agent loop", async () => {
    agentLoopMock.mockReturnValue(streamOf([
      { type: "message_end", message: assistant("stop") },
    ]));

    await runObserver({
      ...params,
      model: telemetryModel,
      cacheOptions: {
        sessionId: "pi-hybrid-memory:session-123:observer",
        cacheRetention: "long",
      },
    });

    expect(agentLoopMock.mock.calls[0][2]).toMatchObject({
      sessionId: "pi-hybrid-memory:session-123:observer",
      cacheRetention: "long",
    });
  });

  it("records provider usage from the canonical completed assistant message", async () => {
    const telemetry = new CacheTelemetry();
    const message = {
      ...assistant("stop"),
      usage: {
        input: 100,
        output: 10,
        cacheRead: 300,
        cacheWrite: 20,
        totalTokens: 430,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.025, total: 0.355 },
      },
    };
    agentLoopMock.mockReturnValue(streamOf([{ type: "message_end", message }]));

    const result = await runObserver({ ...params, model: telemetryModel, telemetry });

    expect(result).toEqual({ ok: true, records: [], transcriptSuffix: [] });
    expect(telemetry.calls()).toHaveLength(1);
    expect(telemetry.calls()[0]).toMatchObject({
      operation: "observer",
      provider: "test-provider",
      model: "test-model",
      outcome: "success",
      usage: { cacheRead: 300 },
    });
  });
});
