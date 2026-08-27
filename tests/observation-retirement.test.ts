import { describe, expect, it } from "vitest";

import { planExactDuplicateRetirements } from "../src/om/observation-retirement.js";
import type { ObservationRecord } from "../src/types.js";

const observation = (
  id: string,
  content: string,
  relevance: ObservationRecord["relevance"] = "high",
): ObservationRecord => ({ id, content, relevance, timestamp: id });

describe("exact duplicate retirement policy", () => {
  it("retires only canonical later duplicates under narrow normalized equality", () => {
    const legacyRepresentative = observation("aaaaaaaaaaaa", "same\r\ncontent");
    const canonicalDuplicate = observation("bbbbbbbbbbbb", "  same\ncontent  ");
    const differentRelevance = observation("cccccccccccc", "same\ncontent", "medium");
    const canonicalRepresentative = observation("dddddddddddd", "second fact");
    const legacyDuplicate = observation("eeeeeeeeeeee", "second fact");

    const result = planExactDuplicateRetirements(
      [legacyRepresentative, canonicalDuplicate, differentRelevance, canonicalRepresentative, legacyDuplicate],
      new Set([canonicalDuplicate.id, canonicalRepresentative.id]),
    );

    expect(result.activeObservations).toEqual([
      legacyRepresentative,
      differentRelevance,
      canonicalRepresentative,
      legacyDuplicate,
    ]);
    expect(result.retirements).toEqual([{
      observationId: canonicalDuplicate.id,
      reason: "exact-duplicate",
      preservedByObservationIds: [legacyRepresentative.id],
      preservedByReflectionIds: [],
    }]);
  });
});
