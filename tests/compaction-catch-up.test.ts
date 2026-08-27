import { describe, expect, it } from "vitest";

import { catchUpProgress } from "../src/om/compaction-catch-up.js";
import type { Entry } from "../src/types.js";

const entry = (id: string): Entry => ({
  type: "message",
  id,
  timestamp: "2026-08-28T00:00:00.000Z",
  message: { role: "user", content: id, timestamp: 1 },
});

describe("bounded compaction catch-up progress", () => {
  it("distinguishes a completed gap from one requiring another compaction attempt", () => {
    const entries = [entry("source01"), entry("source02")];

    expect(catchUpProgress(entries, "before00", {
      text: "source01 and source02",
      sourceEntryIds: ["source01", "source02"],
      completedSourceEntryIds: ["source01", "source02"],
      coversUpToId: "source02",
      hasMore: false,
    })).toEqual({ complete: true, coveredUpToId: "source02" });

    expect(catchUpProgress(entries, "before00", {
      text: "source01",
      sourceEntryIds: ["source01"],
      completedSourceEntryIds: ["source01"],
      coversUpToId: "source01",
      hasMore: true,
    })).toEqual({
      complete: false,
      coveredUpToId: "source01",
      remainingEntries: [entries[1]],
    });
  });
});
