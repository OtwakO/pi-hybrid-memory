// Extractors: goal, files, commits, preferences, blockers — ported from pi-vcc
import type { NormalizedBlock } from "../types.js";

// ── Helpers ──

const nonEmptyLines = (text: string): string[] =>
  text.split("\n").map((l) => l.trim()).filter(Boolean);

const clip = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 3) + "...";

const firstLine = (text: string, max = 200): string => {
  const line = text.split(/\n/)[0] ?? "";
  return clip(line.trim(), max);
};

// ── Goals ──

const SCOPE_CHANGE_RE =
  /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;

const TASK_RE =
  /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i;

const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k)\s*[.!?]*$/i;

const NON_GOAL_RE =
  /^\s*[\[│├└─╭╰]|```|^\s*(=[A-Z]+\(|function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])|\\n|^\s*For each\b|\bin full\b[^\n]*\b(comments|issue|issues|PRs?|linked)\b/;

const TEMPLATE_SIGNAL_RE =
  /^\s*(For each\b|Do NOT implement\b|Analyze and propose\b|If Task\/context\b|Output:\s*$)/i;

const truncateAtTemplate = (lines: string[]): string[] => {
  const idx = lines.findIndex((l) => TEMPLATE_SIGNAL_RE.test(l));
  return idx >= 0 ? lines.slice(0, idx) : lines;
};

const stripLeadingBullet = (line: string): string =>
  line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();

const MAX_GOAL_CHARS = 200;
const LEADING_CHARS = 200;

const isSubstantiveGoal = (text: string): boolean => {
  const t = text.trim();
  if (t.length <= 5) return false;
  if (t.length > MAX_GOAL_CHARS) return false;
  if (NOISE_SHORT_RE.test(t)) return false;
  if (NON_GOAL_RE.test(t)) return false;
  return true;
};

export const extractGoals = (blocks: NormalizedBlock[]): string[] => {
  const goals: string[] = [];
  let latestScopeChange: string[] | null = null;

  for (const b of blocks) {
    if (b.kind !== "user") continue;
    const rawLines = nonEmptyLines(b.text);
    const truncated = truncateAtTemplate(rawLines);
    const lines = truncated.filter(isSubstantiveGoal)
      .map(stripLeadingBullet)
      .filter((l) => l.length > 5);
    if (lines.length === 0) continue;

    if (goals.length === 0) {
      goals.push(...lines.slice(0, 6));
      continue;
    }

    const leading = b.text.slice(0, LEADING_CHARS);
    if (SCOPE_CHANGE_RE.test(leading)) {
      latestScopeChange = lines.slice(0, 3).map((l) => clip(l, MAX_GOAL_CHARS));
    } else if (TASK_RE.test(leading) && lines[0].length > 15) {
      latestScopeChange = lines.slice(0, 2).map((l) => clip(l, MAX_GOAL_CHARS));
    }
  }

  if (latestScopeChange && latestScopeChange.length > 0) {
    goals.push("[Scope change]", ...latestScopeChange);
  }

  return goals.slice(0, 8);
};

// ── Files ──

const FILE_READ_TOOLS = new Set(["read", "read_file", "view"]);
const FILE_WRITE_TOOLS = new Set([
  "edit", "write", "edit_file", "write_file", "multiedit",
  "quick_edit", "target_edit", "apply_patch",
]);
const FILE_CREATE_TOOLS = new Set(["write", "write_file"]);

const extractPath = (args: Record<string, unknown>): string | undefined => {
  for (const key of ["file_path", "path", "filePath", "file"]) {
    if (typeof args[key] === "string" && (args[key] as string).length > 0) return args[key] as string;
  }
  return undefined;
};

const longestCommonDirPrefix = (paths: string[]): string => {
  const abs = paths.filter((p) => p.startsWith("/"));
  if (abs.length < 2) return "";
  const split = abs.map((p) => p.split("/"));
  const min = Math.min(...split.map((s) => s.length));
  let i = 0;
  while (i < min - 1) {
    const seg = split[0][i];
    if (!split.every((s) => s[i] === seg)) break;
    i++;
  }
  if (i < 2) return "";
  return split[0].slice(0, i).join("/") + "/";
};

const trimPaths = (set: Set<string>, prefix: string): Set<string> => {
  if (!prefix) return set;
  const out = new Set<string>();
  for (const p of set) out.add(p.startsWith(prefix) ? p.slice(prefix.length) : p);
  return out;
};

export interface AuthoritativeFileOperations {
  read: ReadonlySet<string>;
  written: ReadonlySet<string>;
  edited: ReadonlySet<string>;
}

export const extractFiles = (
  blocks: NormalizedBlock[],
  authoritative?: AuthoritativeFileOperations,
): { read: Set<string>; modified: Set<string>; created: Set<string> } => {
  const act = {
    read: new Set(authoritative?.read ?? []),
    modified: new Set(authoritative?.edited ?? []),
    created: new Set(authoritative?.written ?? []),
  };
  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    const p = extractPath(b.args);
    if (!p) continue;
    const toolName = b.name.toLowerCase();
    if (FILE_READ_TOOLS.has(toolName)) act.read.add(p);
    if (FILE_WRITE_TOOLS.has(toolName)) act.modified.add(p);
    if (FILE_CREATE_TOOLS.has(toolName)) act.created.add(p);
  }
  for (const modified of [...act.modified, ...act.created]) act.read.delete(modified);
  const all = [...act.read, ...act.modified, ...act.created];
  const prefix = longestCommonDirPrefix(all);
  if (prefix) {
    act.read = trimPaths(act.read, prefix);
    act.modified = trimPaths(act.modified, prefix);
    act.created = trimPaths(act.created, prefix);
  }
  return act;
};

// ── Commits ──

const COMMIT_MSG_RE = /git\s+commit[^\n]*?-m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\$?'((?:[^'\\]|\\.)*)')/;
const HASH_RE = /\b([0-9a-f]{7,12})\b/;

export const extractCommits = (blocks: NormalizedBlock[]): { hash?: string; message: string }[] => {
  const commits: { hash?: string; message: string }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== "tool_call" || b.name !== "bash") continue;
    const cmd = typeof b.args.command === "string" ? b.args.command : "";
    if (!/\bgit\s+commit\b/.test(cmd)) continue;
    const m = cmd.match(COMMIT_MSG_RE);
    if (!m) continue;
    const message = (m[1] ?? m[2] ?? m[3] ?? "").split(/\n/)[0]?.trim().replace(/\\"/g, '"').replace(/\\'/g, "'");
    if (!message) continue;
    let hash: string | undefined;
    for (let j = i + 1; j < Math.min(blocks.length, i + 3); j++) {
      const r = blocks[j];
      if (r.kind !== "tool_result") continue;
      const bracket = r.text.match(/\[\S+\s+([0-9a-f]{7,12})\]/);
      if (bracket) { hash = bracket[1]; break; }
      const range = r.text.match(/\b([0-9a-f]{7,12})\.\.([0-9a-f]{7,12})\b/);
      if (range) { hash = range[2]; break; }
      const plain = r.text.match(HASH_RE);
      if (plain) { hash = plain[1]; break; }
    }
    const key = `${hash ?? ""}::${message}`;
    if (!commits.some((c) => `${c.hash ?? ""}::${c.message}` === key)) {
      commits.push({ hash, message });
    }
  }
  return commits;
};

export const formatCommits = (commits: { hash?: string; message: string }[], limit = 8): string[] => {
  return commits.slice(-limit).map((c) => `${c.hash ? `${c.hash}: ` : ""}${c.message}`);
};

// ── Preferences ──

const PREF_PATTERNS = [
  /\bprefer(?:s|red|ring)?\s+\w/i,
  /\bdon'?t want\b/i,
  /\balways (?:use|do|run|prefer|keep|make|format|write|add|set|put|prefix|start|include|append)\b/i,
  /\bnever (?:use|do|run|push|commit|write|ignore|add|set|put|remove|delete|include|deploy)\b/i,
  /\bplease (?:use|avoid|keep|make|don'?t|do not|format|write)\b/i,
  /\b(?:style|format|language|naming)\s*[:=]\s*\S/i,
];

export const extractPreferences = (blocks: NormalizedBlock[]): string[] => {
  const prefs: string[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    if (b.kind !== "user") continue;
    let perBlock = 0;
    for (const line of nonEmptyLines(b.text)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 5 || trimmed.length > 200) continue;
      if (trimmed.endsWith("?") || trimmed.includes("?...")) continue;
      if (!PREF_PATTERNS.some((p) => p.test(trimmed))) continue;
      const clipped = clip(trimmed, 200);
      const key = clipped.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      prefs.push(clipped);
      if (++perBlock >= 1) break;
    }
  }
  return prefs.slice(0, 10);
};


// ── Outstanding Context ──

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

export const extractOutstandingContext = (blocks: NormalizedBlock[]): string[] => {
  const items: string[] = [];
  const tail = blocks.slice(-20);
  for (const b of tail) {
    if (b.kind === "tool_result" && b.isError) {
      items.push(`[${b.name}] ${firstLine(b.text, 150)}`);
      continue;
    }
    if (b.kind === "assistant" || b.kind === "user") {
      for (const line of nonEmptyLines(b.text)) {
        if (!BLOCKER_RE.test(line)) continue;
        if (line.length < 15) continue;
        if (/^\s*[-*+>]\s/.test(line)) continue;
        if (/^\s*\(/.test(line)) continue;
        if (!/^\s*["'`*_]?[A-Z`]/.test(line)) continue;
        const clipped = b.kind === "user" ? `[user] ${clip(line, 150)}` : clip(line, 150);
        if (!items.includes(clipped)) items.push(clipped);
        break;
      }
    }
  }
  return items.slice(0, 5);
};
