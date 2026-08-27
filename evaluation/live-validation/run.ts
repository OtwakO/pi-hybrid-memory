import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { ACTIVE_OBSERVATION_ID, RETIRED_OBSERVATION_ID, seedLiveFixture } from "./fixture.js";
import { PiRpcClient } from "./rpc-client.js";
import { verifyPersistedLifecycle } from "./verify.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryBundle = join(repoRoot, "dist/pi-hybrid-memory/index.js");
const installedBundle = join(homedir(), ".pi/agent/extensions/pi-hybrid-memory/index.js");
const resultRoot = join(repoRoot, "evaluation-results/live-validation");

const sha256 = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");
const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

const prepareIsolatedPiConfig = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pi-hybrid-memory-live-"));
  const sourceRoot = join(homedir(), ".pi/agent");
  for (const name of ["auth.json", "models.json"]) {
    const source = join(sourceRoot, name);
    if (await exists(source)) await copyFile(source, join(root, name));
  }
  return root;
};

const launch = (
  cwd: string,
  sessionDir: string,
  sessionFile: string,
  extension: string,
  configDir: string,
): PiRpcClient => new PiRpcClient("pi", [
  "--mode", "rpc",
  "--session", sessionFile,
  "--session-dir", sessionDir,
  "--provider", "opencode-go",
  "--model", "deepseek-v4-flash",
  "--no-extensions",
  "-e", extension,
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--approve",
  "--offline",
], {
  ...process.env,
  PI_CODING_AGENT_DIR: configDir,
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
}, cwd);

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
    const first = launch(fixture.cwd, fixture.sessionDir, fixture.sessionFile, repositoryBundle, configDir);
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

    const second = launch(fixture.cwd, fixture.sessionDir, fixture.sessionFile, repositoryBundle, configDir);
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

    const rollback = launch(fixture.cwd, fixture.sessionDir, fixture.sessionFile, installedBundle, configDir);
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
