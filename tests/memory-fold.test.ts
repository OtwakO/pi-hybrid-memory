import { describe, expect, it, vi } from "vitest";
import { foldMemory } from "../src/om/memory-fold.js";
import type { ObservationRecord } from "../src/types.js";

const observation: ObservationRecord = {
  id: "aaaaaaaaaaaa",
  content: "durable fact",
  timestamp: "2026-01-01 00:00",
  relevance: "high",
};

const params = { model: {}, apiKey: "key" };

describe("foldMemory", () => {
  it("skips model work below the reflection threshold", async () => {
    const reflect = vi.fn();

    const result = await foldMemory({
      params,
      reflections: [],
      observations: [observation],
      reflectionThresholdTokens: Number.MAX_SAFE_INTEGER,
      reflect,
    });

    expect(result).toEqual({
      ok: true,
      outcome: "below-threshold",
      reflections: [],
      observations: [observation],
      retiredObservationIds: [],
    });
    expect(reflect).not.toHaveBeenCalled();
  });

  it("retains every observation when reflection fails", async () => {
    const reflect = vi.fn().mockResolvedValue({ ok: false, reason: "invalid-output" });

    const result = await foldMemory({
      params,
      reflections: [],
      observations: [observation],
      reflectionThresholdTokens: 0,
      reflect,
    });

    expect(result).toEqual({
      ok: false,
      stage: "reflection",
      reason: "invalid-output",
      reflections: [],
      observations: [observation],
      retiredObservationIds: [],
    });
  });

  it("accepts validated reflections without retiring observations", async () => {
    const reflection = {
      id: "bbbbbbbbbbbb",
      content: "durable reflection",
      supportingObservationIds: [observation.id],
    };
    const reflect = vi.fn().mockResolvedValue({
      ok: true,
      outcome: "success",
      reflections: [reflection],
      proposedItems: 1,
      acceptedItems: 1,
    });

    const result = await foldMemory({
      params,
      reflections: [],
      observations: [observation],
      reflectionThresholdTokens: 0,
      reflect,
    });

    expect(result).toEqual({
      ok: true,
      outcome: "reflected",
      reflections: [reflection],
      observations: [observation],
      retiredObservationIds: [],
    });
  });
});
