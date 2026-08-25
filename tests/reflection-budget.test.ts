import { describe, expect, it } from "vitest";
import { planReflectionRequest } from "../src/om/reflection-budget.js";
import type { ObservationRecord } from "../src/types.js";

const observation = (id: string, content = "durable fact"): ObservationRecord => ({
  id,
  content,
  timestamp: "2026-01-01 00:00",
  relevance: "high",
});

describe("planReflectionRequest", () => {
  it("bounds a useful contract from model and summary capacity", () => {
    const result = planReflectionRequest({
      model: { contextWindow: 32_000, maxTokens: 8_000 },
      systemPrompt: "system",
      userPrompt: "evidence",
      existingReflections: [],
      observations: [observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb")],
      targetSummaryTokens: 16_000,
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        maxOutputTokens: 1_408,
        maxReflections: 2,
        maxReflectionContentChars: 2_048,
      },
    });
  });

  it("fails closed when full evidence and the minimum useful result cannot fit", () => {
    const result = planReflectionRequest({
      model: { contextWindow: 1_000, maxTokens: 500 },
      systemPrompt: "system",
      userPrompt: "x".repeat(8_000),
      existingReflections: [],
      observations: [observation("aaaaaaaaaaaa")],
      targetSummaryTokens: 16_000,
    });

    expect(result).toEqual({ ok: false, reason: "infeasible-request" });
  });

  it("does not propose more new reflections than observations", () => {
    const result = planReflectionRequest({
      model: { contextWindow: 128_000, maxTokens: 32_000 },
      systemPrompt: "system",
      userPrompt: "evidence",
      existingReflections: [],
      observations: [observation("aaaaaaaaaaaa")],
      targetSummaryTokens: 16_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.maxReflections).toBe(1);
  });

  it("sends exactly the output bound used by the context feasibility check", () => {
    const result = planReflectionRequest({
      model: { contextWindow: 4_000, maxTokens: 8_000 },
      systemPrompt: "system",
      userPrompt: "x".repeat(2_000),
      existingReflections: [],
      observations: [observation("aaaaaaaaaaaa")],
      targetSummaryTokens: 16_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.plan.estimatedInputTokens
        + result.plan.maxOutputTokens
        + 2_048,
      ).toBeLessThanOrEqual(4_000);
      expect(result.plan.maxOutputTokens).toBe(result.plan.estimatedWorstCaseOutputTokens);
    }
  });
});
