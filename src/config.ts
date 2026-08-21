// Unified config loading from pi-hybrid-memory-config.json.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionConfig, HybridSettings, UnifiedConfig } from "./types.js";

const EXTENSION_CONFIG_FILENAME = "pi-hybrid-memory-config.json";

export const DEFAULT_EXTENSION_CONFIG: ExtensionConfig = {
  overrideDefaultCompaction: true,
  debug: false,
};

export const DEFAULT_HYBRID_SETTINGS: HybridSettings = {
  observationThresholdTokens: 1000,
  observerChunkMaxTokens: 60000,
  observerEpochMaxTokens: 96000,
  compactionThresholdTokens: 50000,
  compactionThresholdPercentage: 80,
  reflectionThresholdTokens: 30000,
  compactionModel: null,
  transcriptLines: 120,
  maxFiles: 40,
  maxCommits: 8,
  maxSummaryTokens: 16000,
};

export type ConfigFile = ExtensionConfig & HybridSettings;

export const DEFAULT_CONFIG_FILE: ConfigFile = {
  ...DEFAULT_EXTENSION_CONFIG,
  ...DEFAULT_HYBRID_SETTINGS,
};

const globalExtensionConfigPath = (): string => join(getAgentDirSafe(), EXTENSION_CONFIG_FILENAME);

function getAgentDirSafe(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAgentDir } = require("@mariozechner/pi-coding-agent");
    return getAgentDir();
  } catch {
    return join(homedir(), ".pi", "agent");
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(path: string, value: Record<string, unknown>): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  } catch {
    // Best-effort scaffolding. Runtime defaults remain usable if disk writes fail.
  }
}

export const validCompactionThresholdPercentage = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value < 100
    ? value
    : null;

const normalizeConfig = (value: ConfigFile): ConfigFile => ({
  ...value,
  observerChunkMaxTokens:
    typeof value.observerChunkMaxTokens === "number" && Number.isFinite(value.observerChunkMaxTokens)
      ? Math.max(256, Math.floor(value.observerChunkMaxTokens))
      : DEFAULT_HYBRID_SETTINGS.observerChunkMaxTokens,
  observerEpochMaxTokens:
    typeof value.observerEpochMaxTokens === "number" && Number.isFinite(value.observerEpochMaxTokens)
      ? Math.max(4096, Math.floor(value.observerEpochMaxTokens))
      : DEFAULT_HYBRID_SETTINGS.observerEpochMaxTokens,
  compactionThresholdPercentage: validCompactionThresholdPercentage(
    value.compactionThresholdPercentage,
  ),
});

interface ConfigPaths {
  globalConfigPath: string;
  projectConfigPath: string;
}

export function loadConfigFromPaths(
  paths: ConfigPaths,
  notify?: (msg: string, level?: "info" | "warning" | "error") => void,
): UnifiedConfig {
  const globalExisting = readJson(paths.globalConfigPath) ?? {};
  const globalConfig = normalizeConfig({
    ...DEFAULT_CONFIG_FILE,
    ...globalExisting,
  } as ConfigFile);

  // Keep the global file complete so it is the single discoverable config surface.
  writeJson(paths.globalConfigPath, globalConfig as unknown as Record<string, unknown>);

  const projectExisting = readJson(paths.projectConfigPath) ?? {};
  const merged = normalizeConfig({
    ...globalConfig,
    ...projectExisting,
  } as ConfigFile);

  if (notify) {
    if (!merged.overrideDefaultCompaction) {
      notify(
        "pi-hybrid-memory: override is disabled. Pi's default compaction will run. Set overrideDefaultCompaction: true in pi-hybrid-memory-config.json to enable.",
        "info",
      );
    } else if (!merged.compactionModel) {
      notify(
        "pi-hybrid-memory: observer is using your session model. Set compactionModel in pi-hybrid-memory-config.json to a cheaper model to reduce cost.",
        "info",
      );
    }
  }

  const extension: ExtensionConfig = {
    overrideDefaultCompaction: merged.overrideDefaultCompaction,
    debug: merged.debug,
  };
  const hybrid: HybridSettings = {
    observationThresholdTokens: merged.observationThresholdTokens,
    observerChunkMaxTokens: merged.observerChunkMaxTokens,
    observerEpochMaxTokens: merged.observerEpochMaxTokens,
    compactionThresholdTokens: merged.compactionThresholdTokens,
    compactionThresholdPercentage: merged.compactionThresholdPercentage,
    reflectionThresholdTokens: merged.reflectionThresholdTokens,
    compactionModel: merged.compactionModel,
    transcriptLines: merged.transcriptLines,
    maxFiles: merged.maxFiles,
    maxCommits: merged.maxCommits,
    maxSummaryTokens: merged.maxSummaryTokens,
  };

  return { extension, hybrid };
}

export function loadConfig(
  cwd: string,
  notify?: (msg: string, level?: "info" | "warning" | "error") => void,
): UnifiedConfig {
  return loadConfigFromPaths({
    globalConfigPath: globalExtensionConfigPath(),
    projectConfigPath: join(cwd, ".pi", EXTENSION_CONFIG_FILENAME),
  }, notify);
}
