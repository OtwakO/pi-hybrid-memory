import type { MemoryReflection, ObservationRecord, Relevance } from "../types.js";
import { reflectionContent } from "./compaction.js";
import { observationsToPromptLines } from "./observer.js";
import { estimateStringTokens } from "./tokens.js";

export interface ObserverContextBudgets {
  reflectionTokens: number;
  protectedObservationTokens: number;
  recentObservationTokens: number;
  sourceRelatedObservationTokens: number;
}

export interface ObserverContextPlanInput {
  reflections: readonly MemoryReflection[];
  observations: readonly ObservationRecord[];
  sourceText: string;
  budgets: ObserverContextBudgets;
}

export interface ObserverContextPlan {
  stableBaselineText: string;
  sourceRelatedText: string;
  selectedReflections: MemoryReflection[];
  stableObservations: ObservationRecord[];
  sourceRelatedObservations: ObservationRecord[];
  tokens: {
    reflections: number;
    protectedObservations: number;
    recentObservations: number;
    sourceRelatedObservations: number;
    stableBaseline: number;
    sourceRelated: number;
  };
  omitted: {
    reflections: number;
    protectedObservations: number;
    observations: number;
  };
  protectedOverflow: boolean;
}

const relevanceRank: Record<Relevance, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const normalizedBudget = (value: number): number => Math.max(0, Math.floor(value));

const reflectionLines = (reflections: readonly MemoryReflection[]): string[] =>
  reflections.map(reflection => reflectionContent(reflection));

const observationLines = (observations: readonly ObservationRecord[]): string[] =>
  observationsToPromptLines([...observations]);

const section = (heading: string, lines: readonly string[]): string =>
  `${heading}:\n${lines.length > 0 ? lines.join("\n") : "(none selected)"}`;

const fitItems = <T>(
  items: readonly T[],
  maxTokens: number,
  render: (selected: readonly T[]) => string,
): T[] => {
  const selected: T[] = [];
  const budget = normalizedBudget(maxTokens);
  for (const item of items) {
    const candidate = [...selected, item];
    if (estimateStringTokens(render(candidate)) > budget) continue;
    selected.push(item);
  }
  return selected;
};

const stableOrder = (
  observations: readonly ObservationRecord[],
  selectedIds: ReadonlySet<string>,
): ObservationRecord[] => observations.filter(observation => selectedIds.has(observation.id));

const terms = (text: string): Set<string> => {
  const matches = text.toLowerCase().match(/[a-z0-9_./:@-]+/g) ?? [];
  return new Set(matches.filter(term => term.length >= 4 || /\d/.test(term) || /[./_:@-]/.test(term)));
};

const overlapScore = (sourceTerms: ReadonlySet<string>, observation: ObservationRecord): number => {
  if (sourceTerms.size === 0) return 0;
  let score = 0;
  for (const term of terms(observation.content)) {
    if (!sourceTerms.has(term)) continue;
    score += /\d|[./_:@-]/.test(term) ? 3 : 1;
  }
  return score;
};

export const planObserverContext = (input: ObserverContextPlanInput): ObserverContextPlan => {
  const reflectionBudget = normalizedBudget(input.budgets.reflectionTokens);
  const protectedBudget = normalizedBudget(input.budgets.protectedObservationTokens);
  const recentBudget = normalizedBudget(input.budgets.recentObservationTokens);
  const relatedBudget = normalizedBudget(input.budgets.sourceRelatedObservationTokens);

  const selectedReflections = fitItems(
    input.reflections,
    reflectionBudget,
    selected => section("CURRENT REFLECTIONS", reflectionLines(selected)),
  );
  const reflectionText = section("CURRENT REFLECTIONS", reflectionLines(selectedReflections));

  const protectedCandidates = input.observations
    .map((observation, index) => ({ observation, index }))
    .filter(({ observation }) => observation.relevance === "critical" || observation.relevance === "high")
    .sort((left, right) =>
      relevanceRank[right.observation.relevance] - relevanceRank[left.observation.relevance]
      || right.index - left.index);
  const protectedSelected = fitItems(
    protectedCandidates,
    protectedBudget,
    selected => section("PROTECTED OBSERVATIONS", observationLines(selected.map(item => item.observation))),
  );
  const protectedIds = new Set(protectedSelected.map(item => item.observation.id));
  const protectedObservations = stableOrder(input.observations, protectedIds);
  const protectedText = section("PROTECTED OBSERVATIONS", observationLines(protectedObservations));

  const recentCandidates = input.observations
    .map((observation, index) => ({ observation, index }))
    .filter(({ observation }) => !protectedIds.has(observation.id))
    .sort((left, right) => right.index - left.index);
  const recentSelected = fitItems(
    recentCandidates,
    recentBudget,
    selected => section("RECENT OBSERVATIONS", observationLines(selected.map(item => item.observation))),
  );
  const recentIds = new Set(recentSelected.map(item => item.observation.id));
  const stableIds = new Set([...protectedIds, ...recentIds]);
  const stableObservations = stableOrder(input.observations, stableIds);
  const recentObservations = stableOrder(input.observations, recentIds);
  const recentText = section("RECENT OBSERVATIONS", observationLines(recentObservations));

  const sourceTerms = terms(input.sourceText);
  const relatedCandidates = input.observations
    .map((observation, index) => ({ observation, index, score: overlapScore(sourceTerms, observation) }))
    .filter(({ observation, score }) => score > 0 && !stableIds.has(observation.id))
    .sort((left, right) =>
      right.score - left.score
      || relevanceRank[right.observation.relevance] - relevanceRank[left.observation.relevance]
      || right.index - left.index);
  const relatedSelected = fitItems(
    relatedCandidates,
    relatedBudget,
    selected => section("SOURCE-RELATED OBSERVATIONS", observationLines(selected.map(item => item.observation))),
  );
  const relatedIds = new Set(relatedSelected.map(item => item.observation.id));
  const sourceRelatedObservations = stableOrder(input.observations, relatedIds);
  const sourceRelatedText = section(
    "SOURCE-RELATED OBSERVATIONS",
    observationLines(sourceRelatedObservations),
  );

  const stableBaselineText = [
    "This is a bounded memory baseline for the current observer epoch.",
    "Use it to avoid duplicates and preserve corrections. Omitted evidence remains available through durable memory recall.",
    "",
    reflectionText,
    "",
    protectedText,
    "",
    recentText,
  ].join("\n");

  const protectedCandidateIds = new Set(protectedCandidates.map(item => item.observation.id));
  const selectedIds = new Set([...stableIds, ...relatedIds]);
  return {
    stableBaselineText,
    sourceRelatedText,
    selectedReflections: structuredClone(selectedReflections),
    stableObservations: structuredClone(stableObservations),
    sourceRelatedObservations: structuredClone(sourceRelatedObservations),
    tokens: {
      reflections: estimateStringTokens(reflectionText),
      protectedObservations: estimateStringTokens(protectedText),
      recentObservations: estimateStringTokens(recentText),
      sourceRelatedObservations: estimateStringTokens(sourceRelatedText),
      stableBaseline: estimateStringTokens(stableBaselineText),
      sourceRelated: estimateStringTokens(sourceRelatedText),
    },
    omitted: {
      reflections: input.reflections.length - selectedReflections.length,
      protectedObservations: [...protectedCandidateIds].filter(id => !protectedIds.has(id)).length,
      observations: input.observations.filter(observation => !selectedIds.has(observation.id)).length,
    },
    protectedOverflow: protectedIds.size < protectedCandidateIds.size,
  };
};
