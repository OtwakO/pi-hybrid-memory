// Formatter: renders VCC sections into bracketed format — ported from pi-vcc
import type { SectionData } from "../types.js";

const section = (title: string, items: string[]): string => {
  if (items.length === 0) return "";
  const body = items.map((i) => `- ${i}`).join("\n");
  return `[${title}]\n${body}`;
};

export const RECALL_NOTE =
  "Use `hm_recall` or `vcc_recall` to search for prior work, decisions, and context from before this summary. " +
  "Do not redo work already completed.";

export const formatVccSections = (data: SectionData): string => {
  const headerParts = [
    section("Session Goal", data.sessionGoal),
    section("Files And Changes", data.filesAndChanges),
    section("Commits", data.commits),
    section("Outstanding Context", data.outstandingContext),
    section("User Preferences", data.userPreferences),
  ].filter(Boolean);

  const parts: string[] = [];
  if (headerParts.length > 0) parts.push(headerParts.join("\n\n"));
  if (data.briefTranscript) parts.push(data.briefTranscript);

  if (parts.length === 0) return "";
  return parts.join("\n\n---\n\n");
};
