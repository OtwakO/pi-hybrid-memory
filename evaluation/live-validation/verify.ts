import { readFile } from "node:fs/promises";

import { buildBranchMemoryIndex } from "../../src/om/branch-memory-index.js";
import { readMemoryDetails, type Entry } from "../../src/types.js";
import { ACTIVE_OBSERVATION_ID, RETIRED_OBSERVATION_ID } from "./fixture.js";

export interface VerificationResult {
  entries: number;
  compactions: number;
  activeObservationIds: string[];
  retiredObservationIds: string[];
  lifecycleIssues: string[];
}

export const readSessionEntries = async (path: string): Promise<Entry[]> => {
  const text = await readFile(path, "utf8");
  const lines = text.split("\n").filter(Boolean).map(line => JSON.parse(line) as Entry);
  return lines.filter(entry => entry.type !== "session");
};

export const verifyPersistedLifecycle = async (
  path: string,
  expectedCompactions = 1,
): Promise<VerificationResult> => {
  const entries = await readSessionEntries(path);
  const index = buildBranchMemoryIndex(entries);
  const compactions = entries.filter(entry => entry.type === "compaction");
  if (compactions.length !== expectedCompactions) {
    throw new Error(`Expected ${expectedCompactions} compaction(s); received ${compactions.length}.`);
  }
  const latestDetails = readMemoryDetails(compactions.at(-1)?.details);
  if (!latestDetails || latestDetails.version !== 5) throw new Error("Latest compaction is not a valid V5 lifecycle batch.");
  const lifecycleBatches = compactions.map(compaction => readMemoryDetails(compaction.details));
  const retirements = lifecycleBatches.flatMap(details => details?.version === 5 ? details.observationsRetired : []);
  if (retirements.length !== 1) {
    throw new Error(`Expected one retirement across the journal; received ${retirements.length}.`);
  }
  if (expectedCompactions > 1 && latestDetails.observationsRetired.length !== 0) {
    throw new Error("Repeated compaction emitted a duplicate retirement event.");
  }
  const retirement = retirements[0];
  if (
    retirement.observationId !== RETIRED_OBSERVATION_ID
    || retirement.preservedByObservationIds.length !== 1
    || retirement.preservedByObservationIds[0] !== ACTIVE_OBSERVATION_ID
    || retirement.reason !== "exact-duplicate"
  ) {
    throw new Error(`Unexpected retirement event: ${JSON.stringify(retirement)}`);
  }
  if (index.issues.length > 0) throw new Error(`Lifecycle replay issues: ${index.issues.map(issue => issue.detail).join("; ")}`);
  const activeLifecycle = index.observationLifecycle(ACTIVE_OBSERVATION_ID);
  const retiredLifecycle = index.observationLifecycle(RETIRED_OBSERVATION_ID);
  if (activeLifecycle?.state !== "active") throw new Error("Preserving observation is not active after replay.");
  if (retiredLifecycle?.state !== "retired") throw new Error("Duplicate observation is not retired after replay.");
  if (!index.observationById(ACTIVE_OBSERVATION_ID) || !index.observationById(RETIRED_OBSERVATION_ID)) {
    throw new Error("Immutable observation evidence is missing after replay.");
  }
  if (index.sourcesForObservation(ACTIVE_OBSERVATION_ID).entries.length !== 1) {
    throw new Error("Active observation provenance is unavailable.");
  }
  if (index.sourcesForObservation(RETIRED_OBSERVATION_ID).entries.length !== 1) {
    throw new Error("Retired observation provenance is unavailable.");
  }
  const allowedIds = new Set([ACTIVE_OBSERVATION_ID, RETIRED_OBSERVATION_ID]);
  const unexpectedObservationIds = entries
    .filter(entry => entry.type === "custom" && entry.customType === "hybrid-memory.observation")
    .flatMap(entry => {
      const data = entry.data as { records?: Array<{ id?: unknown }> } | undefined;
      return data?.records?.map(record => record.id).filter((id): id is string => typeof id === "string") ?? [];
    })
    .filter(id => !allowedIds.has(id));
  if (unexpectedObservationIds.length > 0) {
    throw new Error(`Unexpected observer output in deterministic trial: ${unexpectedObservationIds.join(", ")}`);
  }

  return {
    entries: entries.length,
    compactions: compactions.length,
    activeObservationIds: [...index.activeObservationIds()],
    retiredObservationIds: [RETIRED_OBSERVATION_ID],
    lifecycleIssues: [],
  };
};
