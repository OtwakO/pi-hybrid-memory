import type { MemoryReflection, ObservationRecord, Relevance } from "../types.js";
import { reflectionContent } from "./compaction.js";
import { estimateStringTokens } from "./tokens.js";

export interface ReflectionContextBudgets {
  reflectionTokens: number;
  focusObservationTokens: number;
  protectedObservationTokens: number;
  recentObservationTokens: number;
}

export interface ReflectionContextPlanInput {
  reflections: readonly MemoryReflection[];
  focusObservations: readonly ObservationRecord[];
  historicalObservations: readonly ObservationRecord[];
  budgets: ReflectionContextBudgets;
}

export interface ReflectionEvidenceItem {
  handle: string;
  observation: ObservationRecord;
}

export interface ReflectionContextPlan {
  text: string;
  selectedReflections: MemoryReflection[];
  evidence: ReflectionEvidenceItem[];
  handleToObservationId: Record<string, string>;
  tokens: {
    reflections: number;
    focusObservations: number;
    protectedObservations: number;
    recentObservations: number;
    total: number;
  };
  omitted: {
    reflections: number;
    focusObservations: number;
    protectedObservations: number;
    historicalObservations: number;
  };
  focusOverflow: boolean;
  protectedOverflow: boolean;
}

const relevanceRank: Record<Relevance, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const normalizedBudget = (value: number): number => Math.max(0, Math.floor(value));
const handle = (index: number): string => `E${String(index + 1).padStart(3, "0")}`;
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

const reflectionText = (reflections: readonly MemoryReflection[]): string =>
  section("CURRENT REFLECTIONS", reflections.map(reflectionContent));

const evidenceText = (heading: string, observations: readonly ObservationRecord[]): string =>
  section(
    heading,
    observations.map((observation, index) =>
      `- [${handle(index)}] [${observation.relevance}] ${observation.content}`),
  );

const stableOrder = (
  observations: readonly ObservationRecord[],
  selectedIds: ReadonlySet<string>,
): ObservationRecord[] => observations.filter(observation => selectedIds.has(observation.id));

export const planReflectionContext = (input: ReflectionContextPlanInput): ReflectionContextPlan => {
  const selectedReflections = fitItems(
    input.reflections,
    input.budgets.reflectionTokens,
    reflectionText,
  );
  const renderedReflections = reflectionText(selectedReflections);

  const focusObservations = fitItems(
    input.focusObservations,
    input.budgets.focusObservationTokens,
    selected => evidenceText("FOCUS EVIDENCE", selected),
  );
  const focusIds = new Set(focusObservations.map(observation => observation.id));
  const renderedFocus = evidenceText("FOCUS EVIDENCE", focusObservations);

  const historicalCandidates = input.historicalObservations
    .filter(observation => !focusIds.has(observation.id));
  const protectedCandidates = historicalCandidates
    .map((observation, index) => ({ observation, index }))
    .filter(({ observation }) => observation.relevance === "critical" || observation.relevance === "high")
    .sort((left, right) =>
      relevanceRank[right.observation.relevance] - relevanceRank[left.observation.relevance]
      || right.index - left.index);
  const protectedSelected = fitItems(
    protectedCandidates,
    input.budgets.protectedObservationTokens,
    selected => evidenceText("PROTECTED HISTORICAL EVIDENCE", selected.map(item => item.observation)),
  );
  const protectedIds = new Set(protectedSelected.map(item => item.observation.id));
  const protectedObservations = stableOrder(historicalCandidates, protectedIds);
  const renderedProtected = evidenceText("PROTECTED HISTORICAL EVIDENCE", protectedObservations);

  const recentCandidates = historicalCandidates
    .map((observation, index) => ({ observation, index }))
    .filter(({ observation }) => !protectedIds.has(observation.id))
    .sort((left, right) => right.index - left.index);
  const recentSelected = fitItems(
    recentCandidates,
    input.budgets.recentObservationTokens,
    selected => evidenceText("RECENT HISTORICAL EVIDENCE", selected.map(item => item.observation)),
  );
  const recentIds = new Set(recentSelected.map(item => item.observation.id));
  const recentObservations = stableOrder(historicalCandidates, recentIds);
  const renderedRecent = evidenceText("RECENT HISTORICAL EVIDENCE", recentObservations);

  const selectedHistoricalIds = new Set([...protectedIds, ...recentIds]);
  const selectedObservations = [
    ...focusObservations,
    ...stableOrder(historicalCandidates, selectedHistoricalIds),
  ];
  const evidence = selectedObservations.map((observation, index) => ({
    handle: handle(index),
    observation: structuredClone(observation),
  }));
  const handleToObservationId = Object.fromEntries(
    evidence.map(item => [item.handle, item.observation.id]),
  );
  const text = [
    "This is a bounded evidence set for reflection. Cite only the local evidence handles shown below.",
    "Focus evidence is the transaction's work; historical evidence is context only. Omitted observations remain durable and exactly recallable.",
    "",
    renderedReflections,
    "",
    evidenceText("EVIDENCE", selectedObservations),
  ].join("\n");
  const protectedCandidateIds = new Set(protectedCandidates.map(item => item.observation.id));

  return {
    text,
    selectedReflections: structuredClone(selectedReflections),
    evidence,
    handleToObservationId,
    tokens: {
      reflections: estimateStringTokens(renderedReflections),
      focusObservations: estimateStringTokens(renderedFocus),
      protectedObservations: estimateStringTokens(renderedProtected),
      recentObservations: estimateStringTokens(renderedRecent),
      total: estimateStringTokens(text),
    },
    omitted: {
      reflections: input.reflections.length - selectedReflections.length,
      focusObservations: input.focusObservations.length - focusObservations.length,
      protectedObservations: [...protectedCandidateIds].filter(id => !protectedIds.has(id)).length,
      historicalObservations: historicalCandidates.filter(observation =>
        !selectedHistoricalIds.has(observation.id)).length,
    },
    focusOverflow: focusObservations.length < input.focusObservations.length,
    protectedOverflow: protectedIds.size < protectedCandidateIds.size,
  };
};
