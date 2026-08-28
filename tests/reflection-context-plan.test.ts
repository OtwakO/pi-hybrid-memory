import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { planReflectionContext } from "../src/om/reflection-context-plan.js";
import { createMemoryQualityFixture } from "./quality/memory-quality-fixture.js";

const budgets = {
  reflectionTokens: 256,
  focusObservationTokens: 1_000,
  protectedObservationTokens: 1_000,
  recentObservationTokens: 320,
};

const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("bounded reflection context planning", () => {
  it.each([300, 600, 900] as const)(
    "keeps the bounded focus window deterministic at %i historical observations",
    size => {
      const fixture = createMemoryQualityFixture(size);
      const focusObservations = fixture.observations.slice(0, 12);
      const historicalObservations = fixture.observations.slice(12);
      const input = {
        reflections: [],
        focusObservations,
        historicalObservations,
        budgets,
      };
      const first = planReflectionContext(input);
      const second = planReflectionContext(input);
      const selectedIds = new Set(first.evidence.map(item => item.observation.id));

      expect(fixture.requiredFacts.every(fact => selectedIds.has(fact.observationId))).toBe(true);
      expect(first.tokens.focusObservations).toBeLessThanOrEqual(budgets.focusObservationTokens);
      expect(first.tokens.protectedObservations).toBeLessThanOrEqual(budgets.protectedObservationTokens);
      expect(first.tokens.recentObservations).toBeLessThanOrEqual(budgets.recentObservationTokens);
      expect(first.omitted.focusObservations).toBe(0);
      expect(first.evidence.map(item => item.handle)).toEqual(
        first.evidence.map((_, index) => `E${String(index + 1).padStart(3, "0")}`),
      );
      expect(first.handleToObservationId).toEqual(
        Object.fromEntries(first.evidence.map(item => [item.handle, item.observation.id])),
      );
      expect(first.text).not.toContain(fixture.observations[0].id);
      expect(fingerprint(first)).toBe(fingerprint(second));
    },
  );

  it("does not let a large protected history displace the focus window", () => {
    const focusObservations = Array.from({ length: 5 }, (_, index) => ({
      id: `focus000000${index}`,
      content: `Focus evidence ${index} must be considered by this transaction.`,
      timestamp: `2026-08-28T00:0${index}:00.000Z`,
      relevance: "medium" as const,
    }));
    const historicalObservations = Array.from({ length: 600 }, (_, index) => ({
      id: `history${String(index).padStart(5, "0")}`,
      content: `Historical protected evidence ${index} with marker PROTECTED-${index}.`,
      timestamp: `2026-08-27T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
      relevance: index % 2 === 0 ? "critical" as const : "high" as const,
    }));

    const plan = planReflectionContext({
      reflections: [],
      focusObservations,
      historicalObservations,
      budgets,
    });
    const selectedIds = new Set(plan.evidence.map(item => item.observation.id));

    expect(focusObservations.every(observation => selectedIds.has(observation.id))).toBe(true);
    expect(plan.protectedOverflow).toBe(true);
    expect(plan.omitted.protectedObservations).toBeGreaterThan(0);
    expect(plan.tokens.total).toBeLessThanOrEqual(2_700);
  });

  it("reports an oversized focus window instead of silently replacing it with history", () => {
    const focusObservations = Array.from({ length: 20 }, (_, index) => ({
      id: `focuswide${String(index).padStart(3, "0")}`,
      content: `Oversized focus evidence ${index} ${"x".repeat(100)}.`,
      timestamp: `2026-08-28T00:${String(index).padStart(2, "0")}:00.000Z`,
      relevance: "critical" as const,
    }));

    const plan = planReflectionContext({
      reflections: [],
      focusObservations,
      historicalObservations: [],
      budgets: { ...budgets, focusObservationTokens: 128 },
    });

    expect(plan.focusOverflow).toBe(true);
    expect(plan.omitted.focusObservations).toBeGreaterThan(0);
    expect(plan.evidence.length).toBeLessThan(focusObservations.length);
  });
});
