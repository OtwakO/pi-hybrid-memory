// Tests for pi-hybrid-memory branch utilities: kept-boundary recovery on old
// sessions whose CompactionEntry.firstKeptEntryId references an entry pruned
// from the current branch view. See RECORDED-BEHAVIOUR in src/om/branch.ts.
import { describe, it, expect } from "vitest";
import {
  collectObservationsByCoverage,
  rawTokensSinceLastCompaction,
  findLastCompactionIndex,
  resolveObservationCoverageAnchor,
} from "../src/om/branch.js";
import { buildBranchMemoryIndex } from "../src/om/branch-memory-index.js";
import { readMemoryDetails } from "../src/types.js";
import { OBSERVATION_CUSTOM_TYPE } from "../src/types.js";
import type {
  Entry,
  MemoryDetailsV4,
  ObservationEntryData,
  ObservationRecord,
} from "../src/types.js";

// ── Test helpers ──────────────────────────────────────────────────────────

const userEntry = (id: string): Entry => ({
  type: "message",
  id,
  parentId: "p",
  timestamp: "2026-06-27T00:00:00Z",
  message: { role: "user", content: `hello ${id}` },
});

const compactionEntry = (id: string, firstKept: string, details?: unknown, summary = "summary"): Entry => ({
  type: "compaction",
  id,
  parentId: "p",
  timestamp: "2026-06-27T00:00:00Z",
  summary,
  firstKeptEntryId: firstKept,
  details,
});

const observationCustomEntry = (id: string, data: ObservationEntryData): Entry => ({
  type: "custom",
  id,
  parentId: "p",
  timestamp: "2026-06-27T00:00:00Z",
  customType: OBSERVATION_CUSTOM_TYPE,
  data,
});

const obsRecord = (id = "aaaaaaaaaaaa", content = "an observation"): ObservationRecord => ({
  id,
  content,
  timestamp: "2026-06-27T00:00:00Z",
  relevance: "high",
});

const omDetails = (observations: ObservationRecord[] = []): MemoryDetailsV4 => ({
  type: "observational-memory",
  version: 4,
  observations,
  reflections: [],
});

const obsData = (coversFromId: string, coversUpToId: string, records: ObservationRecord[]): ObservationEntryData => ({
  records,
  coversFromId,
  coversUpToId,
  tokenCount: records.length * 10,
});

describe("memory details compatibility reader", () => {
  it("normalizes validated V3 details to the current V4 read model", () => {
    expect(readMemoryDetails({
      type: "observational-memory",
      version: 3,
      observations: [obsRecord()],
      reflections: ["legacy reflection"],
    })).toEqual({
      type: "observational-memory",
      version: 4,
      observations: [obsRecord()],
      reflections: ["legacy reflection"],
    });
  });

  it("reads strict V5 lifecycle details and rejects malformed or unknown versions", () => {
    expect(readMemoryDetails({
      type: "observational-memory",
      version: 5,
      generation: { inputFingerprint: "fingerprint" },
      reflectionsAdded: [{
        id: "bbbbbbbbbbbb",
        content: "new reflection",
        supportingObservationIds: ["aaaaaaaaaaaa"],
      }],
      observationsRetired: [],
      reflectionsSuperseded: [],
    })).toEqual({
      type: "observational-memory",
      version: 5,
      generation: { inputFingerprint: "fingerprint" },
      reflectionsAdded: [{
        id: "bbbbbbbbbbbb",
        content: "new reflection",
        supportingObservationIds: ["aaaaaaaaaaaa"],
      }],
      observationsRetired: [],
      reflectionsSuperseded: [],
    });
    expect(readMemoryDetails({
      type: "observational-memory",
      version: 6,
      generation: { inputFingerprint: "future" },
    })).toBeUndefined();
    expect(readMemoryDetails({
      type: "observational-memory",
      version: 5,
      generation: { inputFingerprint: "fingerprint" },
      reflectionsAdded: [],
      observationsRetired: ["not-yet-supported"],
      reflectionsSuperseded: [],
    })).toBeUndefined();
    expect(readMemoryDetails({
      type: "observational-memory",
      version: 4,
      observations: [{ id: "bad", relevance: "urgent" }],
      reflections: [],
    })).toBeUndefined();
    expect(readMemoryDetails({
      type: "observational-memory",
      version: 4,
      observations: [],
      reflections: [{ id: "bad", content: "missing provenance" }],
    })).toBeUndefined();
  });
});

// ── Regression: missing prior firstKeptEntryId on old sessions ─────────────

describe("kept-boundary recovery (retrofit edge case)", () => {
  describe("getMemoryState", () => {
    it("does not throw when prior firstKeptEntryId is not in the branch", () => {
      const entries: Entry[] = [
        // Compaction written by Pi's DEFAULT compaction on an old session.
        // firstKeptEntryId "6fd67ce7" references an entry that has since been
        // pruned from this branch view (e.g. it lived before an even-earlier
        // kept boundary on the main line).
        compactionEntry("comp1", "6fd67ce7", omDetails([obsRecord("aaaaaaaaaaaa", "committed prior fact")])),
        userEntry("after-comp-a"),
        userEntry("after-comp-b"),
      ];

      const state = buildBranchMemoryIndex(entries).current;

      // No throw — regression fixed.
      expect(state.reflections).toEqual([]);
      // committedObs survives via details — they are independent of the boundary.
      expect(state.committedObs).toHaveLength(1);
      expect(state.committedObs[0].content).toBe("committed prior fact");
      // No observation entries in this test → pending is empty.
      expect(state.pendingObs).toEqual([]);
    });

    it("fires onRecover exactly once when boundary is unresolved", () => {
      const entries: Entry[] = [
        compactionEntry("comp1", "missing-id", omDetails()),
        userEntry("after-comp"),
      ];
      const recovered: string[] = [];
      buildBranchMemoryIndex(entries, { onBoundaryRecovery: (firstKept) => recovered.push(firstKept) });
      expect(recovered).toEqual(["missing-id"]);
    });

    it("does not fire onRecover when boundary resolves cleanly", () => {
      const entries: Entry[] = [
        compactionEntry("comp1", "kept-entry", omDetails()),
        userEntry("kept-entry"),
      ];
      const recovered: string[] = [];
      buildBranchMemoryIndex(entries, { onBoundaryRecovery: (firstKept) => recovered.push(firstKept) });
      expect(recovered).toEqual([]);
    });

    it("does not fire onRecover when firstKeptEntryId is absent (early-pi schema)", () => {
      const comp = compactionEntry("comp1", "kept-entry", omDetails());
      // Drop the firstKeptEntryId field entirely (older schema).
      comp.firstKeptEntryId = undefined;
      const entries: Entry[] = [comp, userEntry("kept-entry")];
      const recovered: string[] = [];
      expect(() => buildBranchMemoryIndex(entries, { onBoundaryRecovery: (firstKept) => recovered.push(firstKept) })).not.toThrow();
      expect(recovered).toEqual([]);
    });

    it("treats observations after a recovered boundary as pending (safe over-inclusion)", () => {
      // Two observation entries exist; both are after the compaction entry.
      // With an unresolved boundary, both are pending — the reflector's
      // contentIndex dedup absorbs any re-evaluation on compaction.
      const entries: Entry[] = [
        compactionEntry("comp1", "missing-id", omDetails()),
        userEntry("raw-a"),
        userEntry("raw-b"),
        observationCustomEntry("obs-a", obsData("raw-a", "raw-a", [obsRecord("bbbbbbbbbbbb", "first chunk fact")])),
        observationCustomEntry("obs-b", obsData("raw-b", "raw-b", [obsRecord("cccccccccccc", "second chunk fact")])),
      ];

      const state = buildBranchMemoryIndex(entries).current;

      expect(state.pendingObs.map((o) => o.content)).toEqual([
        "first chunk fact",
        "second chunk fact",
      ]);
    });

    it("preserves committedObs from compaction details even after recovery", () => {
      // committedObs come from details and are NEVER invalidated by recovery.
      // This is the no-silent-data-loss guarantee for retrofit edge cases.
      const prior = [obsRecord("aaaaaaaaaaaa", "preserved-committed-fact")];
      const entries: Entry[] = [
        compactionEntry("comp1", "missing", omDetails(prior)),
        userEntry("after-comp"),
      ];
      const state = buildBranchMemoryIndex(entries).current;
      expect(state.committedObs).toHaveLength(1);
      expect(state.committedObs[0].content).toBe("preserved-committed-fact");
    });

    it("isolates pending correctly when boundary resolves cleanly", () => {
      // Sanity check: with a clean boundary, only observations after it are pending.
      const entries: Entry[] = [
        compactionEntry("comp1", "kept-x", omDetails()),
        userEntry("before-kept"), // not the kept entry
        userEntry("kept-x"),
        userEntry("raw-after"),
        observationCustomEntry("obs-a", obsData("raw-after", "raw-after", [obsRecord("dddddddddddd", "later fact")])),
      ];

      const state = buildBranchMemoryIndex(entries).current;
      expect(state.pendingObs.map((o) => o.content)).toEqual(["later fact"]);
    });
  });

  describe("collectObservationsByCoverage", () => {
    it("does not throw when prior firstKeptEntryId is missing from branch", () => {
      // Layout: [comp1, 0] [raw-being-summarized, 1] [obs covering it, 2] [new-kept, 3]
      // With prior boundary "missing-prior-id" unresolved, the fallback is
      // compactionIdx+1 = 1 (raw-being-summarized). The window [1, 3) contains
      // the observation covering raw-being-summarized at idx 1 → match.
      const entries: Entry[] = [
        compactionEntry("comp1", "missing-prior-id", omDetails()),
        userEntry("raw-being-summarized"),
        observationCustomEntry("obs-a", obsData("raw-being-summarized", "raw-being-summarized", [obsRecord("eeeeeeeeeeee", "covered fact")])),
        userEntry("new-kept"),
      ];

      const result = collectObservationsByCoverage(entries, "missing-prior-id", "new-kept");

      // No throw — recovery fallback engages.
      expect(result).toHaveLength(1);
      expect(result[0].records[0].content).toBe("covered fact");
    });

    it("fires onRecover when prior boundary is unresolved", () => {
      const entries: Entry[] = [
        compactionEntry("comp1", "missing-prior-id", omDetails()),
        userEntry("new-kept"),
      ];
      const recovered: string[] = [];
      collectObservationsByCoverage(entries, "missing-prior-id", "new-kept", (firstKept) =>
        recovered.push(firstKept),
      );
      expect(recovered).toEqual(["missing-prior-id"]);
    });

    it("returns empty when new firstKeptEntryId is missing (no regressions)", () => {
      const entries: Entry[] = [compactionEntry("comp1", "kept", omDetails()), userEntry("kept")];
      const result = collectObservationsByCoverage(entries, "kept", "no-such-new-id");
      expect(result).toEqual([]);
    });

    it("handles priorFirstKeptEntryId undefined as the broad window (no recovery fired)", () => {
      // Layout: [comp1, 0] [raw-A, 1] [obs covers raw-A, 2] [new-kept, 3]
      // With prior undefined, window = [-1, newKept) → includes the obs.
      const entries: Entry[] = [
        compactionEntry("comp1", "kept", omDetails()),
        userEntry("raw-A"),
        observationCustomEntry("obs-a", obsData("raw-A", "raw-A", [obsRecord("ffffffffffff", "fact a")])),
        userEntry("new-kept"),
      ];
      const recovered: string[] = [];
      const result = collectObservationsByCoverage(entries, undefined, "new-kept", (firstKept) =>
        recovered.push(firstKept),
      );
      expect(result).toHaveLength(1);
      expect(recovered).toEqual([]);
    });
  });

  describe("rawTokensSinceLastCompaction", () => {
    it("does not throw when firstKeptEntryId cannot be located", () => {
      const entries: Entry[] = [
        compactionEntry("comp1", "missing-id"),
        // raw entries after the compaction contribute live-tail tokens
        { ...userEntry("after-comp-a"), message: { role: "user", content: "x".repeat(50) } },
        { ...userEntry("after-comp-b"), message: { role: "user", content: "y".repeat(50) } },
      ];
      // Previously this threw; now it falls back to compactionIdx + 1 and
      // counts the live tail. No assertion on exact token count — just that
      // it is a non-negative finite number without throwing.
      expect(() => rawTokensSinceLastCompaction(entries)).not.toThrow();
      const tokens = rawTokensSinceLastCompaction(entries);
      expect(Number.isFinite(tokens)).toBe(true);
      expect(tokens).toBeGreaterThanOrEqual(0);
    });

    it("returns a finite count when no compaction exists", () => {
      const entries: Entry[] = [userEntry("a"), userEntry("b")];
      expect(() => rawTokensSinceLastCompaction(entries)).not.toThrow();
      const tokens = rawTokensSinceLastCompaction(entries);
      expect(Number.isFinite(tokens)).toBe(true);
    });
  });
});

describe("resolveObservationCoverageAnchor", () => {
  it("uses durable coverage data even when the latest observation entry has no records", () => {
    const entries: Entry[] = [
      userEntry("raw-a"),
      observationCustomEntry("obs-a", obsData("raw-a", "raw-a", [obsRecord()])),
      userEntry("raw-b"),
      observationCustomEntry("obs-empty", obsData("raw-b", "raw-b", [])),
      userEntry("raw-c"),
    ];

    expect(resolveObservationCoverageAnchor(entries)).toEqual({
      coveredSourceId: "raw-b",
      coveredSourceIndex: 2,
    });
  });

  it("returns no anchor when a coverage marker points outside the current branch", () => {
    const entries: Entry[] = [
      userEntry("raw-a"),
      observationCustomEntry("obs-missing", obsData("raw-a", "other-branch-source", [])),
    ];

    expect(resolveObservationCoverageAnchor(entries)).toEqual({
      coveredSourceId: undefined,
      coveredSourceIndex: -1,
    });
  });
});

describe("findLastCompactionIndex", () => {
  it("returns -1 when no compaction entries exist", () => {
    expect(findLastCompactionIndex([userEntry("a"), userEntry("b")])).toBe(-1);
  });

  it("returns the index of the most recent compaction", () => {
    const entries: Entry[] = [
      compactionEntry("comp1", "kept1"),
      userEntry("a"),
      compactionEntry("comp2", "kept2"),
      userEntry("b"),
    ];
    expect(findLastCompactionIndex(entries)).toBe(2);
  });
});

// ── Idempotency ────────────────────────────────────────────────────────────

describe("idempotency of recovery", () => {
  it("yields identical MemoryState across repeated calls (data layer is pure)", () => {
    const entries: Entry[] = [
      compactionEntry("comp1", "missing", omDetails([obsRecord("aaaaaaaaaaaa", "committed")])),
      userEntry("after-comp"),
      observationCustomEntry("obs-a", obsData("after-comp", "after-comp", [obsRecord("bbbbbbbbbbbb", "pending fact")])),
    ];
    const a = buildBranchMemoryIndex(entries).current;
    const b = buildBranchMemoryIndex(entries).current;
    expect(b).toEqual(a);
  });

  it("fires the onRecover callback on every call (debounce is the caller's job)", () => {
    // This pins the contract: the data layer does NOT debounce; callers (observer
    // trigger / compaction hook) own the one-shot notice via Runtime.boundaryRecoveryNotified.
    const entries: Entry[] = [compactionEntry("comp1", "missing", omDetails()), userEntry("x")];
    const recovered: string[] = [];
    buildBranchMemoryIndex(entries, { onBoundaryRecovery: (firstKept) => recovered.push(firstKept) });
    buildBranchMemoryIndex(entries, { onBoundaryRecovery: (firstKept) => recovered.push(firstKept) });
    buildBranchMemoryIndex(entries, { onBoundaryRecovery: (firstKept) => recovered.push(firstKept) });
    expect(recovered).toEqual(["missing", "missing", "missing"]);
  });
});