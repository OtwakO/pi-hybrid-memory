import { describe, expect, it } from "vitest";

import {
  OBSERVER_SYSTEM,
  REFLECTOR_PROMPT,
  REFLECTOR_SYSTEM,
} from "../src/om/prompts.js";

describe("memory prompt hardening", () => {
  it("gives the observer durable fact-preservation guidance", () => {
    expect(OBSERVER_SYSTEM).toContain("one independent fact");
    expect(OBSERVER_SYSTEM).toContain("authoritative user assertions");
    expect(OBSERVER_SYSTEM).toContain("explicit supersession");
    expect(OBSERVER_SYSTEM).toContain("full paths");
    expect(OBSERVER_SYSTEM).toContain("error text and codes");
    expect(OBSERVER_SYSTEM).toContain("completed or verified outcomes");
    expect(OBSERVER_SYSTEM).toContain("routine events");
    expect(OBSERVER_SYSTEM).toContain("record_observations");
    expect(OBSERVER_SYSTEM).toContain("empty observations array");
    expect(OBSERVER_SYSTEM).not.toContain("Respond with one JSON object");
  });

  it("gives the reflector a strong durable-value and abstraction gate", () => {
    expect(REFLECTOR_SYSTEM).toContain("scarce, durable orientation anchors");
    expect(REFLECTOR_SYSTEM).toContain("Over-reflection is memory distortion");
    expect(REFLECTOR_SYSTEM).toContain("Prefer zero reflections");
    expect(REFLECTOR_SYSTEM).toContain("partial implementation");
    expect(REFLECTOR_SYSTEM).toContain("authoritative user assertions");
    expect(REFLECTOR_SYSTEM).toContain("inflated support");
  });

  it("keeps dynamic memory data after stable prompt instructions", () => {
    const reflector = REFLECTOR_PROMPT(
      [{ id: "aaaaaaaaaaaa", content: "existing durable fact", supportingObservationIds: [], createdAt: 1 }],
      [{
        id: "bbbbbbbbbbbb",
        timestamp: "2026-01-01 00:00",
        content: "new evidence",
        relevance: "high",
        sourceEntryIds: ["1234abcd"],
      }],
    );
    expect(reflector.indexOf("Rules:")).toBeLessThan(reflector.indexOf("Existing reflections:"));
    expect(reflector).toContain("calling submit_reflections exactly once");
    expect(reflector).toContain("empty reflections array");
    expect(reflector.indexOf("Existing reflections:")).toBeLessThan(reflector.indexOf("Observations to synthesize:"));
  });
});
