// Formatter: renders VCC sections into bracketed format — ported from pi-vcc
import type { SectionData } from "../types.js";

const section = (title: string, items: string[]): string => {
  if (items.length === 0) return "";
  const body = items.map((i) => `- ${i}`).join("\n");
  return `[${title}]\n${body}`;
};

export const formatFileActivity = (
  fileOps: { modified: Set<string>; created: Set<string>; read: Set<string> },
  maxFiles: number,
): string[] => {
  let remaining = Math.max(0, Math.floor(maxFiles));
  const lines: string[] = [];
  const add = (label: string, files: Set<string>) => {
    if (remaining === 0 || files.size === 0) return;
    const selected = [...files].slice(0, remaining);
    if (selected.length === 0) return;
    lines.push(`${label}: ${selected.join(", ")}`);
    remaining -= selected.length;
  };
  add("Modified", fileOps.modified);
  add("Created", fileOps.created);
  add("Read", fileOps.read);
  return lines;
};

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
