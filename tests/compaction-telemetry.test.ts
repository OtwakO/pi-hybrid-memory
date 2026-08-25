import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimpleMock = vi.hoisted(() => vi.fn());

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return { ...actual, completeSimple: completeSimpleMock };
});

import { CacheTelemetry } from "../src/cache-telemetry.js";
import { runReflector } from "../src/om/compaction.js";

const model = {
  provider: "test-provider",
  id: "test-model",
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
};

const response = (text: string, stopReason = "stop") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: model.provider,
  model: model.id,
  stopReason,
  usage: {
    input: 100,
    output: 10,
    cacheRead: 300,
    cacheWrite: 20,
    totalTokens: 430,
    cost: { input: 0.0001, output: 0.00002, cacheRead: 0.00003, cacheWrite: 0.000025, total: 0.000175 },
  },
});

const observation = {
  id: "aaaaaaaaaaaa",
  content: "durable fact",
  timestamp: "2026-01-01 00:00",
  relevance: "high" as const,
  sourceEntryIds: ["1234abcd"],
};

describe("reflector cache telemetry and validation", () => {
  beforeEach(() => completeSimpleMock.mockReset());

  it("records reflector response usage and accepted-result counts", async () => {
    completeSimpleMock.mockResolvedValue(response(JSON.stringify({
      reflections: [{ content: "durable reflection", supportingObservationIds: [observation.id] }],
    })));
    const telemetry = new CacheTelemetry();

    const result = await runReflector({
      model,
      apiKey: "key",
      telemetry,
      cacheOptions: {
        sessionId: "pi-hybrid-memory:session-123:reflector",
        cacheRetention: "long",
      },
    }, [], [observation]);

    expect(result).toMatchObject({ ok: true, outcome: "success" });
    expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
      sessionId: "pi-hybrid-memory:session-123:reflector",
      cacheRetention: "long",
    });
    expect(telemetry.calls()[0]).toMatchObject({
      operation: "reflector",
      outcome: "success",
      usage: { cacheRead: 300 },
    });
    expect(telemetry.memoryLifecycleAggregate("reflector")).toMatchObject({
      attempts: 1,
      outcomes: { success: 1 },
      inputItems: 1,
      proposedItems: 1,
      acceptedItems: 1,
    });
  });

  it("classifies length-limited output as truncation", async () => {
    completeSimpleMock.mockResolvedValue(response("{\"reflections\":[", "length"));
    const telemetry = new CacheTelemetry();

    const result = await runReflector({ model, apiKey: "key", telemetry }, [], [observation]);

    expect(result).toEqual({ ok: false, reason: "truncated-output" });
    expect(telemetry.calls()[0]).toMatchObject({ operation: "reflector", outcome: "truncated" });
    expect(telemetry.memoryLifecycleAggregate("reflector")).toMatchObject({
      attempts: 1,
      outcomes: { "truncated-output": 1 },
      inputItems: 1,
    });
  });

  it("distinguishes a deliberate empty reflection result from malformed output", async () => {
    const telemetry = new CacheTelemetry();
    completeSimpleMock
      .mockResolvedValueOnce(response(JSON.stringify({ reflections: [] })))
      .mockResolvedValueOnce(response("not json"));

    const empty = await runReflector({ model, apiKey: "key", telemetry }, [], [observation]);
    const malformed = await runReflector({ model, apiKey: "key", telemetry }, [], [observation]);

    expect(empty).toMatchObject({ ok: true, outcome: "deliberate-empty" });
    expect(malformed).toEqual({ ok: false, reason: "invalid-output" });

    expect(telemetry.memoryLifecycleAggregate("reflector")).toMatchObject({
      attempts: 2,
      outcomes: { "deliberate-empty": 1, "invalid-output": 1 },
      inputItems: 2,
      proposedItems: 0,
      acceptedItems: 0,
    });
  });

  it("fails closed when a proposed reflection cites an observation outside the active pool", async () => {
    completeSimpleMock.mockResolvedValue(response(JSON.stringify({
      reflections: [{ content: "unsupported", supportingObservationIds: ["bbbbbbbbbbbb"] }],
    })));
    const telemetry = new CacheTelemetry();

    const result = await runReflector({ model, apiKey: "key", telemetry }, [], [observation]);

    expect(result).toEqual({ ok: false, reason: "invalid-provenance" });
    expect(telemetry.memoryLifecycleAggregate("reflector")).toMatchObject({
      attempts: 1,
      outcomes: { "invalid-provenance": 1 },
      proposedItems: 1,
      acceptedItems: 0,
    });
  });

  it("fails closed when supporting ids are duplicated", async () => {
    completeSimpleMock.mockResolvedValue(response(JSON.stringify({
      reflections: [{
        content: "duplicate support",
        supportingObservationIds: [observation.id, observation.id],
      }],
    })));

    const result = await runReflector({ model, apiKey: "key" }, [], [observation]);

    expect(result).toEqual({ ok: false, reason: "invalid-provenance" });
  });
});
