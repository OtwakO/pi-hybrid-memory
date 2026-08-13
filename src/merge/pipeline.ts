// Merge pipeline: the fresh innovation — merges OM semantic memory + VCC structural summary into one unified compaction summary
import type {
  MemoryDetailsV4,
  MemoryReflection,
  ObservationRecord,
} from "../types.js";
import { estimateStringTokens } from "../om/tokens.js";
import { renderSummary } from "../om/compaction.js";

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
  tokenCount: number;
}

const MEMORY_HEADER =
  "## Memory (Observations & Reflections)\n" +
  "The following is compressed semantic memory from prior conversation. " +
  "Use `hm_recall` or `vcc_recall` to search session history for full context.\n\n";

const VCC_HEADER =
  "## Session State (Structural Summary)\n" +
  "The following is a structural summary of what happened in this session. " +
  "Use `vcc_recall` to search prior transcripts.\n\n";

export const mergePipelines = (input: MergeInput): MergeOutput => {
  const { observations, reflections, vccSummary, settings } = input;
  const maxTokens = settings.maxSummaryTokens;

  // Build OM summary
  const omSummary = renderSummary(reflections, observations);
  const omHeaderTokenEstimate = estimateStringTokens(MEMORY_HEADER);
  const omTokens = omHeaderTokenEstimate + estimateStringTokens(omSummary);

  // Build VCC section
  const vccHeaderTokenEstimate = estimateStringTokens(VCC_HEADER);
  const vccTokens = vccHeaderTokenEstimate + estimateStringTokens(vccSummary);

  const totalTokens = omTokens + vccTokens;

  let finalOmSummary = omSummary;
  let trimmed = false;
  let keptObservations = observations;

  // If over budget, trim observations by relevance (low → critical)
  if (totalTokens > maxTokens) {
    const sorted = [...observations].sort((a, b) => {
      const order = { low: 0, medium: 1, high: 2, critical: 3 };
      return order[a.relevance] - order[b.relevance];
    });
    let currentTokens = omTokens + vccTokens;
    const toDrop: string[] = [];
    for (const obs of sorted) {
      if (currentTokens <= maxTokens) break;
      toDrop.push(obs.id);
      // Use exact format that renderSummary/observationsToPromptLines produces:
      // [id] timestamp [relevance] content  (no leading dash, includes timestamp)
      currentTokens -= estimateStringTokens(`[${obs.id}] ${obs.timestamp} [${obs.relevance}] ${obs.content}`);
    }
    if (toDrop.length > 0) {
      keptObservations = observations.filter((o) => !toDrop.includes(o.id));
      finalOmSummary = renderSummary(reflections, keptObservations);
      trimmed = true;
    }
  }

  // Compose final summary
  const parts: string[] = [];
  if (finalOmSummary) parts.push(MEMORY_HEADER + finalOmSummary);
  if (vccSummary) parts.push(VCC_HEADER + vccSummary);

  const summary = parts.join("\n\n---\n\n");
  const tokenCount = estimateStringTokens(summary);

  return {
    summary,
    details: {
      type: "observational-memory",
      version: 4,
      observations: keptObservations,
      reflections,
    },
    trimmed,
    tokenCount,
  };
};
