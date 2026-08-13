import type { MemoryReflection, ObservationRecord, Relevance } from "../types.js";
import { renderSummary } from "../om/compaction.js";
import { estimateStringTokens } from "../om/tokens.js";

const SECTION_ORDER = [
  "Session Goal",
  "Files And Changes",
  "Commits",
  "Outstanding Context",
  "User Preferences",
] as const;

type SectionName = typeof SECTION_ORDER[number];

interface TranscriptGroup {
  header: string;
  lines: string[];
}

interface VccState {
  sections: Map<SectionName, string[]>;
  passthroughSections: string[];
  transcript: TranscriptGroup[];
}

export interface BudgetInput {
  observations: ObservationRecord[];
  reflections: MemoryReflection[];
  vccSummary: string;
  maxTokens: number;
  memoryHeader: string;
  vccHeader: string;
}

export interface BudgetResult {
  observations: ObservationRecord[];
  vccSummary: string;
  summary: string;
  tokenCount: number;
  trimmed: boolean;
  protectedOverflow: boolean;
}

const parseTranscript = (text: string): TranscriptGroup[] => {
  const groups: TranscriptGroup[] = [];
  for (const line of text.split("\n")) {
    if (/^\[.+\]/.test(line)) {
      groups.push({ header: line, lines: [] });
    } else if (groups.length > 0 && line.trim()) {
      groups[groups.length - 1].lines.push(line);
    }
  }
  return groups;
};

const parseVcc = (text: string): VccState => {
  const [sectionText, ...briefParts] = text.split("\n\n---\n\n");
  const sections = new Map<SectionName, string[]>();
  const passthroughSections: string[] = [];
  let current: SectionName | null = null;
  let passthrough: string[] = [];
  const flushPassthrough = () => {
    if (passthrough.length > 0) passthroughSections.push(passthrough.join("\n"));
    passthrough = [];
  };
  for (const line of sectionText.split("\n")) {
    const header = SECTION_ORDER.find((name) => line === `[${name}]`);
    if (header) {
      flushPassthrough();
      current = header;
      if (!sections.has(header)) sections.set(header, []);
    } else if (/^\[.+\]$/.test(line)) {
      flushPassthrough();
      current = null;
      passthrough.push(line);
    } else if (current && line.trim()) {
      sections.get(current)!.push(line);
    } else if (passthrough.length > 0 && line.trim()) {
      passthrough.push(line);
    }
  }
  flushPassthrough();
  return {
    sections,
    passthroughSections,
    transcript: parseTranscript(briefParts.join("\n\n---\n\n")),
  };
};

const renderVcc = (state: VccState): string => {
  const sectionParts = SECTION_ORDER.flatMap((name) => {
    const lines = state.sections.get(name) ?? [];
    return lines.length > 0 ? [`[${name}]\n${lines.join("\n")}`] : [];
  });
  sectionParts.push(...state.passthroughSections);
  const transcript = state.transcript
    .filter((group) => group.lines.length > 0)
    .map((group) => `${group.header}\n${group.lines.join("\n")}`)
    .join("\n\n");
  return [sectionParts.join("\n\n"), transcript].filter(Boolean).join("\n\n---\n\n");
};

const compose = (
  reflections: MemoryReflection[],
  observations: ObservationRecord[],
  vccSummary: string,
  memoryHeader: string,
  vccHeader: string,
): string => {
  const parts: string[] = [];
  const omSummary = renderSummary(reflections, observations);
  if (omSummary) parts.push(memoryHeader + omSummary);
  if (vccSummary) parts.push(vccHeader + vccSummary);
  return parts.join("\n\n---\n\n");
};

const dropOldestTranscriptLine = (state: VccState): boolean => {
  while (state.transcript.length > 0) {
    const first = state.transcript[0];
    if (first.lines.length > 0) {
      first.lines.shift();
      if (first.lines.length === 0) state.transcript.shift();
      return true;
    }
    state.transcript.shift();
  }
  return false;
};

const dropOldestObservation = (
  observations: ObservationRecord[],
  relevance: Relevance,
): boolean => {
  const index = observations.findIndex((observation) => observation.relevance === relevance);
  if (index < 0) return false;
  observations.splice(index, 1);
  return true;
};

const dropOldestSectionLine = (
  state: VccState,
  section: SectionName,
  protectFirst = false,
): boolean => {
  const lines = state.sections.get(section) ?? [];
  const removableIndex = protectFirst ? 1 : 0;
  if (lines.length <= removableIndex) return false;
  lines.splice(removableIndex, 1);
  return true;
};

export const applySummaryBudget = (input: BudgetInput): BudgetResult => {
  const observations = [...input.observations];
  const vcc = parseVcc(input.vccSummary);
  let trimmed = false;

  const render = () => {
    const vccSummary = renderVcc(vcc);
    const summary = compose(
      input.reflections,
      observations,
      vccSummary,
      input.memoryHeader,
      input.vccHeader,
    );
    return { vccSummary, summary, tokenCount: estimateStringTokens(summary) };
  };

  let current = render();
  const trimWhileOver = (drop: () => boolean) => {
    while (current.tokenCount > input.maxTokens && drop()) {
      trimmed = true;
      current = render();
    }
  };

  trimWhileOver(() => dropOldestTranscriptLine(vcc));
  trimWhileOver(() => dropOldestObservation(observations, "low"));
  trimWhileOver(() => dropOldestObservation(observations, "medium"));
  trimWhileOver(() => dropOldestSectionLine(vcc, "Outstanding Context"));
  trimWhileOver(() => dropOldestSectionLine(vcc, "Files And Changes"));
  trimWhileOver(() => dropOldestObservation(observations, "high"));
  trimWhileOver(() => dropOldestSectionLine(vcc, "Session Goal", true));
  trimWhileOver(() => dropOldestSectionLine(vcc, "Commits"));
  trimWhileOver(() => dropOldestSectionLine(vcc, "User Preferences"));

  return {
    observations,
    vccSummary: current.vccSummary,
    summary: current.summary,
    tokenCount: current.tokenCount,
    trimmed,
    protectedOverflow: current.tokenCount > input.maxTokens,
  };
};
