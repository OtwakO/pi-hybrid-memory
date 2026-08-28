import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { MemoryDetailsV4, ObservationEntryData, ObservationRecord } from "../../src/types.js";
import { OBSERVATION_CUSTOM_TYPE } from "../../src/types.js";

export const MODEL_MARKER = "HM-LIVE-MODEL-7Q9X";
export const MODEL_PATH = "/srv/hybrid-memory/live-gate/config.json";
export const MODEL_VALUE = "41729";
export const BASELINE_OBSERVATION_ID = "livebase0001";

export interface ModelLiveFixture {
  cwd: string;
  sessionDir: string;
  sessionFile: string;
  durableSourceId: string;
}

export const seedModelLiveFixture = async (root: string): Promise<ModelLiveFixture> => {
  const cwd = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 2_000 },
  }, null, 2));
  await writeFile(join(cwd, ".pi", "pi-hybrid-memory-config.json"), JSON.stringify({
    overrideDefaultCompaction: true,
    observationThresholdTokens: 1,
    reflectionThresholdTokens: 1,
    compactionThresholdTokens: 1_000_000,
    compactionThresholdPercentage: null,
    compactionModel: { provider: "opencode-go", id: "deepseek-v4-flash" },
    maxSummaryTokens: 8_000,
  }, null, 2));

  const session = SessionManager.create(cwd, sessionDir);
  const baselineSourceId = session.appendMessage({
    role: "user",
    content: "Baseline: controlled model-assisted live validation is active.",
    timestamp: Date.now(),
  });
  session.appendMessage(fauxAssistantMessage("Baseline acknowledged."));
  const baseline: ObservationRecord = {
    id: BASELINE_OBSERVATION_ID,
    content: "Controlled model-assisted live validation is active.",
    timestamp: "2026-08-27T00:00:00.000Z",
    relevance: "high",
    sourceEntryIds: [baselineSourceId],
  };
  session.appendCustomEntry(OBSERVATION_CUSTOM_TYPE, {
    records: [baseline],
    coversFromId: baselineSourceId,
    coversUpToId: baselineSourceId,
    tokenCount: 12,
  } satisfies ObservationEntryData);
  session.appendCompaction(
    "Seeded historical baseline for controlled model-assisted validation.",
    baselineSourceId,
    12,
    {
      type: "observational-memory",
      version: 4,
      observations: [baseline],
      reflections: [],
    } satisfies MemoryDetailsV4,
    true,
  );

  const durableSourceId = session.appendMessage({
    role: "user",
    content: `Durable assertion: marker ${MODEL_MARKER}. The canonical path is ${MODEL_PATH}. The required numeric value is ${MODEL_VALUE}. Constraint: future changes must preserve all three exact values until the user explicitly revokes this requirement.`,
    timestamp: Date.now(),
  });
  session.appendMessage(fauxAssistantMessage(
    `Confirmed ${MODEL_MARKER}; preserve ${MODEL_PATH} and ${MODEL_VALUE} until explicit user revocation.`,
  ));
  for (let index = 0; index < 10; index++) {
    session.appendMessage({
      role: "user",
      content: `Model-assisted compactable context ${index}: ${"m".repeat(750)}`,
      timestamp: Date.now(),
    });
    session.appendMessage(fauxAssistantMessage(`Model-assisted response ${index}: ${"n".repeat(350)}`));
  }

  return { cwd, sessionDir, sessionFile: session.getSessionFile()!, durableSourceId };
};
