// Tests for pi-hybrid-memory — core unit tests for VCC, OM, and merge pipelines
import { describe, it, expect } from "vitest";
import { normalize } from "../src/vcc/normalizer.js";
import { extractGoals, extractFiles, extractCommits, extractPreferences, extractOutstandingContext } from "../src/vcc/extractor.js";
import { buildBriefSections, stringifyBrief, capBrief } from "../src/vcc/transcript.js";
import { formatFileActivity, formatVccSections } from "../src/vcc/formatter.js";
import { mergeVccSummaries } from "../src/vcc/merger.js";
import { estimateStringTokens } from "../src/om/tokens.js";
import { countByRelevance, formatRelevanceHistogram } from "../src/om/relevance.js";
import { mergePipelines } from "../src/merge/pipeline.js";
import { vccMessagesFromEntries } from "../src/compaction-hook.js";

// ── VCC Normalizer ──

describe("normalize", () => {
  it("converts a user message to a user block", () => {
    const blocks = normalize([{ role: "user", content: "Fix the bug in auth.ts" } as any]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "user", text: "Fix the bug in auth.ts", sourceIndex: 0 });
  });

  it("converts an assistant text response to an assistant block", () => {
    const blocks = normalize([{ role: "assistant", content: "I'll look at auth.ts" } as any]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("assistant");
  });

  it("converts a tool result to a tool_result block", () => {
    const blocks = normalize([{ role: "toolResult", toolName: "Read", content: "file contents" } as any]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "tool_result", name: "Read", text: "file contents" });
  });

  it("handles empty content gracefully", () => {
    const blocks = normalize([{ role: "user", content: "" } as any]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("user");
    expect(blocks[0].text).toBe("");
  });

  it("normalizes bashExecution into existing bash tool blocks", () => {
    const blocks = normalize([{
      role: "bashExecution",
      command: "npm test",
      output: "1 test failed",
      exitCode: 1,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
    } as any]);

    expect(blocks).toEqual([
      { kind: "tool_call", name: "bash", args: { command: "npm test" }, sourceIndex: 0 },
      { kind: "tool_result", name: "bash", text: "1 test failed", isError: true, sourceIndex: 0 },
    ]);
  });

  it("flattens assistant content blocks correctly", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "toolCall", name: "Read", arguments: { file_path: "auth.ts" } },
      ],
    };
    const blocks = normalize([msg as any]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "assistant", text: "Hello" });
    expect(blocks[1]).toMatchObject({ kind: "tool_call", name: "Read" });
  });
});

describe("vccMessagesFromEntries", () => {
  it("includes message, custom message, and branch summary entries in order", () => {
    const messages = vccMessagesFromEntries([
      { type: "message", id: "a", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "normal" } },
      { type: "custom_message", id: "b", timestamp: "2026-01-01T00:00:01Z", content: "custom context", customType: "test" },
      { type: "custom_message", id: "c", timestamp: "2026-01-01T00:00:02Z", content: [{ type: "text", text: "structured custom context" }], customType: "test" },
      { type: "branch_summary", id: "d", timestamp: "2026-01-01T00:00:03Z", summary: "abandoned branch details" },
      { type: "custom", id: "e", timestamp: "2026-01-01T00:00:04Z", customType: "hybrid-memory.observation", data: {} },
      { type: "compaction", id: "f", timestamp: "2026-01-01T00:00:05Z", summary: "old compaction" },
    ]);

    expect(messages).toHaveLength(4);
    expect(messages.map((message: any) => message.content)).toEqual([
      "normal",
      "custom context",
      [{ type: "text", text: "structured custom context" }],
      "Branch summary:\nabandoned branch details",
    ]);
  });
});

// ── VCC Extractor ──

describe("extractGoals", () => {
  it("extracts a goal from a user message", () => {
    const blocks = normalize([{ role: "user", content: "Implement the login flow with JWT tokens" } as any]);
    const goals = extractGoals(blocks);
    expect(goals.length).toBeGreaterThan(0);
    expect(goals[0]).toContain("login");
  });

  it("detects scope changes", () => {
    const blocks = normalize([
      { role: "user", content: "Build the API" } as any,
      { role: "user", content: "Actually, let's switch to building the frontend first" } as any,
    ]);
    const goals = extractGoals(blocks);
    expect(goals.some((g) => g.toLowerCase().includes("frontend"))).toBe(true);
  });

  it("filters noise short responses", () => {
    const blocks = normalize([{ role: "user", content: "ok" } as any]);
    const goals = extractGoals(blocks);
    expect(goals.length).toBe(0);
  });
});

describe("extractFiles", () => {
  it("extracts read files from tool calls", () => {
    const blocks = normalize([
      { role: "assistant", content: [{ type: "toolCall", name: "Read", arguments: { file_path: "src/auth.ts" } }] } as any,
    ]);
    const files = extractFiles(blocks);
    expect(files.read.has("src/auth.ts")).toBe(true);
  });

  it("extracts modified files from Edit tool calls", () => {
    const blocks = normalize([
      { role: "assistant", content: [{ type: "toolCall", name: "Edit", arguments: { file_path: "src/auth.ts" } }] } as any,
    ]);
    const files = extractFiles(blocks);
    expect(files.modified.has("src/auth.ts")).toBe(true);
  });

  it("extracts created files from Write tool calls", () => {
    const blocks = normalize([
      { role: "assistant", content: [{ type: "toolCall", name: "Write", arguments: { file_path: "src/new.ts" } }] } as any,
    ]);
    const files = extractFiles(blocks);
    expect(files.created.has("src/new.ts")).toBe(true);
  });

  it("matches modern file tools case-insensitively", () => {
    const blocks = normalize([
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", arguments: { path: "src/lower.ts" } },
          { type: "toolCall", name: "Quick_Edit", arguments: { path: "src/quick.ts" } },
          { type: "toolCall", name: "TARGET_EDIT", arguments: { filePath: "src/target.ts" } },
          { type: "toolCall", name: "apply_patch", arguments: { file: "src/patched.ts" } },
        ],
      } as any,
    ]);

    const files = extractFiles(blocks);

    expect(files.read.has("src/lower.ts")).toBe(true);
    expect(files.modified).toEqual(new Set(["src/quick.ts", "src/target.ts", "src/patched.ts"]));
  });

  it("merges Pi's authoritative file operations with extracted activity", () => {
    const files = extractFiles([], {
      read: new Set(["src/read.ts", "src/edited.ts"]),
      written: new Set(["src/new.ts"]),
      edited: new Set(["src/edited.ts"]),
    });

    expect(files.read).toEqual(new Set(["src/read.ts"]));
    expect(files.created).toEqual(new Set(["src/new.ts"]));
    expect(files.modified).toEqual(new Set(["src/edited.ts"]));
  });
});

describe("extractCommits", () => {
  it("extracts commit message from git commit bash tool call", () => {
    const blocks = normalize([
      { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: 'git commit -m "fix: auth bug"' } }] } as any,
    ]);
    const commits = extractCommits(blocks);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("fix: auth bug");
  });
});

describe("extractPreferences", () => {
  it("extracts user preferences", () => {
    const blocks = normalize([
      { role: "user", content: "I prefer TypeScript over JavaScript for all new files" } as any,
    ]);
    const prefs = extractPreferences(blocks);
    expect(prefs.length).toBeGreaterThan(0);
    expect(prefs[0].toLowerCase()).toContain("prefer");
  });
});

describe("extractOutstandingContext", () => {
  it("extracts tool errors", () => {
    const blocks = normalize([
      { role: "toolResult", toolName: "bash", content: "Error: file not found", isError: true } as any,
    ]);
    const context = extractOutstandingContext(blocks);
    expect(context.length).toBeGreaterThan(0);
  });
});

// ── VCC Transcript ──

describe("buildBriefSections", () => {
  it("creates sections from user and assistant blocks", () => {
    const blocks = normalize([
      { role: "user", content: "Fix the auth bug" } as any,
      { role: "assistant", content: "Looking at auth.ts now" } as any,
    ]);
    const sections = buildBriefSections(blocks);
    expect(sections.length).toBeGreaterThan(0);
  });

  it("caps total lines to maxLines", () => {
    const blocks: any[] = [];
    for (let i = 0; i < 50; i++) {
      blocks.push({ role: "user", content: `Task ${i}: do something important` });
      blocks.push({ role: "assistant", content: `Working on task ${i}` });
    }
    const normalized = blocks.map((m) => normalize([m])[0]);
    const sections = buildBriefSections(normalized, 20);
    const totalLines = sections.reduce((s, sec) => s + 1 + sec.lines.length, 0);
    expect(totalLines).toBeLessThanOrEqual(20);
  });
});

describe("stringifyBrief", () => {
  it("produces non-empty string from sections", () => {
    const sections = [
      { header: "[user]", lines: ["Fix the auth bug (#0)"] },
      { header: "[assistant]", lines: ["Looking at auth.ts now (#1)"] },
    ];
    const text = stringifyBrief(sections);
    expect(text).toContain("[user]");
    expect(text).toContain("Fix the auth bug");
  });
});

describe("capBrief", () => {
  it("truncates to maxLines", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `[user] line ${i}`);
    const input = lines.join("\n");
    const result = capBrief(input, 50);
    const resultLines = result.split("\n");
    expect(resultLines.length).toBeLessThanOrEqual(52); // 50 content + omission line + blank
    expect(result).toContain("earlier lines omitted");
  });
});

// ── VCC Formatter ──

describe("formatFileActivity", () => {
  it("applies maxFiles as one total priority-ordered budget", () => {
    const lines = formatFileActivity({
      modified: new Set(["m1", "m2"]),
      created: new Set(["c1", "c2"]),
      read: new Set(["r1", "r2"]),
    }, 4);

    expect(lines).toEqual(["Modified: m1, m2", "Created: c1, c2"]);
  });
});

describe("formatVccSections", () => {
  it("produces a formatted summary with sections", () => {
    const data = {
      sessionGoal: ["Fix the auth bug"],
      filesAndChanges: ["Modified: auth.ts"],
      commits: ["abc1234: fix: auth bug"],
      outstandingContext: [],
      userPreferences: ["Prefer TypeScript"],
      briefTranscript: "[user]\nFix the auth bug",
      transcriptEntries: [],
    };
    const summary = formatVccSections(data);
    expect(summary).toContain("[Session Goal]");
    expect(summary).toContain("[Files And Changes]");
    expect(summary).toContain("[Commits]");
    expect(summary).toContain("[User Preferences]");
  });

  it("returns empty string for empty data", () => {
    const data = {
      sessionGoal: [],
      filesAndChanges: [],
      commits: [],
      outstandingContext: [],
      userPreferences: [],
      briefTranscript: "",
      transcriptEntries: [],
    };
    expect(formatVccSections(data)).toBe("");
  });
});

// ── VCC Merger ──

describe("mergeVccSummaries", () => {
  it("returns fresh summary when no previous", () => {
    const result = mergeVccSummaries(undefined, "[Session Goal]\n- Fix auth");
    expect(result).toBe("[Session Goal]\n- Fix auth");
  });

  it("merges file sections with dedup", () => {
    const prev = "[Files And Changes]\n- Modified: auth.ts\n- Read: utils.ts";
    const fresh = "[Files And Changes]\n- Modified: auth.ts\n- Created: new.ts";
    const result = mergeVccSummaries(prev, fresh);
    expect(result).toContain("auth.ts");
    expect(result).toContain("utils.ts");
    expect(result).toContain("new.ts");
  });

  it("keeps maxFiles effective across VCC merge cycles", () => {
    const prev = "[Files And Changes]\n- Modified: m1, m2\n- Read: r1, r2";
    const fresh = "[Files And Changes]\n- Created: c1, c2";

    const result = mergeVccSummaries(prev, fresh, 120, 4);
    const fileNames = result.match(/\b[mcr]\d\b/g) ?? [];

    expect(fileNames).toHaveLength(4);
    expect(result).toContain("m1");
    expect(result).toContain("m2");
  });

  it("clears outstanding context (volatile)", () => {
    const prev = "[Outstanding Context]\n- Old blocker";
    const fresh = "[Outstanding Context]\n- New blocker";
    const result = mergeVccSummaries(prev, fresh);
    expect(result).toContain("New blocker");
    expect(result).not.toContain("Old blocker");
  });

  it("bounds merged brief history and favors fresh lines", () => {
    const prev = `[Session Goal]\n- Preserve goal\n\n---\n\n[user]\nold one\nold two\nold three`;
    const fresh = `[Session Goal]\n- Preserve goal\n\n---\n\n[user]\nfresh one\nfresh two`;

    const result = mergeVccSummaries(prev, fresh, 3);

    expect(result).toContain("fresh one");
    expect(result).toContain("fresh two");
    expect(result).not.toContain("old one");
    expect(result.split("---")[1].trim().split("\n").length).toBeLessThanOrEqual(3);
  });
});

// ── OM Tokens ──

describe("estimateStringTokens", () => {
  it("uses Pi's conservative characters-per-token estimate", () => {
    expect(estimateStringTokens("hello world")).toBe(3);
    expect(estimateStringTokens("a".repeat(100_000))).toBe(25_000);
    expect(estimateStringTokens("你好世界".repeat(1_000))).toBe(1_000);
  });

  it("returns 0 for empty string", () => {
    expect(estimateStringTokens("")).toBe(0);
  });
});

// ── OM Relevance ──

describe("countByRelevance", () => {
  it("counts observations by relevance level", () => {
    const observations = [
      { id: "1", content: "a", timestamp: "now", relevance: "low" as const },
      { id: "2", content: "b", timestamp: "now", relevance: "high" as const },
      { id: "3", content: "c", timestamp: "now", relevance: "high" as const },
    ];
    const histogram = countByRelevance(observations);
    expect(histogram.low).toBe(1);
    expect(histogram.high).toBe(2);
    expect(histogram.medium).toBe(0);
    expect(histogram.critical).toBe(0);
  });
});

describe("formatRelevanceHistogram", () => {
  it("formats a histogram string", () => {
    const histogram = { low: 2, medium: 1, high: 3, critical: 0 };
    const formatted = formatRelevanceHistogram(histogram as any);
    expect(formatted).toContain("2");
    expect(formatted).toContain("1");
    expect(formatted).toContain("3");
  });

  it("returns (none) for empty histogram", () => {
    const histogram = { low: 0, medium: 0, high: 0, critical: 0 };
    expect(formatRelevanceHistogram(histogram as any)).toBe("(none)");
  });
});

// ── Merge Pipeline ──

describe("mergePipelines", () => {
  it("combines OM and VCC summaries", () => {
    const result = mergePipelines({
      observations: [
        { id: "obs1", content: "User wants auth flow", timestamp: "now", relevance: "high" as const },
      ],
      reflections: ["Auth should use JWT"],
      vccSummary: "[Session Goal]\n- Build auth",
      settings: { maxSummaryTokens: 16000 },
    });
    expect(result.summary).toContain("Memory");
    expect(result.summary).toContain("Session State");
    expect(result.summary).toContain("User wants auth flow");
    expect(result.summary).toContain("Build auth");
    expect(result.details.type).toBe("observational-memory");
    expect(result.details.version).toBe(4);
  });

  it("trims low-relevance observations when over budget", () => {
    const observations = Array.from({ length: 200 }, (_, i) => ({
      id: `obs${i.toString(16).padStart(3, "0")}`,
      content: `Observation ${i}: detailed context about the implementation decisions and tradeoffs discussed for topic number ${i} in the conversation`,
      timestamp: "now",
      relevance: i < 100 ? ("low" as const) : ("critical" as const),
    }));

    const result = mergePipelines({
      observations,
      reflections: ["Important insight about architecture"],
      vccSummary: "[Session Goal]\n- Build everything with proper architecture and testing",
      settings: { maxSummaryTokens: 500 },
    });

    expect(result.trimmed).toBe(true);
    expect(result.protectedOverflow).toBe(true);
    // Projection trimming never retires durable observations.
    expect(result.details.observations).toEqual(observations);
    const lowObsIds = observations.filter(o => o.relevance === "low").map(o => o.id);
    expect(lowObsIds.some(id => result.summary.includes(id))).toBe(false);
  });

  it("trims stale VCC transcript before low-relevance observations", () => {
    const result = mergePipelines({
      observations: [
        { id: "low-observation", content: "useful semantic fact that should survive stale transcript pressure", timestamp: "now", relevance: "low" as const },
      ],
      reflections: [],
      vccSummary: `[Session Goal]\n- Original durable goal\n\n---\n\n[user]\n${"old transcript detail ".repeat(400)}`,
      settings: { maxSummaryTokens: 120 },
    });

    expect(result.trimmed).toBe(true);
    expect(result.protectedOverflow).toBe(false);
    expect(result.tokenCount).toBeLessThanOrEqual(120);
    expect(result.details.observations.map(o => o.id)).toContain("low-observation");
    expect(result.summary).not.toContain("old transcript detail");
    expect(result.summary).toContain("Original durable goal");
  });

  it("preserves unfamiliar structural sections as protected passthrough", () => {
    const result = mergePipelines({
      observations: [],
      reflections: [],
      vccSummary: "[Session Goal]\n- Known goal\n\n[Future Section]\n- New structural fact",
      settings: { maxSummaryTokens: 16000 },
    });

    expect(result.summary).toContain("[Future Section]");
    expect(result.summary).toContain("New structural fact");
  });

  it("trims lower-priority observations before high relevance", () => {
    const observations = [
      { id: "low-old", content: "low ".repeat(120), timestamp: "1", relevance: "low" as const },
      { id: "medium-old", content: "medium ".repeat(120), timestamp: "2", relevance: "medium" as const },
      { id: "high-new", content: "high-value fact", timestamp: "3", relevance: "high" as const },
    ];
    const result = mergePipelines({
      observations,
      reflections: [],
      vccSummary: "[Session Goal]\n- Keep original goal",
      settings: { maxSummaryTokens: 100 },
    });

    expect(result.tokenCount).toBeLessThanOrEqual(100);
    expect(result.details.observations).toEqual(observations);
    expect(result.summary).not.toContain("low-old");
    expect(result.summary).not.toContain("medium-old");
    expect(result.summary).toContain("high-new");
  });

  it("does not trim when under budget", () => {
    const result = mergePipelines({
      observations: [
        { id: "obs1", content: "Important fact", timestamp: "now", relevance: "critical" as const },
      ],
      reflections: [],
      vccSummary: "[Session Goal]\n- Do something",
      settings: { maxSummaryTokens: 16000 },
    });
    expect(result.trimmed).toBe(false);
    expect(result.protectedOverflow).toBe(false);
    expect(result.details.observations.length).toBe(1);
  });
});
