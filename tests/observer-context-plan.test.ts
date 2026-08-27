import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { planObserverContext } from "../src/om/observer-context-plan.js";
import { createMemoryQualityFixture } from "./quality/memory-quality-fixture.js";

const budgets = {
  reflectionTokens: 256,
  protectedObservationTokens: 1_500,
  recentObservationTokens: 320,
  sourceRelatedObservationTokens: 320,
};

const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("bounded observer context planning", () => {
  it.each([300, 600, 900] as const)(
    "keeps required facts and bounded deterministic context at %i observations",
    size => {
      const fixture = createMemoryQualityFixture(size);
      const related = fixture.observations[199];
      const input = {
        reflections: [],
        observations: fixture.observations,
        sourceText: `Revisit this exact prior note: ${related.content}`,
        budgets,
      };

      const first = planObserverContext(input);
      const second = planObserverContext(input);
      const selectedIds = new Set([
        ...first.stableObservations.map(observation => observation.id),
        ...first.sourceRelatedObservations.map(observation => observation.id),
      ]);

      expect(fixture.requiredFacts.every(fact => selectedIds.has(fact.observationId))).toBe(true);
      expect(first.sourceRelatedObservations.map(observation => observation.id)).toContain(related.id);
      expect(first.tokens.protectedObservations).toBeLessThanOrEqual(budgets.protectedObservationTokens);
      expect(first.tokens.recentObservations).toBeLessThanOrEqual(budgets.recentObservationTokens);
      expect(first.tokens.sourceRelatedObservations).toBeLessThanOrEqual(budgets.sourceRelatedObservationTokens);
      expect(first.tokens.stableBaseline).toBeLessThanOrEqual(
        budgets.reflectionTokens + budgets.protectedObservationTokens + budgets.recentObservationTokens + 128,
      );
      expect(fingerprint(first)).toBe(fingerprint(second));
    },
  );

  it("reports protected overflow and keeps source-related selection separate from the stable prefix", () => {
    const observations = [
      {
        id: "critical0001",
        content: "Critical deployment constraint ALPHA-917 must remain enabled.",
        timestamp: "2026-08-28T00:00:00.000Z",
        relevance: "critical" as const,
      },
      {
        id: "critical0002",
        content: "Critical rollback constraint BETA-418 must remain available.",
        timestamp: "2026-08-28T00:01:00.000Z",
        relevance: "critical" as const,
      },
      {
        id: "related00001",
        content: "Failure at /srv/app/config.json returned E_CONFIG_72.",
        timestamp: "2026-08-28T00:02:00.000Z",
        relevance: "medium" as const,
      },
    ];

    const plan = planObserverContext({
      reflections: [],
      observations,
      sourceText: "Investigate E_CONFIG_72 in /srv/app/config.json",
      budgets: {
        reflectionTokens: 64,
        protectedObservationTokens: 32,
        recentObservationTokens: 0,
        sourceRelatedObservationTokens: 128,
      },
    });

    expect(plan.protectedOverflow).toBe(true);
    expect(plan.omitted.protectedObservations).toBeGreaterThan(0);
    expect(plan.sourceRelatedObservations.map(observation => observation.id)).toEqual(["related00001"]);
    expect(plan.stableObservations.map(observation => observation.id)).not.toContain("related00001");
  });
});
