// Unified type definitions for pi-hybrid-memory — reconciles both pi-vcc and pi-observational-memory types
import type { Message } from "@mariozechner/pi-ai";

// ── VCC types ──

export type NormalizedBlock =
  | { kind: "user"; text: string; sourceIndex?: number }
  | { kind: "assistant"; text: string; sourceIndex?: number }
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number }
  | { kind: "tool_result"; name: string; text: string; isError: boolean; sourceIndex?: number }
  | { kind: "thinking"; text: string; redacted: boolean; sourceIndex?: number };

export interface SectionData {
  sessionGoal: string[];
  filesAndChanges: string[];
  commits: string[];
  outstandingContext: string[];
  userPreferences: string[];
  briefTranscript: string;
  transcriptEntries: TranscriptEntry[];
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "tool_error";
  text?: string;
  tool?: string;
  cmd?: string;
  ref?: string;
  count?: number;
}

export interface FileOps {
  readFiles?: string[];
  modifiedFiles?: string[];
  createdFiles?: string[];
}

// ── OM types ──

export const OBSERVATION_CUSTOM_TYPE = "hybrid-memory.observation";

export type Relevance = "low" | "medium" | "high" | "critical";
export const RELEVANCE_VALUES: readonly Relevance[] = ["low", "medium", "high", "critical"] as const;
export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

export interface ObservationRecord {
  id: string;
  content: string;
  timestamp: string;
  relevance: Relevance;
  sourceEntryIds?: string[];
}

export type LegacyReflection = string;

export interface ReflectionRecord {
  id: string;
  content: string;
  supportingObservationIds: string[];
  legacy?: boolean;
}

export type MemoryReflection = LegacyReflection | ReflectionRecord;

export type Reflection = LegacyReflection;

export interface MemoryDetailsV4 {
  type: "observational-memory";
  version: 4;
  observations: ObservationRecord[];
  reflections: MemoryReflection[];
}

export interface ObservationEntryData {
  records: ObservationRecord[];
  coversFromId: string;
  coversUpToId: string;
  tokenCount: number;
}

// ── Branch Entry type (matches pi session entries) ──

export interface Entry {
  type: string;
  id: string;
  timestamp?: string;
  message?: unknown;
  content?: unknown;
  customType?: string;
  summary?: unknown;
  fromId?: string;
  data?: unknown;
  details?: unknown;
  firstKeptEntryId?: string;
}

export type SupportedMemoryDetails = MemoryDetailsV4;

// ── Type guards ──

export const isObservationEntryData = (v: unknown): v is ObservationEntryData =>
  !!v && typeof v === "object" && "records" in v && Array.isArray((v as ObservationEntryData).records);

export const isReflectionRecord = (v: unknown): v is ReflectionRecord =>
  !!v && typeof v === "object" && "content" in v && "supportingObservationIds" in v && !Array.isArray(v);

export const isSupportedMemoryDetails = (v: unknown): v is SupportedMemoryDetails =>
  !!v && typeof v === "object" && "type" in v && (v as Record<string, unknown>).type === "observational-memory" && "version" in v && typeof (v as Record<string, unknown>).version === "number" && ((v as Record<string, unknown>).version as number) >= 3;

// ── Config types ──

export interface ExtensionConfig {
  overrideDefaultCompaction: boolean;
  debug: boolean;
}

export interface HybridSettings {
  observationThresholdTokens: number;
  compactionThresholdTokens: number;
  reflectionThresholdTokens: number;
  compactionModel: { provider: string; id: string } | null;
  transcriptLines: number;
  maxFiles: number;
  maxCommits: number;
  maxSummaryTokens: number;
}

export interface UnifiedConfig {
  extension: ExtensionConfig;
  hybrid: HybridSettings;
}

// ── Merge types ──

export interface BudgetUnit {
  priority: number;  // lower = drop first
  label: string;
  tokens: number;
  content: string;
}

export interface MergedSummaryResult {
  summary: string;
  details: MemoryDetailsV4;
  trimmed: boolean;
  tokenCount: number;
}

// ── Runtime ──

export type ResolveResult =
  | { ok: true; model: unknown; apiKey: string; headers?: Record<string, string> }
  | { ok: false; reason: string };

export interface CompactionHookEvent {
  preparation: {
    previousSummary?: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
  };
  branchEntries: unknown[];
  signal?: AbortSignal;
  customInstructions?: string;
}

export interface CompactionHookCtx {
  cwd: string;
  hasUI: boolean;
  ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
  sessionManager: {
    getBranch: () => unknown[];
    getLeafId: () => string | undefined;
    getSessionFile: () => string | undefined;
  };
  model: unknown;
  modelRegistry: {
    find: (provider: string, id: string) => unknown | undefined;
    getApiKeyAndHeaders: (model: unknown) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
  };
}
