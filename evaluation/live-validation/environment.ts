import { copyFile, mkdtemp, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PiRpcClient } from "./rpc-client.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const repositoryBundle = join(repoRoot, "dist/pi-hybrid-memory/index.js");
export const installedBundle = join(homedir(), ".pi/agent/extensions/pi-hybrid-memory/index.js");
export const liveResultRoot = join(repoRoot, "evaluation-results/live-validation");

export const sha256 = async (path: string): Promise<string> =>
  createHash("sha256").update(await readFile(path)).digest("hex");

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

export const prepareIsolatedPiConfig = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pi-hybrid-memory-live-"));
  const sourceRoot = join(homedir(), ".pi/agent");
  for (const name of ["auth.json", "models.json"]) {
    const source = join(sourceRoot, name);
    if (await exists(source)) await copyFile(source, join(root, name));
  }
  return root;
};

export const launchPiRpc = (input: {
  cwd: string;
  sessionDir: string;
  sessionFile: string;
  extension: string;
  configDir: string;
}): PiRpcClient => new PiRpcClient("pi", [
  "--mode", "rpc",
  "--session", input.sessionFile,
  "--session-dir", input.sessionDir,
  "--provider", "opencode-go",
  "--model", "deepseek-v4-flash",
  "--no-extensions",
  "-e", input.extension,
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--approve",
  "--offline",
], {
  ...process.env,
  PI_CODING_AGENT_DIR: input.configDir,
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
}, input.cwd);
