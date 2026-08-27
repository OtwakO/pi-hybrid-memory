import type { ObservationRecord } from "../../src/types.js";
import type { MemoryQualityFixture, RequiredFact } from "./memory-quality-harness.js";

const memoryId = (index: number): string => index.toString(36).padStart(12, "0").slice(-12);
const sourceId = (index: number): string => index.toString(16).padStart(8, "0").slice(-8);

const requiredTemplates: Array<{
  marker: string;
  disposition: RequiredFact["disposition"];
}> = [
  { marker: "PATH=/srv/app/config/runtime.json", disposition: "must-retain" },
  { marker: "VERSION=pi-memory@5.4.1", disposition: "must-retain" },
  { marker: "CONFIG observerEpochMaxTokens=108800", disposition: "must-retain" },
  { marker: "ERROR=Lifecycle parent mismatch: expected compact-a, received compact-b", disposition: "must-retain" },
  { marker: "DIAGNOSIS=stale branch parent caused atomic replay rejection", disposition: "retirable-if-exactly-preserved" },
  { marker: "CORRECTION=Do not modify auth; scope is memory lifecycle only", disposition: "must-retain" },
  { marker: "DECISION=Use branch-local journal because compaction details are atomic", disposition: "retirable-if-exactly-preserved" },
  { marker: "RATIONALE=Avoid repeated full snapshots and quadratic-like disk duplication", disposition: "must-retain" },
  { marker: "CHRONOLOGY=Phase A then duplicate retirement then reflection strengthening", disposition: "must-retain" },
  { marker: "UNRESOLVED=Semantic retirement requires the 300/600/900 quality gate", disposition: "must-retain" },
  { marker: "CONSTRAINT=Retired evidence must remain exactly recallable", disposition: "retirable-if-exactly-preserved" },
  { marker: "MISSING_SOURCE=source deadbeef is unavailable and must be disclosed", disposition: "must-retain" },
];

export const createMemoryQualityFixture = (size: 300 | 600 | 900): MemoryQualityFixture => {
  const requiredFacts: RequiredFact[] = requiredTemplates.map((template, index) => ({
    observationId: memoryId(index + 1),
    requiredMarker: template.marker,
    expectedSourceIds: [sourceId(index + 1)],
    disposition: template.disposition,
  }));
  const observations: ObservationRecord[] = requiredFacts.map((fact, index) => ({
    id: fact.observationId,
    content: `Required memory ${index + 1}. ${fact.requiredMarker}`,
    timestamp: `2026-08-27T00:${String(index).padStart(2, "0")}:00.000Z`,
    relevance: index % 3 === 0 ? "critical" : "high",
    sourceEntryIds: [...fact.expectedSourceIds],
  }));

  for (let index = observations.length; index < size; index++) {
    observations.push({
      id: memoryId(index + 1),
      content: `Generated filler ${index + 1}: deterministic operational note ${index % 17}.`,
      timestamp: `2026-08-27T01:${String(index % 60).padStart(2, "0")}:00.000Z`,
      relevance: index % 5 === 0 ? "medium" : "low",
      sourceEntryIds: [sourceId(index + 1)],
    });
  }

  return { observations, requiredFacts };
};
