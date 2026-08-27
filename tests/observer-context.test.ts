import { describe, expect, it } from "vitest";

import {
  OBSERVER_FIXED_TOKEN_RESERVE,
  OBSERVER_PROMPT_VERSION,
  OBSERVER_SERIALIZER_VERSION,
  observerDeltaText,
} from "../src/om/observer-context.js";

// This is a deliberately conservative allowance for observer output, tool schemas,
// provider framing, and one correction turn. Changing it affects both proactive
// observation and compaction catch-up capacity calculations.
describe("observer context reservation", () => {
  it("keeps one shared conservative reservation", () => {
    expect(OBSERVER_FIXED_TOKEN_RESERVE).toBe(6_144);
  });

describe("observer delta provenance guidance", () => {
  it("keeps source-related history separate and lists exact source ids for provenance", () => {
    const prompt = observerDeltaText(
      "chunk",
      ["source-a", "source-b"],
      "SOURCE-RELATED OBSERVATIONS:\n[old-memory] prior fact",
    );

    expect(prompt).toContain("SOURCE-RELATED OBSERVATIONS:\n[old-memory] prior fact");
    expect(prompt).toContain("Valid sourceEntryIds for this chunk: source-a, source-b");
    expect(prompt).toContain("Do not cite source IDs from historical context");
  });
});

  it("invalidates old epochs when bounded observer context becomes active", () => {
    expect(OBSERVER_PROMPT_VERSION).toBe("observer-v6-bounded-context");
  });

  it("invalidates old epochs when segmented source serialization becomes active", () => {
    expect(OBSERVER_SERIALIZER_VERSION).toBe("source-segments-v2");
  });
});
