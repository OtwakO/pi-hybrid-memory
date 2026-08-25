// Unified configuration for pi-hybrid-memory.
// Global defaults live in ~/.pi/agent/pi-hybrid-memory-config.json; trusted projects may override
// individual fields in <cwd>/<CONFIG_DIR_NAME>/pi-hybrid-memory-config.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionConfig, HybridSettings, UnifiedConfig } from "./types.js";

const EXTENSION_CONFIG_FILENAME = "pi-hybrid-memory-config.json";

type Notify = (message: string, level?: "info" | "warning" | "error") => void;

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

const PositiveInteger = (minimum = 1) => Type.Integer({ minimum });
const NonBlankString = Type.String({ minLength: 1, pattern: "\\S" });
const CompactionModelSchema = Type.Union([
  Type.Null(),
  Type.Object({
    provider: NonBlankString,
    id: NonBlankString,
  }, { additionalProperties: false }),
]);

export const CONFIG_FILE_SCHEMA = Type.Object({
  overrideDefaultCompaction: Type.Boolean(),
  debug: Type.Boolean(),
  observationThresholdTokens: PositiveInteger(),
  observerChunkMaxTokens: PositiveInteger(256),
  observerEpochMaxTokens: PositiveInteger(4096),
  compactionThresholdTokens: PositiveInteger(),
  compactionThresholdPercentage: Type.Union([
    Type.Null(),
    Type.Integer({ minimum: 1, maximum: 99 }),
  ]),
  reflectionThresholdTokens: PositiveInteger(),
  compactionModel: CompactionModelSchema,
  transcriptLines: PositiveInteger(),
  maxFiles: PositiveInteger(),
  maxCommits: PositiveInteger(),
  maxSummaryTokens: PositiveInteger(),
}, { additionalProperties: true });

const CONFIG_FIELDS = Object.keys(DEFAULT_CONFIG_FILE) as Array<keyof ConfigFile>;
const CONFIG_FIELD_SCHEMAS = CONFIG_FILE_SCHEMA.properties as Record<keyof ConfigFile, TSchema>;

export const validCompactionThresholdPercentage = (value: unknown): number | null =>
  Check(CONFIG_FIELD_SCHEMAS.compactionThresholdPercentage, value) && value !== null
    ? value as number
    : null;

const globalExtensionConfigPath = (): string => join(getAgentDir(), EXTENSION_CONFIG_FILENAME);

interface ConfigPaths {
  globalConfigPath: string;
  projectConfigPath: string;
}

interface LoadConfigOptions {
  projectTrusted: boolean;
  notify?: Notify;
}

type ConfigScope = "global" | "project";
type ReadResult =
  | { status: "missing" }
  | { status: "valid"; value: Record<string, unknown> }
  | { status: "invalid" };

const describeReadError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function readConfigObject(path: string, scope: ConfigScope, notify?: Notify): ReadResult {
  if (!existsSync(path)) return { status: "missing" };

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    notify?.(
      `pi-hybrid-memory: could not read ${scope} configuration at ${path}: ${describeReadError(error)}. The file was left unchanged and this scope was ignored.`,
      "error",
    );
    return { status: "invalid" };
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top-level JSON value must be an object");
    }
    return { status: "valid", value: parsed as Record<string, unknown> };
  } catch (error) {
    notify?.(
      `pi-hybrid-memory: could not parse ${scope} configuration at ${path}: ${describeReadError(error)}. The file was left unchanged and this scope was ignored.`,
      "error",
    );
    return { status: "invalid" };
  }
}

function acceptedConfigFields(
  value: Record<string, unknown>,
  scope: ConfigScope,
  notify?: Notify,
): { values: Partial<ConfigFile>; valid: boolean } {
  const values: Partial<ConfigFile> = {};
  let valid = true;

  for (const field of CONFIG_FIELDS) {
    if (!(field in value)) continue;
    const candidate = value[field];
    const schema = CONFIG_FIELD_SCHEMAS[field];

    if (!Check(schema, candidate)) {
      valid = false;
      notify?.(
        `pi-hybrid-memory: invalid ${scope} setting ${field}; using the lower-precedence value.`,
        "error",
      );
      continue;
    }
    values[field] = candidate as never;
  }

  return { values, valid };
}

function writeGlobalConfig(path: string, value: Record<string, unknown>, notify?: Notify): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    notify?.(
      `pi-hybrid-memory: could not write global configuration at ${path}: ${describeReadError(error)}. Runtime defaults remain active.`,
      "warning",
    );
  }
}

const toUnifiedConfig = (config: ConfigFile): UnifiedConfig => ({
  extension: {
    overrideDefaultCompaction: config.overrideDefaultCompaction,
    debug: config.debug,
  },
  hybrid: {
    observationThresholdTokens: config.observationThresholdTokens,
    observerChunkMaxTokens: config.observerChunkMaxTokens,
    observerEpochMaxTokens: config.observerEpochMaxTokens,
    compactionThresholdTokens: config.compactionThresholdTokens,
    compactionThresholdPercentage: config.compactionThresholdPercentage,
    reflectionThresholdTokens: config.reflectionThresholdTokens,
    compactionModel: config.compactionModel,
    transcriptLines: config.transcriptLines,
    maxFiles: config.maxFiles,
    maxCommits: config.maxCommits,
    maxSummaryTokens: config.maxSummaryTokens,
  },
});

export function loadConfigFromPaths(paths: ConfigPaths, options: LoadConfigOptions): UnifiedConfig {
  const { notify, projectTrusted } = options;
  const globalRead = readConfigObject(paths.globalConfigPath, "global", notify);
  let globalConfig = { ...DEFAULT_CONFIG_FILE };

  if (globalRead.status === "missing") {
    writeGlobalConfig(paths.globalConfigPath, globalConfig, notify);
  } else if (globalRead.status === "valid") {
    const accepted = acceptedConfigFields(globalRead.value, "global", notify);
    globalConfig = { ...globalConfig, ...accepted.values };
    if (accepted.valid) {
      writeGlobalConfig(paths.globalConfigPath, {
        ...globalRead.value,
        ...globalConfig,
      }, notify);
    }
  }

  let merged = globalConfig;
  if (!projectTrusted) {
    if (existsSync(paths.projectConfigPath)) {
      notify?.(
        "pi-hybrid-memory: ignored project configuration because the project is not trusted.",
        "warning",
      );
    }
  } else {
    const projectRead = readConfigObject(paths.projectConfigPath, "project", notify);
    if (projectRead.status === "valid") {
      merged = {
        ...merged,
        ...acceptedConfigFields(projectRead.value, "project", notify).values,
      };
    }
  }

  if (!merged.overrideDefaultCompaction) {
    notify?.(
      "pi-hybrid-memory: override is disabled. Pi's default compaction will run. Set overrideDefaultCompaction: true in pi-hybrid-memory-config.json to enable.",
      "info",
    );
  } else if (!merged.compactionModel) {
    notify?.(
      "pi-hybrid-memory: observer is using your session model. Set compactionModel in pi-hybrid-memory-config.json to a cheaper model to reduce cost.",
      "info",
    );
  }

  return toUnifiedConfig(merged);
}

export function loadConfig(
  cwd: string,
  projectTrusted: boolean,
  notify?: Notify,
): UnifiedConfig {
  return loadConfigFromPaths({
    globalConfigPath: globalExtensionConfigPath(),
    projectConfigPath: join(cwd, CONFIG_DIR_NAME, EXTENSION_CONFIG_FILENAME),
  }, { projectTrusted, notify });
}
