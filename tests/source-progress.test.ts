import { describe, expect, it } from "vitest";

import { resolveObservationCoverageAnchor } from "../src/om/branch.js";
import {
  serializeSourceAddressedBranchEntries,
  type SourceProgress,
} from "../src/om/serialize.js";
import { OBSERVATION_CUSTOM_TYPE } from "../src/types.js";
import type { Entry, ObservationEntryData } from "../src/types.js";

const entry = (id: string, content: string): Entry => ({
  type: "message",
  id,
  timestamp: "2026-01-01T00:00:00Z",
  message: { role: "user", content },
});

const observationEntry = (
  id: string,
  coversUpToId: string,
  sourceProgress?: SourceProgress,
): Entry => ({
  type: "custom",
  id,
  customType: OBSERVATION_CUSTOM_TYPE,
  data: {
    records: [],
    coversFromId: coversUpToId,
    coversUpToId,
    tokenCount: 0,
    sourceProgress,
  } satisfies ObservationEntryData,
});

describe("oversized source progress", () => {
  it("serializes a contiguous first segment without claiming full source coverage", () => {
    const source = entry("large-source", `HEAD ${"middle ".repeat(1_000)}TAIL`);

    const result = serializeSourceAddressedBranchEntries([source], 100);

    expect(result.completedSourceEntryIds).toEqual([]);
    expect(result.coversUpToId).toBeUndefined();
    expect(result.sourceProgress).toMatchObject({
      sourceEntryId: "large-source",
      nextOffset: expect.any(Number),
      totalLength: expect.any(Number),
    });
    expect(result.sourceProgress!.nextOffset).toBeGreaterThan(0);
    expect(result.sourceProgress!.nextOffset).toBeLessThan(result.sourceProgress!.totalLength);
    expect(result.text).toContain("[Source segment: large-source 0-");
    expect(result.text).not.toContain("TAIL");
  });

  it("resumes at the exact next offset and eventually completes the source", () => {
    const source = entry("large-source", `HEAD ${"middle ".repeat(200)}TAIL`);
    const first = serializeSourceAddressedBranchEntries([source], 80);
    expect(first.sourceProgress).toBeDefined();

    const second = serializeSourceAddressedBranchEntries([source], 10_000, first.sourceProgress);

    expect(second.text).toContain(`[Source segment: large-source ${first.sourceProgress!.nextOffset}-`);
    expect(second.text).toContain("TAIL");
    expect(second.sourceProgress).toBeUndefined();
    expect(second.completedSourceEntryIds).toEqual(["large-source"]);
    expect(second.coversUpToId).toBe("large-source");
  });

  it("restarts from zero when persisted progress no longer matches the rendered source", () => {
    const source = entry("large-source", `HEAD ${"middle ".repeat(200)}TAIL`);
    const first = serializeSourceAddressedBranchEntries([source], 80);
    expect(first.sourceProgress).toBeDefined();

    const changedSource = entry("large-source", `CHANGED ${"middle ".repeat(200)}TAIL`);
    const resumed = serializeSourceAddressedBranchEntries([changedSource], 80, first.sourceProgress);

    expect(resumed.text).toContain("[Source segment: large-source 0-");
    expect(resumed.sourceProgress?.nextOffset).toBe(first.sourceProgress!.nextOffset);
  });

  it("restores partial progress without advancing the durable full-coverage anchor", () => {
    const progress: SourceProgress = {
      sourceEntryId: "large-source",
      nextOffset: 400,
      totalLength: 2_000,
    };
    const entries = [
      entry("fully-covered", "done"),
      entry("large-source", "still pending"),
      observationEntry("obs-progress", "fully-covered", progress),
    ];

    expect(resolveObservationCoverageAnchor(entries)).toEqual({
      coveredSourceId: "fully-covered",
      coveredSourceIndex: 0,
      sourceProgress: progress,
    });
  });

  it("ignores stale progress whose source no longer immediately follows the full anchor", () => {
    const entries = [
      entry("fully-covered", "done"),
      entry("intervening-source", "new branch content"),
      entry("large-source", "old branch content"),
      observationEntry("obs-progress", "fully-covered", {
        sourceEntryId: "large-source",
        nextOffset: 10,
        totalLength: 100,
      }),
    ];

    expect(resolveObservationCoverageAnchor(entries)).toEqual({
      coveredSourceId: "fully-covered",
      coveredSourceIndex: 0,
      sourceProgress: undefined,
    });
  });
});
