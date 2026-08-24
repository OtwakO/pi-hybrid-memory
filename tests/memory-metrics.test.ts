import { describe, expect, it } from "vitest";

import {
  buildMemoryMetrics,
  buildMemoryPickerOptions,
  describeContextSummary,
  describeReflectionGate,
} from "../src/memory-metrics.js";
import type { Entry, MemoryReflection, ObservationRecord } from "../src/types.js";

const observation = (id: string, content: string): ObservationRecord => ({
  id,
  content,
  timestamp: "2026-08-25T00:00:00Z",
  relevance: "high",
  sourceEntryIds: ["1234abcd"],
});

describe("memory display metrics", () => {
  it("reports the actual latest compaction summary size instead of a hard-coded zero", () => {
    const compaction: Entry = {
      type: "compaction",
      id: "comp-1",
      summary: "## Memory\n\nA durable summary with useful context.",
    };

    const status = describeContextSummary(compaction);

    expect(status.tokens).toBeGreaterThan(0);
    expect(status.label).toBe(`~${status.tokens.toLocaleString()} tokens in context`);

    const contextOption = buildMemoryPickerOptions({
      observations: [],
      reflections: [],
      compactionSummaries: [compaction.summary as string],
      contextStatus: status,
      reflectionGate: { eligible: false, label: "not yet eligible" },
    }).find(option => option.category === "context");

    expect(contextOption?.detail).toBe(status.label);
    expect(contextOption?.detail).not.toContain("0 entries");
  });

  it("reports when reflections are empty because the observation pool is below the gate", () => {
    const metrics = buildMemoryMetrics({
      reflections: [],
      committedObs: [observation("aaaaaaaaaaaa", "committed fact")],
      pendingObs: [observation("bbbbbbbbbbbb", "pending fact")],
    });

    const status = describeReflectionGate(metrics, 30_000);

    expect(status.eligible).toBe(false);
    expect(status.label).toContain("not yet eligible");
    expect(status.label).toContain(`/ ${30_000 .toLocaleString()} tokens`);

    const reflectionOption = buildMemoryPickerOptions({
      observations: [],
      reflections: [],
      compactionSummaries: [],
      contextStatus: { tokens: 0, label: "no compaction yet" },
      reflectionGate: status,
    }).find(option => option.category === "reflections");

    expect(reflectionOption?.detail).toContain("0 entries");
    expect(reflectionOption?.detail).toContain("not yet eligible");
  });

  it("does not imply that an eligible empty reflection set is merely below threshold", () => {
    const longContent = Array.from({ length: 200 }, () => "durable fact").join(" ");
    const metrics = buildMemoryMetrics({
      reflections: [] as MemoryReflection[],
      committedObs: [observation("aaaaaaaaaaaa", longContent)],
      pendingObs: [],
    });

    const status = describeReflectionGate(metrics, 10);

    expect(status.eligible).toBe(true);
    expect(status.label).toContain("eligible at next compaction");
    expect(status.label).not.toContain("not yet eligible");
  });

  it("returns an explicit no-compaction context state", () => {
    expect(describeContextSummary(undefined)).toEqual({
      tokens: 0,
      label: "no compaction yet",
    });
  });
});
