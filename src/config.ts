// Unified config loading: scaffolds extension config on first load, reads numeric thresholds from Pi settings
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionConfig, HybridSettings, UnifiedConfig } from "./types.js";

const EXTENSION_CONFIG_FILENAME = "pi-hybrid-memory-config.json";
const SETTINGS_KEY = "hybrid-memory";
const DEPRECATED_SETTINGS_KEY = "observational-memory";

export const DEFAULT_EXTENSION_CONFIG: ExtensionConfig = {
  overrideDefaultCompaction: true,
  debug: false,
};

export const DEFAULT_HYBRID_SETTINGS: HybridSettings = {
  observationThresholdTokens: 1000,
  compactionThresholdTokens: 50000,
  compactionThresholdPercentage: null,
  reflectionThresholdTokens: 30000,
  compactionModel: null,
  transcriptLines: 120,
  maxFiles: 40,
  maxCommits: 8,
  maxSummaryTokens: 16000,
};

const globalExtensionConfigPath = (): string => join(getAgentDirSafe(), EXTENSION_CONFIG_FILENAME);
const globalSettingsPath = (): string => join(getAgentDirSafe(), "settings.json");

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

function scaffoldExtensionConfig(path: string): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify(DEFAULT_EXTENSION_CONFIG, null, 2)}\n`);
    }
  } catch {
    // best-effort
  }
}

function loadExtensionConfig(cwd: string): ExtensionConfig {
  const globalPath = globalExtensionConfigPath();
  const projectPath = join(cwd, ".pi", EXTENSION_CONFIG_FILENAME);

  // Scaffold global config if absent
  scaffoldExtensionConfig(globalPath);

  const project = readJson(projectPath);
  if (project && typeof project === "object") {
    return { ...DEFAULT_EXTENSION_CONFIG, ...(project as Partial<ExtensionConfig>) };
  }

  const global_ = readJson(globalPath);
  if (global_ && typeof global_ === "object") {
    return { ...DEFAULT_EXTENSION_CONFIG, ...(global_ as Partial<ExtensionConfig>) };
  }

  return { ...DEFAULT_EXTENSION_CONFIG };
}

export const validCompactionThresholdPercentage = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value < 100
    ? value
    : null;

function loadHybridSettings(cwd: string): HybridSettings {
  const globalPath = globalSettingsPath();
  const projectPath = join(cwd, ".pi", "settings.json");

  // Read project settings first (higher priority), then global
  const project = readJson(projectPath);
  const global_ = readJson(globalPath);

  // Merge: defaults < global < project
  let merged = { ...DEFAULT_HYBRID_SETTINGS };

  if (global_ && typeof global_ === "object") {
    const hybridGlobal = (global_ as Record<string, unknown>)[SETTINGS_KEY];
    if (hybridGlobal && typeof hybridGlobal === "object" && hybridGlobal !== null) {
      merged = { ...merged, ...(hybridGlobal as Partial<HybridSettings>) };
    }
  }

  if (project && typeof project === "object") {
    const hybridProject = (project as Record<string, unknown>)[SETTINGS_KEY];
    if (hybridProject && typeof hybridProject === "object" && hybridProject !== null) {
      merged = { ...merged, ...(hybridProject as Partial<HybridSettings>) };
    }
  }

  // Backward compat: read observational-memory.* as fallback
  for (const [fallbackKey, targetKey] of [
    ["observationThresholdTokens", "observationThresholdTokens"],
    ["compactionThresholdTokens", "compactionThresholdTokens"],
    ["reflectionThresholdTokens", "reflectionThresholdTokens"],
    ["compactionModel", "compactionModel"],
  ] as const) {
    if (merged[targetKey] === DEFAULT_HYBRID_SETTINGS[targetKey] || merged[targetKey] === null) {
      // Check deprecated key in both global and project
      for (const settings of [global_, project]) {
        if (!settings || typeof settings !== "object") continue;
        const deprecated = (settings as Record<string, unknown>)[DEPRECATED_SETTINGS_KEY];
        if (deprecated && typeof deprecated === "object" && deprecated !== null) {
          const val = (deprecated as Record<string, unknown>)[fallbackKey];
          if (val !== undefined) {
            (merged as Record<string, unknown>)[targetKey] = val;
          }
        }
      }
    }
  }

  merged.compactionThresholdPercentage = validCompactionThresholdPercentage(
    merged.compactionThresholdPercentage,
  );

  return merged;
}

export function loadConfig(cwd: string, notify?: (msg: string, level?: "info" | "warning" | "error") => void): UnifiedConfig {
  const extension = loadExtensionConfig(cwd);
  const hybrid = loadHybridSettings(cwd);

  if (notify) {
    if (!extension.overrideDefaultCompaction) {
      notify(
        "pi-hybrid-memory: override is disabled. Pi's default compaction will run. Set overrideDefaultCompaction: true in pi-hybrid-memory-config.json to enable.",
        "info",
      );
    } else {
      if (!hybrid.compactionModel) {
        notify(
          "pi-hybrid-memory: observer is using your session model. Set hybrid-memory.compactionModel in settings.json to a cheaper model to reduce cost.",
          "info",
        );
      }
    }
  }

  return { extension, hybrid };
}
