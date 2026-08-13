// Merger: merge policy for VCC sections — ported from pi-vcc
const HEADER_NAMES = ["Session Goal", "Files And Changes", "Commits", "Outstanding Context", "User Preferences"];
const SEPARATOR = "\n\n---\n\n";

const sectionOf = (text: string, header: string): string => {
  const tag = `[${header}]`;
  const start = text.indexOf(tag);
  if (start < 0) return "";
  const after = text.slice(start);
  const nextSection = HEADER_NAMES
    .filter((h) => h !== header)
    .map((h) => after.indexOf(`[${h}]`))
    .filter((n) => n > 0);
  const nextSep = after.indexOf(SEPARATOR);
  const candidates = [...nextSection, ...(nextSep > 0 ? [nextSep] : [])].sort((a, b) => a - b);
  const end = candidates[0];
  return (end ? after.slice(0, end) : after).trim();
};

const briefOf = (text: string): string => {
  const idx = text.indexOf(SEPARATOR);
  if (idx < 0) return "";
  return text.slice(idx + SEPARATOR.length).trim();
};

const mergeHeaderSection = (
  header: string,
  prev: string,
  fresh: string,
  maxFiles: number,
): string => {
  if (header === "Outstanding Context") return fresh; // volatile
  if (!prev) return fresh;
  if (!fresh) return prev;

  if (header === "Files And Changes") return mergeFileLines(prev, fresh, maxFiles);

  // Session Goal, User Preferences: line-level dedup, cap
  const isClean = (l: string) => l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill");
  const prevLines = prev.split("\n").filter(isClean);
  const freshLines = fresh.split("\n").filter(isClean);
  const combined = [...new Set([...prevLines, ...freshLines])];
  const CAP = header === "Session Goal" ? 8 : header === "Commits" ? 8 : 15;
  const capped = combined.length > CAP ? combined.slice(-CAP) : combined;
  if (capped.length === 0) return "";
  return `[${header}]\n${capped.join("\n")}`;
};

const mergeFileLines = (prev: string, fresh: string, maxFiles: number): string => {
  const categories = ["Modified", "Created", "Read"] as const;
  const merged: Record<string, Set<string>> = {};
  for (const cat of categories) merged[cat] = new Set();

  for (const text of [prev, fresh]) {
    for (const line of text.split("\n")) {
      for (const cat of categories) {
        const prefix = `- ${cat}: `;
        if (!line.startsWith(prefix)) continue;
        let rest = line.slice(prefix.length).replace(/\s*\(\+\d+ more\)\s*$/, "");
        for (const p of rest.split(",")) {
          const trimmed = p.trim();
          if (trimmed) merged[cat].add(trimmed);
        }
      }
    }
  }

  // Dedup: if already in Modified, drop from Created
  for (const p of merged.Modified) merged.Created.delete(p);

  const lines: string[] = [];
  let remaining = Math.max(0, Math.floor(maxFiles));
  const add = (category: typeof categories[number]) => {
    if (remaining === 0 || merged[category].size === 0) return;
    const selected = [...merged[category]].slice(0, remaining);
    if (selected.length === 0) return;
    lines.push(`- ${category}: ${selected.join(", ")}`);
    remaining -= selected.length;
  };
  add("Modified");
  add("Created");
  add("Read");
  if (lines.length === 0) return "";
  return `[Files And Changes]\n${lines.join("\n")}`;
};

const mergeBriefWindow = (prevBrief: string, freshBrief: string, maxLines: number): string => {
  if (!freshBrief) return prevBrief.split("\n").slice(-maxLines).join("\n");
  const freshLines = freshBrief.split("\n");
  if (freshLines.length >= maxLines) return freshLines.slice(-maxLines).join("\n");
  const remaining = maxLines - freshLines.length;
  const priorLines = prevBrief ? prevBrief.split("\n").slice(-remaining) : [];
  return [...priorLines, ...freshLines].join("\n");
};

export const mergeVccSummaries = (
  prev: string | undefined,
  fresh: string,
  maxBriefLines = 120,
  maxFiles = 40,
): string => {
  if (!prev) return fresh;

  const headers = HEADER_NAMES
    .map((header) => {
      const freshSec = sectionOf(fresh, header);
      const prevSec = sectionOf(prev, header);
      return mergeHeaderSection(header, prevSec, freshSec, maxFiles);
    })
    .filter(Boolean);

  const prevBrief = briefOf(prev);
  const freshBrief = briefOf(fresh);
  const mergedBrief = mergeBriefWindow(prevBrief, freshBrief, maxBriefLines);

  const parts: string[] = [];
  if (headers.length > 0) parts.push(headers.join("\n\n"));
  if (mergedBrief) parts.push(mergedBrief);

  return parts.join(SEPARATOR);
};
