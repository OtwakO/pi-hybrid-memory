// Merge pipeline: combines OM semantic memory and VCC structural state under a priority-based growth ceiling.
import type {
  MemoryReflection,
  ObservationRecord,
} from "../types.js";
import { VCC_SUMMARY_HEADER } from "../vcc/summary.js";
import { applySummaryBudget } from "./budget.js";

export interface MergeInput {
  observations: ObservationRecord[];
  reflections: MemoryReflection[];
  vccSummary: string;
  settings: {
    maxSummaryTokens: number;
  };
}

export interface MergeOutput {
  summary: string;
  trimmed: boolean;
  protectedOverflow: boolean;
  tokenCount: number;
}

const MEMORY_HEADER =
  "## Memory (Observations & Reflections)\n" +
  "The following is compressed semantic memory from prior conversation. " +
  "Use `hm_recall` to recover supporting evidence and exact source entries when needed.\n\n";


export const mergePipelines = (input: MergeInput): MergeOutput => {
  const budgeted = applySummaryBudget({
    observations: input.observations,
    reflections: input.reflections,
    vccSummary: input.vccSummary,
    maxTokens: input.settings.maxSummaryTokens,
    memoryHeader: MEMORY_HEADER,
    vccHeader: VCC_SUMMARY_HEADER,
  });

  return {
    summary: budgeted.summary,
    trimmed: budgeted.trimmed,
    protectedOverflow: budgeted.protectedOverflow,
    tokenCount: budgeted.tokenCount,
  };
};
