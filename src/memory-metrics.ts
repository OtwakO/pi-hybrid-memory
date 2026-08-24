import type { Entry, MemoryReflection, ObservationRecord } from "./types.js";
import { reflectionContent } from "./om/compaction.js";
import { estimateStringTokens } from "./om/tokens.js";

export interface MemoryStateLike {
  reflections: MemoryReflection[];
  committedObs: ObservationRecord[];
  pendingObs: ObservationRecord[];
}

export interface MemoryMetrics {
  reflectionCount: number;
  reflectionTokens: number;
  committedObservationCount: number;
  committedObservationTokens: number;
  pendingObservationCount: number;
  pendingObservationTokens: number;
  observationPoolTokens: number;
}

export interface ReflectionGateStatus {
  eligible: boolean;
  label: string;
}

export interface ContextSummaryStatus {
  tokens: number;
  label: string;
}

export interface MemoryPickerOption {
  label: string;
  detail: string;
  category: "observations" | "reflections" | "compactions" | "context";
}

export interface MemoryPickerInput {
  observations: ObservationRecord[];
  reflections: MemoryReflection[];
  compactionSummaries: string[];
  contextStatus: ContextSummaryStatus;
  reflectionGate: ReflectionGateStatus;
}

const contentTokens = (items: readonly { content: string }[]): number =>
  items.reduce((sum, item) => sum + estimateStringTokens(item.content), 0);

export const buildMemoryMetrics = (state: MemoryStateLike): MemoryMetrics => {
  const reflectionTokens = contentTokens(
    state.reflections.map(reflection => ({ content: reflectionContent(reflection) })),
  );
  const committedObservationTokens = contentTokens(state.committedObs);
  const pendingObservationTokens = contentTokens(state.pendingObs);

  return {
    reflectionCount: state.reflections.length,
    reflectionTokens,
    committedObservationCount: state.committedObs.length,
    committedObservationTokens,
    pendingObservationCount: state.pendingObs.length,
    pendingObservationTokens,
    observationPoolTokens: committedObservationTokens + pendingObservationTokens,
  };
};

export const describeReflectionGate = (
  metrics: MemoryMetrics,
  thresholdTokens: number,
): ReflectionGateStatus => {
  const progress = `~${metrics.observationPoolTokens.toLocaleString()} / ${thresholdTokens.toLocaleString()} tokens`;
  if (metrics.observationPoolTokens < thresholdTokens) {
    return { eligible: false, label: `not yet eligible (${progress})` };
  }
  return { eligible: true, label: `eligible at next compaction (${progress})` };
};

export const buildMemoryPickerOptions = (input: MemoryPickerInput): MemoryPickerOption[] => {
  const reflectionCount = `${input.reflections.length} ${input.reflections.length === 1 ? "entry" : "entries"}`;
  const reflectionTokens = `~${contentTokens(input.reflections.map(reflection => ({ content: reflectionContent(reflection) }))).toLocaleString()} tokens`;
  const reflectionDetail = input.reflections.length === 0
    ? `${reflectionCount} · ${reflectionTokens} · ${input.reflectionGate.label}`
    : `${reflectionCount} · ${reflectionTokens}`;

  return [
    {
      label: "Observations",
      detail: `${input.observations.length} entries · ~${contentTokens(input.observations).toLocaleString()} tokens`,
      category: "observations",
    },
    { label: "Reflections", detail: reflectionDetail, category: "reflections" },
    {
      label: "VCC Compactions",
      detail: `${input.compactionSummaries.length} entries · ~${contentTokens(input.compactionSummaries.map(content => ({ content }))).toLocaleString()} tokens`,
      category: "compactions",
    },
    { label: "Current Context Summary", detail: input.contextStatus.label, category: "context" },
  ];
};

export const describeContextSummary = (lastCompaction: Entry | undefined): ContextSummaryStatus => {
  if (!lastCompaction || typeof lastCompaction.summary !== "string" || !lastCompaction.summary.trim()) {
    return { tokens: 0, label: "no compaction yet" };
  }

  const tokens = estimateStringTokens(lastCompaction.summary);
  return { tokens, label: `~${tokens.toLocaleString()} tokens in context` };
};
