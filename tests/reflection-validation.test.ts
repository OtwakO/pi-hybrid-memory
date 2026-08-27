import { describe, expect, it } from "vitest";
import { validateAndMergeReflections } from "../src/om/reflection-validation.js";
import type { MemoryReflection, ObservationRecord } from "../src/types.js";

const observation: ObservationRecord = {
  id: "aaaaaaaaaaaa",
  content: "durable fact",
  timestamp: "2026-01-01 00:00",
  relevance: "high",
};

describe("validateAndMergeReflections", () => {
  it("rejects unknown and duplicate support ids", () => {
    expect(validateAndMergeReflections([], [observation], [{
      content: "unknown support",
      supportingObservationIds: ["bbbbbbbbbbbb"],
    }])).toEqual({ ok: false, reason: "invalid-provenance" });

    expect(validateAndMergeReflections([], [observation], [{
      content: "duplicate support",
      supportingObservationIds: [observation.id, observation.id],
    }])).toEqual({ ok: false, reason: "invalid-provenance" });
  });

  it("creates one immutable strengthened successor with unioned support", () => {
    const secondObservation: ObservationRecord = {
      ...observation,
      id: "cccccccccccc",
      content: "second durable fact",
    };
    const existing: MemoryReflection[] = [{
      id: "bbbbbbbbbbbb",
      content: "durable reflection",
      supportingObservationIds: [observation.id],
    }];

    const result = validateAndMergeReflections(existing, [observation, secondObservation], [
      {
        content: " durable   reflection ",
        supportingObservationIds: [secondObservation.id],
      },
      {
        content: "durable reflection",
        supportingObservationIds: [observation.id],
      },
    ]);

    expect(result).toMatchObject({
      ok: true,
      proposedItems: 2,
      acceptedItems: 1,
      addedItems: 0,
      strengthenedItems: 1,
      supersessions: [{
        reflectionId: existing[0].id,
        reason: "strengthened",
      }],
      reflections: [{
        content: "durable reflection",
        supportingObservationIds: [observation.id, secondObservation.id],
      }],
    });
    expect(existing[0]).toEqual({
      id: "bbbbbbbbbbbb",
      content: "durable reflection",
      supportingObservationIds: [observation.id],
    });
  });

  it("reports a duplicate proposal as proposed but not accepted", () => {
    const existing: MemoryReflection[] = [{
      id: "bbbbbbbbbbbb",
      content: "durable reflection",
      supportingObservationIds: [observation.id],
    }];

    const result = validateAndMergeReflections(existing, [observation], [{
      content: " durable   reflection ",
      supportingObservationIds: [observation.id],
    }]);

    expect(result).toMatchObject({
      ok: true,
      proposedItems: 1,
      acceptedItems: 0,
      addedItems: 0,
      strengthenedItems: 0,
    });
  });
});
