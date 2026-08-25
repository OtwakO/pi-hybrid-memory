import { describe, expect, it } from "vitest";

import { serializeSourceAddressedBranchEntries } from "../src/om/serialize.js";
import type { Entry } from "../src/types.js";

const entry = (id: string, content: string): Entry => ({
  type: "message",
  id,
  timestamp: "2026-01-01T00:00:00Z",
  message: { role: "user", content },
});

describe("bounded observer source serialization", () => {
  it("keeps complete oldest entries and leaves later entries queued", () => {
    const result = serializeSourceAddressedBranchEntries([
      entry("00000001", "alpha ".repeat(100)),
      entry("00000002", "beta ".repeat(100)),
      entry("00000003", "gamma ".repeat(100)),
    ], 170);

    expect(result.sourceEntryIds).toEqual(["00000001"]);
    expect(result.coversUpToId).toBe("00000001");
    expect(result.hasMore).toBe(true);
    expect(result.text).toContain("alpha ".repeat(20));
    expect(result.text).not.toContain("beta ".repeat(20));
  });

  it("returns all entries when the serialized prompt fits", () => {
    const result = serializeSourceAddressedBranchEntries([
      entry("00000001", "short a"),
      entry("00000002", "short b"),
    ], 1_000);

    expect(result.sourceEntryIds).toEqual(["00000001", "00000002"]);
    expect(result.coversUpToId).toBe("00000002");
    expect(result.hasMore).toBe(false);
    expect(result.truncatedSourceEntryId).toBeUndefined();
  });

  it("segments whitespace-poor sources instead of underestimating them", () => {
    const result = serializeSourceAddressedBranchEntries([
      entry("00000001", "x".repeat(20_000)),
      entry("00000002", "later"),
    ], 1_000);

    expect(result.sourceEntryIds).toEqual(["00000001"]);
    expect(result.coversUpToId).toBeUndefined();
    expect(result.completedSourceEntryIds).toEqual([]);
    expect(result.sourceProgress).toMatchObject({
      sourceEntryId: "00000001",
      nextOffset: expect.any(Number),
      totalLength: expect.any(Number),
    });
    expect(result.sourceProgress?.nextOffset).toBeLessThan(result.sourceProgress?.totalLength ?? 0);
    expect(result.hasMore).toBe(true);
  });

  it("uses a contiguous resumable segment when the oldest entry alone exceeds the cap", () => {
    const content = `HEAD ${"middle ".repeat(1_000)}TAIL`;
    const result = serializeSourceAddressedBranchEntries([
      entry("00000001", content),
      entry("00000002", "later"),
    ], 200);

    expect(result.sourceEntryIds).toEqual(["00000001"]);
    expect(result.coversUpToId).toBeUndefined();
    expect(result.completedSourceEntryIds).toEqual([]);
    expect(result.hasMore).toBe(true);
    expect(result.sourceProgress).toMatchObject({ sourceEntryId: "00000001" });
    expect(result.text).toContain("HEAD ");
    expect(result.text).not.toContain("TAIL");
    expect(result.text).toContain("[Source segment: 00000001 0-");
  });
});
