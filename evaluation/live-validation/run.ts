import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { ACTIVE_OBSERVATION_ID, RETIRED_OBSERVATION_ID, seedLiveFixture } from "./fixture.js";
import {
  installedBundle,
  launchPiRpc,
  liveResultRoot as resultRoot,
  prepareIsolatedPiConfig,
  repositoryBundle,
  sha256,
} from "./environment.js";
import { verifyPersistedLifecycle } from "./verify.js";

const main = async (): Promise<void> => {
  const execute = process.argv.includes("--execute");
  await mkdir(resultRoot, { recursive: true });
  if (resolve(repositoryBundle) === resolve(installedBundle)) throw new Error("Repository and installed bundles resolve to the same path.");
  const repositoryHash = await sha256(repositoryBundle);
  const installedHashBefore = await sha256(installedBundle);
  console.log(`Repository bundle: ${repositoryHash}`);
  console.log(`Installed bundle:  ${installedHashBefore}`);
  if (!execute) {
    console.log("Dry run only. Add --execute to create an isolated session and launch Pi RPC.");
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trialRoot = join(resultRoot, timestamp);
  await mkdir(trialRoot, { recursive: false });
  const configDir = await prepareIsolatedPiConfig();
  try {
    const fixture = await seedLiveFixture(trialRoot);
    const first = launchPiRpc({ ...fixture, extension: repositoryBundle, configDir });
    try {
      const commands = await first.request<{ commands: Array<{ name: string }> }>({ type: "get_commands" });
      const commandNames = new Set(commands.commands.map(command => command.name));
      for (const required of ["hm-status", "hm-memory", "hm-cache-info"]) {
        if (!commandNames.has(required)) throw new Error(`Extension command ${required} is not registered.`);
      }
      await first.request({ type: "compact", customInstructions: "Controlled deterministic live validation." }, 180_000);
      if (first.observedEvents().some(event => event.type === "extension_error")) {
        throw new Error("Extension emitted extension_error during compaction.");
      }
    } finally {
      await first.close();
    }

    const firstVerification = await verifyPersistedLifecycle(fixture.sessionFile);
    const hashAfterFirst = await sha256(fixture.sessionFile);

    const session = SessionManager.open(fixture.sessionFile, fixture.sessionDir, fixture.cwd);
    let finalCoveredId: string | undefined;
    for (let index = 0; index < 8; index++) {
      session.appendMessage({
        role: "user",
        content: `Idempotency trial turn ${index}: ${"z".repeat(700)}`,
        timestamp: Date.now(),
      });
      finalCoveredId = session.appendMessage(fauxAssistantMessage(`Idempotency response ${index}: ${"q".repeat(350)}`));
    }
    if (!finalCoveredId) throw new Error("Idempotency fixture failed to append a coverage boundary.");
    session.appendCustomEntry("hybrid-memory.observation", {
      records: [],
      coversFromId: finalCoveredId,
      coversUpToId: finalCoveredId,
      tokenCount: 0,
    });

    const second = launchPiRpc({ ...fixture, extension: repositoryBundle, configDir });
    try {
      await second.request({ type: "get_state" });
      const entries = await second.request<{ entries: unknown[] }>({ type: "get_entries" });
      if (entries.entries.length === 0) throw new Error("Restarted Pi returned no session entries.");
      await second.request({ type: "compact", customInstructions: "Controlled idempotency validation." }, 180_000);
      if (second.observedEvents().some(event => event.type === "extension_error")) {
        throw new Error("Extension emitted extension_error after restart.");
      }
    } finally {
      await second.close();
    }

    const secondVerification = await verifyPersistedLifecycle(fixture.sessionFile, 2);
    const hashAfterSecond = await sha256(fixture.sessionFile);

    const rollback = launchPiRpc({ ...fixture, extension: installedBundle, configDir });
    let rollbackWarningObserved = false;
    try {
      await rollback.request({ type: "get_state" });
      await rollback.request({ type: "get_entries" });
      await rollback.request({ type: "prompt", message: "/hm-status" });
      rollbackWarningObserved = rollback.observedEvents().some(event =>
        event.type === "extension_error"
        || JSON.stringify(event).includes("invalid-lifecycle-batch")
        || JSON.stringify(event).includes("rejected persisted batch"));
    } finally {
      await rollback.close();
    }
    const hashAfterRollback = await sha256(fixture.sessionFile);
    if (hashAfterRollback !== hashAfterSecond) throw new Error("Old-bundle rollback inspection mutated the session.");
    const installedHashAfter = await sha256(installedBundle);
    if (installedHashAfter !== installedHashBefore) throw new Error("Installed extension bundle changed during trial.");

    const report = {
      timestamp: new Date().toISOString(),
      repositoryBundle,
      repositoryHash,
      installedBundle,
      installedHashBefore,
      installedHashAfter,
      sessionFile: fixture.sessionFile,
      sessionHashAfterFirstCompaction: hashAfterFirst,
      sessionHashAfterSecondCompaction: hashAfterSecond,
      sessionHashAfterRollbackInspection: hashAfterRollback,
      activeObservationId: ACTIVE_OBSERVATION_ID,
      retiredObservationId: RETIRED_OBSERVATION_ID,
      firstVerification,
      secondVerification,
      rollbackWarningObserved,
      modelCallsExpected: 0,
    };
    await writeFile(join(trialRoot, "report.json"), JSON.stringify(report, null, 2));
    console.log(`PASS: ${join(trialRoot, "report.json")}`);
  } catch (error) {
    await writeFile(join(trialRoot, "failure.txt"), error instanceof Error ? error.stack ?? error.message : String(error));
    throw error;
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
};

await main();
