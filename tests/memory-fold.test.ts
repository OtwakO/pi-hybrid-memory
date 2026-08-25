import { describe, expect, it, vi } from "vitest";
import { foldMemory } from "../src/om/memory-fold.js";
import type { ReflectionModelPort } from "../src/om/reflection-model.js";
import type { ObservationRecord } from "../src/types.js";

const observation: ObservationRecord = {
  id: "aaaaaaaaaaaa",
  content: "durable fact",
  timestamp: "2026-01-01 00:00",
  relevance: "high",
};

const params = {
  model: { contextWindow: 32_000, maxTokens: 8_000 },
  apiKey: "key",
};

const modelPort = (result: Awaited<ReturnType<ReflectionModelPort["propose"]>>): ReflectionModelPort => ({
  propose: vi.fn().mockResolvedValue(result),
});

const input = (port: ReflectionModelPort) => ({
  params,
  reflections: [],
  observations: [observation],
  reflectionThresholdTokens: 0,
  targetSummaryTokens: 16_000,
  modelPort: port,
});

describe("foldMemory", () => {
  it("skips model work below the reflection threshold", async () => {
    const port = modelPort({ ok: false, reason: "error" });

    const result = await foldMemory({
      ...input(port),
      reflectionThresholdTokens: Number.MAX_SAFE_INTEGER,
    });

    expect(result).toEqual({
      ok: true,
      outcome: "below-threshold",
      reflections: [],
      observations: [observation],
      retiredObservationIds: [],
    });
    expect(port.propose).not.toHaveBeenCalled();
  });

  it("retains every observation when reflection fails", async () => {
    const result = await foldMemory(input(modelPort({ ok: false, reason: "missing-tool-call" })));

    expect(result).toEqual({
      ok: false,
      stage: "reflection",
      reason: "missing-tool-call",
      reflections: [],
      observations: [observation],
      retiredObservationIds: [],
    });
  });

  it("accepts validated reflections without retiring observations", async () => {
    const result = await foldMemory(input(modelPort({
      ok: true,
      proposal: {
        reflections: [{
          content: "durable reflection",
          supportingObservationIds: [observation.id],
        }],
      },
    })));

    expect(result).toMatchObject({
      ok: true,
      outcome: "reflected",
      observations: [observation],
      retiredObservationIds: [],
      reflections: [{
        content: "durable reflection",
        supportingObservationIds: [observation.id],
      }],
    });
  });

  it("reports a duplicate proposal as a successful no-change fold", async () => {
    const existing = {
      id: "bbbbbbbbbbbb",
      content: "durable reflection",
      supportingObservationIds: [observation.id],
    };
    const result = await foldMemory({
      ...input(modelPort({
        ok: true,
        proposal: { reflections: [{
          content: "durable reflection",
          supportingObservationIds: [observation.id],
        }] },
      })),
      reflections: [existing],
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "no-change",
      reflections: [existing],
    });
  });

  it("rejects unsupported provenance returned by the provider adapter", async () => {
    const result = await foldMemory(input(modelPort({
      ok: true,
      proposal: {
        reflections: [{
          content: "unsupported reflection",
          supportingObservationIds: ["bbbbbbbbbbbb"],
        }],
      },
    })));

    expect(result).toEqual({
      ok: false,
      stage: "reflection",
      reason: "invalid-provenance",
      reflections: [],
      observations: [observation],
      retiredObservationIds: [],
    });
  });

  it("fails before the provider call when complete input plus a useful contract cannot fit", async () => {
    const port = modelPort({ ok: false, reason: "error" });
    const result = await foldMemory({
      ...input(port),
      params: { model: { contextWindow: 100, maxTokens: 50 }, apiKey: "key" },
    });

    expect(result).toMatchObject({ ok: false, reason: "infeasible-request" });
    expect(port.propose).not.toHaveBeenCalled();
  });
});
