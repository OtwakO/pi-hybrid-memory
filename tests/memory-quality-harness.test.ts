import { describe, expect, it } from "vitest";

import { createMemoryQualityFixture } from "./quality/memory-quality-fixture.js";
import { evaluateMemoryQuality } from "./quality/memory-quality-harness.js";
import type { ReflectionRecord } from "../src/types.js";

const sizes = [300, 600, 900] as const;

describe("long-session memory quality harness", () => {
  it.each(sizes)("evaluates deterministic %i-observation projections", (size) => {
    const fixture = createMemoryQualityFixture(size);
    const baseline = evaluateMemoryQuality(fixture, {
      activeObservations: fixture.observations,
      currentReflections: [],
      retiredObservationIds: [],
    });

    expect(fixture.observations).toHaveLength(size);
    expect(new Set(fixture.observations.map(item => item.id)).size).toBe(size);
    expect(baseline).toMatchObject({
      valid: true,
      failedRequiredFactIds: [],
      falseRetirementIds: [],
      falseRetentionIds: [],
      missingProvenanceIds: [],
      reducedTokens: 0,
      reductionPercentage: 0,
    });

    const [preservable, falselyRetained] = fixture.requiredFacts
      .filter(fact => fact.disposition === "retirable-if-exactly-preserved");
    const falselyRetired = fixture.requiredFacts.find(fact => fact.disposition === "must-retain")!;
    const reflection: ReflectionRecord = {
      id: "zzzzzzzzzzzz",
      content: `Durable preservation: ${preservable.requiredMarker}`,
      supportingObservationIds: [preservable.observationId, falselyRetained.observationId],
    };
    const retiredIds = [preservable.observationId, falselyRetired.observationId];
    const activeObservations = fixture.observations.filter(item => !retiredIds.includes(item.id));
    const candidate = evaluateMemoryQuality(fixture, {
      activeObservations,
      currentReflections: [{
        ...reflection,
        content: `${reflection.content}\n${falselyRetained.requiredMarker}`,
      }],
      retiredObservationIds: retiredIds,
    });
    const repeated = evaluateMemoryQuality(fixture, {
      activeObservations,
      currentReflections: [{
        ...reflection,
        content: `${reflection.content}\n${falselyRetained.requiredMarker}`,
      }],
      retiredObservationIds: retiredIds,
    });

    expect(candidate.falseRetirementIds).toEqual([falselyRetired.observationId]);
    expect(candidate.falseRetentionIds).toEqual([falselyRetained.observationId]);
    expect(candidate.failedRequiredFactIds).toEqual([falselyRetired.observationId]);
    expect(candidate.reducedTokens).toBeGreaterThan(0);
    expect(candidate.fingerprint).toBe(repeated.fingerprint);
    expect(candidate).toEqual(repeated);
  });

  it("reports structural invalidity and missing immutable provenance once", () => {
    const fixture = createMemoryQualityFixture(300);
    const active = fixture.observations[0];
    const result = evaluateMemoryQuality(fixture, {
      activeObservations: [active, active],
      retiredObservationIds: [active.id, "not-in-fixture"],
      currentReflections: [{
        id: "zzzzzzzzzzzz",
        content: "invalid support",
        supportingObservationIds: ["not-in-fixture"],
      }],
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      "duplicate-active-observation-id",
      "active-retired-overlap",
      "unknown-retired-observation-id",
      "unknown-reflection-support-id",
      "unclassified-observation-id",
    ]));
  });
});
