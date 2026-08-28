import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  installedBundle,
  launchPiRpc,
  liveResultRoot,
  prepareIsolatedPiConfig,
  repositoryBundle,
  sha256,
} from "./environment.js";
import { MODEL_MARKER, MODEL_PATH, MODEL_VALUE, seedModelLiveFixture } from "./model-fixture.js";
import {
  verifyIncrementalReflectionBeforeCompaction,
  verifyModelAssistedCompaction,
} from "./model-verify.js";
import { MEMORY_LIFECYCLE_CUSTOM_TYPE, readMemoryDetails } from "../../src/types.js";
import { readSessionEntries } from "./verify.js";

const eventText = (event: unknown): string => JSON.stringify(event);

const waitForIncrementalLifecycle = async (
  sessionFile: string,
  timeoutMs = 300_000,
): Promise<void> => {
  const started = Date.now();
  let latestEntryCount = 0;
  while (Date.now() - started < timeoutMs) {
    const entries = await readSessionEntries(sessionFile);
    latestEntryCount = entries.length;
    const exists = entries.some(entry =>
      entry.type === "custom"
      && entry.customType === MEMORY_LIFECYCLE_CUSTOM_TYPE
      && readMemoryDetails(entry.data)?.version === 6);
    if (exists) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for incremental V6 lifecycle persistence after ${timeoutMs}ms; latest entry count ${latestEntryCount}.`,
  );
};

const main = async (): Promise<void> => {
  const execute = process.argv.includes("--execute");
  await mkdir(liveResultRoot, { recursive: true });
  if (resolve(repositoryBundle) === resolve(installedBundle)) throw new Error("Repository and installed bundles resolve to the same path.");
  const repositoryHash = await sha256(repositoryBundle);
  const installedHashBefore = await sha256(installedBundle);
  console.log(`Repository bundle: ${repositoryHash}`);
  console.log(`Installed bundle:  ${installedHashBefore}`);
  console.log("Model-assisted operations: one proactive observer turn, one incremental reflector window, covered compaction, and recall agent turn. Exact provider-call count is not observable through Pi RPC.");
  if (!execute) {
    console.log("Dry run only. Add --execute to run the isolated model-assisted gate.");
    return;
  }

  const timestamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-model`;
  const trialRoot = join(liveResultRoot, timestamp);
  await mkdir(trialRoot, { recursive: false });
  const configDir = await prepareIsolatedPiConfig();
  try {
    const fixture = await seedModelLiveFixture(trialRoot);
    const first = launchPiRpc({ ...fixture, extension: repositoryBundle, configDir });
    let incrementalVerification;
    try {
      await first.request({
        type: "prompt",
        message: "Acknowledge the controlled validation assertion in one short sentence without changing it.",
      });
      await first.waitForEvent(event => event.type === "agent_settled", 300_000);
      await waitForIncrementalLifecycle(fixture.sessionFile);
      incrementalVerification = await verifyIncrementalReflectionBeforeCompaction(
        fixture.sessionFile,
        fixture.durableSourceId,
      );
      await first.request({ type: "compact", customInstructions: "Preserve exact durable decisions and constraints." }, 300_000);
      if (first.observedEvents().some(event => event.type === "extension_error")) {
        throw new Error("Extension emitted extension_error during model-assisted incremental reflection or compaction.");
      }
    } finally {
      await first.close();
    }

    const verification = await verifyModelAssistedCompaction(
      fixture.sessionFile,
      incrementalVerification!,
    );
    const sessionHashAfterCompaction = await sha256(fixture.sessionFile);

    const second = launchPiRpc({ ...fixture, extension: repositoryBundle, configDir });
    try {
      await second.request({
        type: "prompt",
        message: `You must call hm_recall with id ${verification.observationId}. Then report only the exact marker, path, numeric value, and whether the constraint remains active. Do not answer from the prompt alone.`,
      });
      await second.waitForEvent(event => event.type === "agent_settled", 300_000);
      const recallEvents = second.observedEvents().filter(event =>
        event.type === "tool_execution_end" && event.toolName === "hm_recall");
      if (recallEvents.length !== 1) throw new Error(`Expected one hm_recall tool execution; received ${recallEvents.length}.`);
      const recallText = eventText(recallEvents[0]);
      for (const exact of [MODEL_MARKER, MODEL_PATH, MODEL_VALUE]) {
        if (!recallText.includes(exact)) throw new Error(`hm_recall result omitted ${exact}.`);
      }
      if (!recallText.includes(fixture.durableSourceId)) throw new Error("hm_recall result omitted source provenance.");
      if (second.observedEvents().some(event => event.type === "extension_error")) {
        throw new Error("Extension emitted extension_error during recall turn.");
      }
    } finally {
      await second.close();
    }

    const installedHashAfter = await sha256(installedBundle);
    if (installedHashAfter !== installedHashBefore) throw new Error("Installed extension bundle changed during model-assisted trial.");
    const report = {
      timestamp: new Date().toISOString(),
      repositoryHash,
      installedHashBefore,
      installedHashAfter,
      sessionFile: fixture.sessionFile,
      sessionHashAfterCompaction,
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      modelAssistedOperations: [
        "proactive-observer-turn",
        "incremental-reflector-window",
        "covered-compaction",
        "recall-agent-turn",
      ],
      exactProviderCallCount: "not observable through Pi RPC",
      verification,
      exactFixture: { marker: MODEL_MARKER, path: MODEL_PATH, value: MODEL_VALUE },
    };
    await writeFile(join(trialRoot, "report-model.json"), JSON.stringify(report, null, 2));
    console.log(`PASS: ${join(trialRoot, "report-model.json")}`);
  } catch (error) {
    await writeFile(join(trialRoot, "failure-model.txt"), error instanceof Error ? error.stack ?? error.message : String(error));
    throw error;
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
};

await main();
