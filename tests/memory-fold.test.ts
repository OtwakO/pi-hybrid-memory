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
  focusObservations: [observation],
  canonicalObservationIds: new Set([observation.id]),
  reflectionThresholdTokens: 0,
  targetSummaryTokens: 16_000,
  contextBudgets: {
    reflectionTokens: 256,
    focusObservationTokens: 1_000,
    protectedObservationTokens: 1_000,
    recentObservationTokens: 320,
  },
  modelPort: port,
});

describe("foldMemory", () => {
  it("retires exact duplicates below the reflection threshold without calling the model", async () => {
    const duplicate = { ...observation, id: "bbbbbbbbbbbb", content: "  durable fact\r\n" };
    const port = modelPort({ ok: false, reason: "error" });

    const result = await foldMemory({
      ...input(port),
      observations: [observation, duplicate],
      canonicalObservationIds: new Set([observation.id, duplicate.id]),
      reflectionThresholdTokens: Number.MAX_SAFE_INTEGER,
    });

    expect(port.propose).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      observations: [observation],
      retirements: [{
        observationId: duplicate.id,
        preservedByObservationIds: [observation.id],
      }],
    });
  });

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
      retirements: [], supersessions: [],
    });
    expect(port.propose).not.toHaveBeenCalled();
  });

  it.each(["missing-tool-call", "timeout"] as const)(
    "retains every observation when reflection fails with %s",
    async (reason) => {
      const result = await foldMemory(input(modelPort({ ok: false, reason })));

      expect(result).toEqual({
        ok: false,
        stage: "reflection",
        reason,
        reflections: [],
        observations: [observation],
        retirements: [], supersessions: [],
      });
    },
  );

  it("returns a strengthened successor and explicit supersession edge", async () => {
    const secondObservation = { ...observation, id: "cccccccccccc", content: "second fact" };
    const existing = {
      id: "bbbbbbbbbbbb",
      content: "durable reflection",
      supportingObservationIds: [observation.id],
    };
    const result = await foldMemory({
      ...input(modelPort({
        ok: true,
        proposal: { reflections: [{
          content: " durable   reflection ",
          supportingEvidenceHandles: ["E002"],
        }] },
      })),
      reflections: [existing],
      observations: [observation, secondObservation],
      canonicalObservationIds: new Set([observation.id, secondObservation.id]),
    });

    expect(result).toMatchObject({
      ok: true,
      reflections: [{
        content: existing.content,
        supportingObservationIds: [observation.id, secondObservation.id],
      }],
      supersessions: [{ reflectionId: existing.id, reason: "strengthened" }],
    });
  });

  it("accepts validated reflections without retiring observations", async () => {
    const result = await foldMemory(input(modelPort({
      ok: true,
      proposal: {
        reflections: [{
          content: "durable reflection",
          supportingEvidenceHandles: ["E001"],
        }],
      },
    })));

    expect(result).toMatchObject({
      ok: true,
      outcome: "reflected",
      observations: [observation],
      retirements: [], supersessions: [],
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
          supportingEvidenceHandles: ["E001"],
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

  it("accepts valid candidates while rejecting an unrelated unknown handle", async () => {
    const result = await foldMemory(input(modelPort({
      ok: true,
      proposal: {
        reflections: [
          { content: "supported reflection", supportingEvidenceHandles: ["E001"] },
          { content: "unsupported reflection", supportingEvidenceHandles: ["E999"] },
        ],
      },
    })));

    expect(result).toMatchObject({
      ok: true,
      outcome: "reflected",
      reflections: [{
        content: "supported reflection",
        supportingObservationIds: [observation.id],
      }],
      observations: [observation],
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
