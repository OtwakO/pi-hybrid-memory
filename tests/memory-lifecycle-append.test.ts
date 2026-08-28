import { describe, expect, it, vi } from "vitest";

import {
  appendIncrementalLifecycle,
  captureLifecycleAppendFence,
} from "../src/om/memory-lifecycle-append.js";
import { buildBranchMemoryIndex } from "../src/om/branch-memory-index.js";
import {
  MEMORY_LIFECYCLE_CUSTOM_TYPE,
  OBSERVATION_CUSTOM_TYPE,
} from "../src/types.js";
import type {
  Entry,
  MemoryLifecycleEventV6,
  ObservationEntryData,
  ObservationRecord,
} from "../src/types.js";

const observation: ObservationRecord = {
  id: "aaaaaaaaaaaa",
  content: "durable fact",
  timestamp: "2026-08-28T00:00:00.000Z",
  relevance: "high",
  sourceEntryIds: ["source01"],
};

const source = (id: string): Entry => ({
  type: "message",
  id,
  timestamp: "2026-08-28T00:00:00.000Z",
  message: { role: "user", content: id, timestamp: 1 },
});

const observationEntry = (): Entry => ({
  type: "custom",
  id: "obsentry1",
  customType: OBSERVATION_CUSTOM_TYPE,
  data: {
    records: [observation],
    coversFromId: "source01",
    coversUpToId: "source01",
    tokenCount: 3,
  } satisfies ObservationEntryData,
});

const lifecycle = (id: string, parentLifecycleEntryId?: string): Entry => ({
  type: "custom",
  id,
  customType: MEMORY_LIFECYCLE_CUSTOM_TYPE,
  data: {
    type: "observational-memory",
    version: 6,
    generation: {
      inputFingerprint: id.padEnd(64, "0"),
      ...(parentLifecycleEntryId ? { parentLifecycleEntryId } : {}),
    },
    reflectionsAdded: [],
    observationsRetired: [],
    reflectionsSuperseded: [],
  } satisfies MemoryLifecycleEventV6,
});

const setup = (initialEntries: Entry[]) => {
  const entries = [...initialEntries];
  let sessionId = "session-a";
  let leafId = entries.at(-1)?.id;
  let nextEntry = 1;
  const session = {
    getSessionId: () => sessionId,
    getLeafId: () => leafId,
    getBranch: () => entries,
  };
  const appendEntry = vi.fn((customType: string, data: unknown) => {
    const id = `appended${nextEntry++}`;
    entries.push({ type: "custom", id, customType, data });
    leafId = id;
  });
  return {
    appendEntry,
    entries,
    session,
    setLeafId: (value: string) => { leafId = value; },
    setSessionId: (value: string) => { sessionId = value; },
  };
};

const appendInput = (fixture: ReturnType<typeof setup>) => ({
  session: fixture.session,
  appendEntry: fixture.appendEntry,
  fence: captureLifecycleAppendFence(fixture.session, fixture.entries),
  reflectionProgress: {
    consideredThroughObservationEntryId: "obsentry1",
    compatibilityVersion: "reflection-v1",
  },
  observations: [observation],
  previousReflections: [],
  currentReflections: [],
  retirements: [],
  supersessions: [],
});

describe("incremental lifecycle append", () => {
  it("appends one projector-validated V6 event", () => {
    const fixture = setup([source("source01"), observationEntry()]);

    const result = appendIncrementalLifecycle(appendInput(fixture));

    expect(result).toEqual({ ok: true });
    expect(fixture.appendEntry).toHaveBeenCalledOnce();
    expect(fixture.appendEntry).toHaveBeenCalledWith(
      MEMORY_LIFECYCLE_CUSTOM_TYPE,
      expect.objectContaining({
        version: 6,
        reflectionProgress: {
          consideredThroughObservationEntryId: "obsentry1",
          compatibilityVersion: "reflection-v1",
        },
      }),
    );
    const index = buildBranchMemoryIndex(fixture.entries);
    expect(index.latestLifecycleEntryId).toBe("appended1");
    expect(index.issues).toEqual([]);
  });

  it("rejects a result when another lifecycle event advanced the parent", () => {
    const fixture = setup([source("source01"), observationEntry(), lifecycle("life0001")]);
    const input = appendInput(fixture);
    fixture.entries.splice(2, 1, lifecycle("life0002", "life0001"));
    fixture.setLeafId("life0001");

    expect(appendIncrementalLifecycle(input)).toEqual({
      ok: false,
      reason: "lifecycle-advanced",
    });
    expect(fixture.appendEntry).not.toHaveBeenCalled();
  });

  it("rejects a result after session or branch navigation", () => {
    const sessionChanged = setup([source("source01"), observationEntry()]);
    const sessionInput = appendInput(sessionChanged);
    sessionChanged.setSessionId("session-b");
    expect(appendIncrementalLifecycle(sessionInput)).toEqual({
      ok: false,
      reason: "session-changed",
    });

    const branchChanged = setup([source("source01"), observationEntry()]);
    const branchInput = appendInput(branchChanged);
    branchChanged.entries.push(source("otherleaf"));
    branchChanged.setLeafId("otherleaf");
    expect(appendIncrementalLifecycle(branchInput)).toEqual({
      ok: false,
      reason: "branch-changed",
    });
    expect(sessionChanged.appendEntry).not.toHaveBeenCalled();
    expect(branchChanged.appendEntry).not.toHaveBeenCalled();
  });

  it("rejects an invalid frontier before writing the journal", () => {
    const fixture = setup([source("source01"), observationEntry()]);
    const input = appendInput(fixture);
    input.reflectionProgress.consideredThroughObservationEntryId = "unknown-entry";

    expect(appendIncrementalLifecycle(input)).toEqual({
      ok: false,
      reason: "invalid-lifecycle-event",
    });
    expect(fixture.appendEntry).not.toHaveBeenCalled();
  });
});
