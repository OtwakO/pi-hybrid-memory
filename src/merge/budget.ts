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
  omissionNotice: string,
): string => {
  const parts: string[] = [];
  const omSummary = renderSummary(reflections, observations);
  if (omSummary) parts.push(memoryHeader + omSummary);
  if (vccSummary) parts.push(vccHeader + vccSummary);
  if (omissionNotice) parts.push(omissionNotice);
  return parts.join("\n\n---\n\n");
};

const normalizedContent = (content: string): string => content.trim().replace(/\s+/g, " ");

const exactlyPreservedObservationIds = (
  reflections: MemoryReflection[],
  observations: ObservationRecord[],
): Set<string> => {
  const observationsById = new Map(observations.map(observation => [observation.id, observation]));
  const preserved = new Set<string>();
  for (const reflection of reflections) {
    if (typeof reflection === "string" || reflection.legacy) continue;
    const content = normalizedContent(reflection.content);
    for (const observationId of reflection.supportingObservationIds) {
      const observation = observationsById.get(observationId);
      if (observation && content.includes(normalizedContent(observation.content))) {
        preserved.add(observationId);
      }
    }
  }
  return preserved;
};

const boundedIds = (ids: string[]): string => {
  const shown = ids.slice(-6);
  return `${shown.join(", ")}${ids.length > shown.length ? `, +${ids.length - shown.length} more` : ""}`;
};

const omissionNotice = (
  observationIds: string[],
  reflectionIds: string[],
  legacyReflections: number,
  structuralItems: number,
): string => {
  const parts: string[] = [];
  if (observationIds.length > 0) {
    parts.push(`observations ${observationIds.length} [${boundedIds(observationIds)}]`);
  }
  if (reflectionIds.length > 0) {
    parts.push(`reflections ${reflectionIds.length} [${boundedIds(reflectionIds)}]`);
  }
  if (legacyReflections > 0) parts.push(`legacy reflections ${legacyReflections}`);
  if (structuralItems > 0) parts.push(`session state ${structuralItems}`);
  if (parts.length === 0) return "";
  return `## Projection Omissions\nOmitted ${parts.join("; ")}. Durable memory is unchanged; recall listed IDs with \`hm_recall\`.`;
};

const hardCapNotice = (maxTokens: number): string => {
  const maxCharacters = Math.max(0, Math.floor(maxTokens) * 4);
  const notice = "## Projection Pressure\nProjection content was omitted to fit the configured hard ceiling. Durable memory remains available through hm_recall.";
  if (notice.length <= maxCharacters) return notice;
  let capped = notice.slice(0, maxCharacters);
  const finalCodeUnit = capped.charCodeAt(capped.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) capped = capped.slice(0, -1);
  return capped;
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


const dropOldestSectionLine = (
  state: VccState,
  section: SectionName,
): boolean => {
  const lines = state.sections.get(section) ?? [];
  if (lines.length === 0) return false;
  lines.shift();
  return true;
};

export const applySummaryBudget = (input: BudgetInput): BudgetResult => {
  const observations = [...input.observations];
  const reflections = [...input.reflections];
  const vcc = parseVcc(input.vccSummary);
  const omittedObservationIds: string[] = [];
  const omittedReflectionIds: string[] = [];
  let omittedLegacyReflections = 0;
  let omittedStructuralItems = 0;
  let trimmed = false;
  let protectedOverflow = false;

  const render = () => {
    const renderedVcc = renderVcc(vcc);
    const vccSummary = renderedVcc || (input.vccSummary && omittedStructuralItems > 0
      ? `[Projection Pressure]\n- ${omittedStructuralItems} prior session-state items omitted by hard ceiling.`
      : "");
    const compactHeader = (header: string): string => `${header.split("\n", 1)[0]}\n`;
    const notice = omissionNotice(
      omittedObservationIds,
      omittedReflectionIds,
      omittedLegacyReflections,
      omittedStructuralItems,
    );
    const summary = compose(
      reflections,
      observations,
      vccSummary,
      trimmed ? compactHeader(input.memoryHeader) : input.memoryHeader,
      input.vccHeader,
      notice,
    );
    return { vccSummary, summary, tokenCount: estimateStringTokens(summary) };
  };

  let current = render();
  const trimWhileOver = (drop: () => boolean, trimsProtected = false) => {
    while (current.tokenCount > input.maxTokens && drop()) {
      trimmed = true;
      if (trimsProtected) protectedOverflow = true;
      current = render();
    }
  };
  const dropStructural = (drop: () => boolean): boolean => {
    if (!drop()) return false;
    omittedStructuralItems++;
    return true;
  };
  const dropObservation = (relevance: Relevance): boolean => {
    const index = observations.findIndex(observation => observation.relevance === relevance);
    if (index < 0) return false;
    omittedObservationIds.push(observations[index].id);
    observations.splice(index, 1);
    return true;
  };

  trimWhileOver(() => dropStructural(() => dropOldestTranscriptLine(vcc)));

  const exactlyPreserved = exactlyPreservedObservationIds(reflections, observations);
  trimWhileOver(() => {
    const index = observations.findIndex(observation => exactlyPreserved.has(observation.id));
    if (index < 0) return false;
    omittedObservationIds.push(observations[index].id);
    observations.splice(index, 1);
    return true;
  }, true);

  trimWhileOver(() => dropObservation("low"));
  trimWhileOver(() => dropObservation("medium"));
  trimWhileOver(() => dropStructural(() => dropOldestSectionLine(vcc, "Files And Changes")));
  trimWhileOver(() => dropStructural(() => dropOldestSectionLine(vcc, "Commits")));
  trimWhileOver(() => dropStructural(() => dropOldestSectionLine(vcc, "User Preferences")));
  trimWhileOver(() => dropStructural(() => dropOldestSectionLine(vcc, "Session Goal")));
  trimWhileOver(() => dropObservation("high"));

  trimWhileOver(() => dropStructural(() => dropOldestSectionLine(vcc, "Outstanding Context")), true);
  trimWhileOver(() => dropObservation("critical"), true);
  trimWhileOver(() => {
    if (reflections.length === 0) return false;
    const reflection = reflections.shift()!;
    if (typeof reflection === "string") omittedLegacyReflections++;
    else omittedReflectionIds.push(reflection.id);
    return true;
  }, true);
  trimWhileOver(() => {
    if (vcc.passthroughSections.length === 0) return false;
    vcc.passthroughSections.shift();
    omittedStructuralItems++;
    return true;
  }, true);
  for (const section of SECTION_ORDER) {
    trimWhileOver(() => dropStructural(() => dropOldestSectionLine(vcc, section)), true);
  }

  if (current.tokenCount > input.maxTokens) {
    trimmed = true;
    protectedOverflow = true;
    const summary = hardCapNotice(input.maxTokens);
    current = {
      vccSummary: "",
      summary,
      tokenCount: estimateStringTokens(summary),
    };
  }

  return {
    observations,
    vccSummary: current.vccSummary,
    summary: current.summary,
    tokenCount: current.tokenCount,
    trimmed,
    protectedOverflow,
  };
};
