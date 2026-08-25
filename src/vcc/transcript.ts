// Transcript builder: rolling window, tool call collapsing — ported from pi-vcc
import type { NormalizedBlock } from "../types.js";

const TRUNCATE_USER = 256;
const TRUNCATE_ASSISTANT = 200;
const BASH_CAP = 120;
const PIPE_TAIL_RE = /\s*\|\s*(?:head|tail|sort|wc|column|tr|cut|awk|uniq|python3|node|bun)(?:\s[^|]*)?$/;
const SELF_TALK_PREFIX_RE = /^\s*(?:hmm|wait|actually|oh|okay|ok|well|so)[,.!\s-]+/i;

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const isWord = (seg: Intl.SegmentData): boolean =>
  seg.isWordLike || /[\p{L}\p{N}]/u.test(seg.segment);

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "under", "over",
  "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
  "neither", "each", "every", "all", "any", "few", "more", "most",
  "other", "some", "such", "no", "that", "this", "these", "those", "it", "its",
  "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
  "she", "her", "they", "them", "their", "who", "which", "what",
  "if", "then", "than", "when", "where", "how", "just", "also",
]);

const truncateTokens = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  let count = 0;
  let lastEnd = 0;
  for (const seg of segmenter.segment(flat)) {
    if (isWord(seg)) {
      if (!STOP_WORDS.has(seg.segment.toLowerCase())) {
        count++;
        if (count > limit) return flat.slice(0, lastEnd).trimEnd() + "...(truncated)";
      }
    }
    lastEnd = seg.index + seg.segment.length;
  }
  return flat;
};

const compressBash = (raw: string): string => {
  let cmd = raw.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? raw;
  cmd = cmd.replace(/^cd\s+\S+\s*&&\s*/, "");
  for (let i = 0; i < 3; i++) {
    const stripped = cmd.replace(PIPE_TAIL_RE, "");
    if (stripped === cmd) break;
    cmd = stripped;
  }
  if (cmd.length > BASH_CAP) return cmd.slice(0, BASH_CAP - 3) + "...";
  return cmd;
};

const TOOL_SUMMARY_FIELDS: Record<string, string> = {
  Read: "file_path", Edit: "file_path", Write: "file_path",
  read: "file_path", edit: "file_path", write: "file_path",
  Glob: "pattern", Grep: "pattern",
};

const extractPath = (args: Record<string, unknown>): string | undefined => {
  for (const key of ["file_path", "path", "filePath", "file"]) {
    if (typeof args[key] === "string" && (args[key] as string).length > 0) return args[key] as string;
  }
  return undefined;
};

const clip = (s: string, max: number): string => s.length <= max ? s : s.slice(0, max - 3) + "...";

const toolOneLiner = (name: string, args: Record<string, unknown>): string => {
  const field = TOOL_SUMMARY_FIELDS[name];
  if (field && typeof args[field] === "string") return `* ${name} "${args[field] as string}"`;
  const path = extractPath(args);
  if (path) return `* ${name} "${path}"`;
  if (name === "bash" || name === "Bash") {
    const raw = (args.command ?? args.description ?? "") as string;
    return `* ${name} "${compressBash(raw)}"`;
  }
  if (typeof args.query === "string") return `* ${name} "${clip(args.query as string, 60)}"`;
  return `* ${name}`;
};

const collapseSkillText = (text: string): string => {
  // Strip <skill>...</skill> blocks — keep only the surrounding text
  return text.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/g, "").replace(/\n{3,}/g, "\n\n").trim();
};

export interface BriefLine {
  header: string;
  lines: string[];
}

export const buildBriefSections = (blocks: NormalizedBlock[], maxLines = 120): BriefLine[] => {
  const sections: BriefLine[] = [];
  let lastHeader = "";

  const push = (header: string, line: string) => {
    if (header === lastHeader && sections.length > 0) {
      sections[sections.length - 1].lines.push(line);
      return;
    }
    sections.push({ header, lines: [line] });
    lastHeader = header;
  };

  for (const b of blocks) {
    switch (b.kind) {
      case "user": {
        if (!b.text.trim()) break;
        const text = truncateTokens(collapseSkillText(b.text), TRUNCATE_USER);
        if (text) {
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          push("[user]", text + ref);
        }
        lastHeader = "[user]";
        break;
      }
      case "assistant": {
        let raw = b.text;
        for (let i = 0; i < 2; i++) {
          const stripped = raw.replace(SELF_TALK_PREFIX_RE, "");
          if (stripped === raw) break;
          raw = stripped;
        }
        const text = truncateTokens(raw, TRUNCATE_ASSISTANT);
        if (text) {
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          push("[assistant]", text + ref);
        }
        break;
      }
      case "tool_call": {
        if (!b.name || b.name.trim() === "") break;
        const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
        const summary = toolOneLiner(b.name, b.args) + ref;
        push("[assistant]", summary);
        break;
      }
      case "tool_result": {
        if (b.isError) {
          const body = b.text.split("\n")[0]?.trim() ?? "";
          if (!body || body === "(no output)") break;
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          const header = `[tool_error] ${b.name}${ref}`;
          push(header, body);
          lastHeader = header;
        }
        break;
      }
      case "thinking":
        break;
    }
  }

  // Collapse consecutive identical tool lines
  for (const sec of sections) {
    if (sec.header !== "[assistant]") continue;
    const out: string[] = [];
    for (const line of sec.lines) {
      if (!line.startsWith("* ")) { out.push(line); continue; }
      const ref = line.match(/\(#(\d+)\)$/)?.[1] ?? "";
      const base = ref ? line.slice(0, -(ref.length + 3)).trimEnd() : line;
      const last = out.length > 0 ? out[out.length - 1] : "";
      const m = last.match(/^(.*) \((#[\d, #]+)\) x(\d+)$/);
      if (m && m[1] === base) {
        out[out.length - 1] = `${base} (${m[2]}, #${ref}) x${parseInt(m[3]) + 1}`;
      } else if (last.match(/\(#\d+\)$/) && last.replace(/\s*\(#\d+\)$/, "") === base) {
        const prevRef = last.match(/\(#(\d+)\)$/)?.[1];
        out[out.length - 1] = `${base} (#${prevRef}, #${ref}) x2`;
      } else {
        out.push(line);
      }
    }
    sec.lines = out;
  }

  // Cap tool calls per [assistant] turn
  const TOOL_CALLS_PER_TURN = 8;
  for (const sec of sections) {
    if (sec.header !== "[assistant]") continue;
    const toolIdxs = sec.lines.map((l, i) => (l.startsWith("* ") ? i : -1)).filter((i) => i >= 0);
    if (toolIdxs.length <= TOOL_CALLS_PER_TURN) continue;
    const dropCount = toolIdxs.length - TOOL_CALLS_PER_TURN;
    const dropSet = new Set(toolIdxs.slice(0, dropCount));
    const firstKeptToolIdx = toolIdxs[dropCount];
    const next: string[] = [];
    let inserted = false;
    for (let i = 0; i < sec.lines.length; i++) {
      if (dropSet.has(i)) continue;
      if (!inserted && i === firstKeptToolIdx) {
        next.push(`* (${dropCount} earlier tool-call entries omitted)`);
        inserted = true;
      }
      next.push(sec.lines[i]);
    }
    sec.lines = next;
  }

  // Collapse consecutive identical [tool_error] sections
  const collapsedErrors: BriefLine[] = [];
  for (const sec of sections) {
    const m = sec.header.match(/^\[tool_error\]\s+(\S+?)(?:\s*\(#(\d+)\))?$/);
    if (!m || sec.lines.length !== 1) { collapsedErrors.push(sec); continue; }
    const tool = m[1];
    const ref = m[2];
    const body = sec.lines[0];
    const prev = collapsedErrors[collapsedErrors.length - 1];
    const prevMatch = prev?.header.match(/^\[tool_error\]\s+(\S+?)\s*\(((?:#\d+(?:,\s*)?)+)\)(?:\s*x(\d+))?$/);
    if (prev && prevMatch && prevMatch[1] === tool && prev.lines.length === 1 && prev.lines[0] === body) {
      const refs = prevMatch[2] + (ref ? `, #${ref}` : "");
      const count = prevMatch[3] ? parseInt(prevMatch[3]) + 1 : 2;
      prev.header = `[tool_error] ${tool} (${refs}) x${count}`;
    } else {
      collapsedErrors.push(sec);
    }
  }
  sections.length = 0;
  sections.push(...collapsedErrors);

  // Cap total lines
  let totalLines = sections.reduce((s, sec) => s + 1 + sec.lines.length, 0);
  if (totalLines > maxLines) {
    // Remove oldest sections first
    while (totalLines > maxLines && sections.length > 1) {
      const removed = sections.shift();
      if (removed) totalLines -= 1 + removed.lines.length;
    }
  }

  return sections;
};

export const stringifyBrief = (sections: BriefLine[]): string => {
  const out: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (i > 0) {
      const prev = sections[i - 1];
      const prevIsTools = prev.header === "[assistant]" && prev.lines.every((l) => l.startsWith("* "));
      const curIsTools = sec.header === "[assistant]" && sec.lines.every((l) => l.startsWith("* "));
      if (!(prevIsTools && curIsTools)) out.push("");
    }
    out.push(sec.header);
    for (const line of sec.lines) out.push(line);
  }
  return out.join("\n");
};

export const capBrief = (text: string, maxLines = 120): string => {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const omitted = lines.length - maxLines;
  const kept = lines.slice(-maxLines);
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};
