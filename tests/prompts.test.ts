import { describe, expect, it } from "vitest";

import {
  OBSERVER_PROMPT,
  OBSERVER_RESPONSE_SCHEMA,
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
    const observer = OBSERVER_PROMPT(["stable reflection"], ["recent observation"]);
    expect(observer.indexOf("Rules:")).toBeLessThan(observer.indexOf("Existing reflections (do not repeat these):"));
    expect(observer.indexOf("Existing reflections (do not repeat these):")).toBeLessThan(
      observer.indexOf("Existing observations (do not repeat these):"),
    );

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

  it("keeps persisted contracts stable while allowing optional source provenance", () => {
    expect(OBSERVER_RESPONSE_SCHEMA.required).toEqual(["observations"]);
    expect(OBSERVER_RESPONSE_SCHEMA.properties.observations.items.required).toEqual(["content", "relevance"]);
    expect(OBSERVER_RESPONSE_SCHEMA.properties.observations.items.properties).toHaveProperty("sourceEntryIds");
  });
});
