// Merge pipeline: combines OM semantic memory and VCC structural state under a priority-based growth ceiling.
import type {
  MemoryDetailsV4,
  MemoryReflection,
  ObservationRecord,
} from "../types.js";
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
  details: MemoryDetailsV4;
  trimmed: boolean;
  protectedOverflow: boolean;
  tokenCount: number;
}

const MEMORY_HEADER =
  "## Memory (Observations & Reflections)\n" +
  "The following is compressed semantic memory from prior conversation. " +
  "Use `hm_recall` to recover supporting evidence and exact source entries when needed.\n\n";

const VCC_HEADER =
  "## Session State (Structural Summary)\n" +
  "The following is a structural summary of what happened in this session.\n\n";

export const mergePipelines = (input: MergeInput): MergeOutput => {
  const budgeted = applySummaryBudget({
    observations: input.observations,
    reflections: input.reflections,
    vccSummary: input.vccSummary,
    maxTokens: input.settings.maxSummaryTokens,
    memoryHeader: MEMORY_HEADER,
    vccHeader: VCC_HEADER,
  });

  return {
    summary: budgeted.summary,
    details: {
      type: "observational-memory",
      version: 4,
      observations: [...input.observations],
      reflections: input.reflections,
    },
    trimmed: budgeted.trimmed,
    protectedOverflow: budgeted.protectedOverflow,
    tokenCount: budgeted.tokenCount,
  };
};
