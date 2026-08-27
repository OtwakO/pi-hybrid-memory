import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { ObservationEntryData, ObservationRecord } from "../../src/types.js";
import { OBSERVATION_CUSTOM_TYPE } from "../../src/types.js";

export const ACTIVE_OBSERVATION_ID = "liveactive01";
export const RETIRED_OBSERVATION_ID = "liveretire01";

export interface LiveFixture {
  cwd: string;
  sessionDir: string;
  sessionFile: string;
  sourceEntryIds: [string, string];
}

const observation = (id: string, sourceEntryId: string): ObservationRecord => ({
  id,
  content: "The controlled live-validation marker is exact-duplicate-safe.",
  timestamp: "2026-08-27T00:00:00.000Z",
  relevance: "high",
  sourceEntryIds: [sourceEntryId],
});

export const seedLiveFixture = async (root: string): Promise<LiveFixture> => {
  const cwd = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 2_000 },
  }, null, 2));
  await writeFile(join(cwd, ".pi", "pi-hybrid-memory-config.json"), JSON.stringify({
    overrideDefaultCompaction: true,
    observationThresholdTokens: 1_000_000,
    reflectionThresholdTokens: 1_000_000,
    compactionThresholdTokens: 1_000_000,
    compactionThresholdPercentage: null,
    maxSummaryTokens: 8_000,
  }, null, 2));

  const session = SessionManager.create(cwd, sessionDir);
  const sourceOneId = session.appendMessage({
    role: "user",
    content: "Controlled live source one: exact-duplicate-safe marker.",
    timestamp: Date.now(),
  });
  session.appendMessage(fauxAssistantMessage("Acknowledged source one."));
  const sourceTwoId = session.appendMessage({
    role: "user",
    content: "Controlled live source two: the same durable marker from a later source.",
    timestamp: Date.now(),
  });
  session.appendMessage(fauxAssistantMessage("Acknowledged source two."));

  const data: ObservationEntryData = {
    records: [
      observation(ACTIVE_OBSERVATION_ID, sourceOneId),
      observation(RETIRED_OBSERVATION_ID, sourceTwoId),
    ],
    coversFromId: sourceOneId,
    coversUpToId: sourceTwoId,
    tokenCount: 30,
  };
  session.appendCustomEntry(OBSERVATION_CUSTOM_TYPE, data);

  let finalCoveredId = sourceTwoId;
  for (let index = 0; index < 10; index++) {
    session.appendMessage({
      role: "user",
      content: `Compactable controlled trial turn ${index}: ${"x".repeat(800)}`,
      timestamp: Date.now(),
    });
    finalCoveredId = session.appendMessage(fauxAssistantMessage(`Trial response ${index}: ${"y".repeat(400)}`));
  }
  session.appendCustomEntry(OBSERVATION_CUSTOM_TYPE, {
    records: [],
    coversFromId: sourceOneId,
    coversUpToId: finalCoveredId,
    tokenCount: 0,
  } satisfies ObservationEntryData);

  return {
    cwd,
    sessionDir,
    sessionFile: session.getSessionFile()!,
    sourceEntryIds: [sourceOneId, sourceTwoId],
  };
};
