// HM-Recall tool: retrieves memory evidence by ID — ported from pi-observational-memory
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Entry, ObservationRetirement, ReflectionSupersession } from "../types.js";
import { MEMORY_ID_PATTERN } from "../types.js";
import { buildBranchMemoryIndex } from "../om/branch-memory-index.js";
import { estimateEntryTokens } from "../om/tokens.js";

interface MatchDetails {
  status: "ok" | "no_source" | "source_unavailable" | "not_found" | "invalid_id";
  memoryId: string;
  observations: Array<{ id: string; content: string; timestamp: string; relevance: string }>;
  reflections: Array<{ id: string; content: string }>;
  sourceEntries: Array<{
    id: string;
    origin: string;
    timestamp: string;
    tokens: number;
    content?: string;
    contentTruncated?: boolean;
    contentOmitted?: boolean;
  }>;
  missingSourceIds: string[];
  missingObservationIds: string[];
  lifecycle?:
    | { state: "active" }
    | { state: "retired"; retirement: ObservationRetirement }
    | { state: "current" }
    | { state: "superseded"; supersession: ReflectionSupersession };
  message?: string;
}

const SOURCE_ENTRY_ID_PATTERN = /^[a-f0-9]{8}$/;
const RECALL_ID_PATTERN = /^(?:[a-f0-9]{8}|[a-z0-9]{12})$/;
const MAX_SOURCE_PREVIEW_CHARS = 1_200;
const MAX_TOTAL_SOURCE_PREVIEW_CHARS = 8_000;
const MAX_DIRECT_SOURCE_CHARS = 20_000;
const TRUNCATION_MARKER = "\n… [truncated]";

const pad = (n: number): string => n.toString().padStart(2, "0");
const fmtLocal = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const formatTimestamp = (v: number | string | undefined): string => {
  if (v === undefined) return "Unknown";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "Unknown" : fmtLocal(d);
};

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { text?: string } => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }
  return "";
};

const sourceOrigin = (entry: Entry): string => {
  if (entry.type === "message" && entry.message) {
    const msg = entry.message as { role?: string };
    if (msg.role === "user") return "User";
    if (msg.role === "assistant") return "Assistant";
    return "Tool result";
  }
  if (entry.type === "custom_message") return "Custom";
  if (entry.type === "branch_summary") return "Summary";
  return entry.type || "Entry";
};

const sourceContent = (entry: Entry): string => {
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    return textOf((entry.message as { content?: unknown }).content).trim();
  }
  if (entry.type === "custom_message") return textOf(entry.content).trim();
  if (entry.type === "branch_summary") return typeof entry.summary === "string" ? entry.summary.trim() : "";
  return "";
};

const truncateSourceContent = (content: string, maxChars: number): { content: string; truncated: boolean } => {
  if (content.length <= maxChars) return { content, truncated: false };
  if (maxChars <= TRUNCATION_MARKER.length) {
    return { content: TRUNCATION_MARKER.slice(0, maxChars), truncated: true };
  }
  return {
    content: content.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER,
    truncated: true,
  };
};

const fairContentAllocations = (needs: number[], totalBudget: number): number[] => {
  const allocations = new Array(needs.length).fill(0) as number[];
  let remaining = totalBudget;
  let active = needs.map((_, index) => index).filter((index) => needs[index] > 0);

  while (active.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / active.length);
    if (share === 0) {
      for (const index of active.slice(0, remaining)) allocations[index] += 1;
      break;
    }

    const satisfied = active.filter((index) => needs[index] <= share);
    if (satisfied.length > 0) {
      for (const index of satisfied) {
        allocations[index] = needs[index];
        remaining -= needs[index];
      }
      const satisfiedSet = new Set(satisfied);
      active = active.filter((index) => !satisfiedSet.has(index));
      continue;
    }

    for (const index of active) allocations[index] = share;
    remaining -= share * active.length;
    for (const index of active) {
      if (remaining === 0) break;
      if (allocations[index] < needs[index]) {
        allocations[index] += 1;
        remaining -= 1;
      }
    }
    break;
  }

  return allocations;
};

const sourceEntryDetails = (
  entries: Entry[],
  limits: { perSource: number; total: number } = {
    perSource: MAX_SOURCE_PREVIEW_CHARS,
    total: MAX_TOTAL_SOURCE_PREVIEW_CHARS,
  },
): MatchDetails["sourceEntries"] => {
  const rawContents = entries.map(sourceContent);
  const needs = rawContents.map((content) => Math.min(content.length, limits.perSource));
  const allocations = fairContentAllocations(needs, limits.total);

  return entries.map((entry, index) => {
    const details: MatchDetails["sourceEntries"][number] = {
      id: entry.id,
      origin: sourceOrigin(entry),
      timestamp: formatTimestamp(entry.timestamp),
      tokens: estimateEntryTokens(entry),
    };
    const rawContent = rawContents[index];
    if (!rawContent) return details;

    const allocation = allocations[index];
    if (allocation === 0) {
      details.contentOmitted = true;
      return details;
    }

    const excerpt = truncateSourceContent(rawContent, allocation);
    details.content = excerpt.content;
    if (excerpt.truncated) details.contentTruncated = true;
    return details;
  });
};

const renderSourceDetails = (
  sources: MatchDetails["sourceEntries"],
  includeTokenEstimate = false,
): string =>
  sources.map((source) => {
    const tokens = includeTokenEstimate ? ` (~${source.tokens} tokens)` : "";
    const header = `[${source.id}] ${source.origin} @ ${source.timestamp}${tokens}`;
    if (source.content) return `${header}\n${source.content}`;
    if (source.contentOmitted) return `${header}\n[session log omitted: recall text budget exhausted]`;
    return `${header}\n[no textual session log available]`;
  }).join("\n\n");


const textResult = (text: string, details: MatchDetails) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const emptyDetails = (status: MatchDetails["status"], memoryId: string, message: string): MatchDetails => ({
  status,
  memoryId,
  observations: [],
  reflections: [],
  sourceEntries: [],
  missingSourceIds: [],
  missingObservationIds: [],
  message,
});

export const registerRecallTool = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: "hm_recall",
    label: "Hybrid memory recall",
    description:
      "Use a 12-character memory id to recover an observation/reflection with bounded source previews, " +
      "or an 8-character source id to retrieve that exact Pi session entry.",
    promptSnippet: "Use hm_recall(<12-char memory id>) for memory evidence; use hm_recall(<8-char source id>) for the exact session entry when checking exact wording, paths, errors, and decisions.",
    parameters: Type.Object({
      id: Type.String({
        pattern: RECALL_ID_PATTERN.source,
        description: "A 12-character lowercase alphanumeric observation/reflection id, or an 8-character lowercase hex Pi source-entry id shown in Sources.",
      }),
    }),
    renderCall(args) {
      const id = args && typeof args === "object" && "id" in args
        ? String(args.id)
        : "...";
      return new Text(`recall ${id}`, 0, 0);
    },
    renderResult(result, _options) {
      const details = result.details as MatchDetails | undefined;
      if (!details) {
        const text = result.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n");
        return new Text(text || "hm_recall", 0, 0);
      }

      const lines: string[] = [];
      if (details.status === "ok" || details.status === "no_source" || details.status === "source_unavailable") {
        lines.push("✓ success");
      } else {
        lines.push("× failure");
      }

      if (details.reflections.length > 0) {
        lines.push("", "Reflections:");
        for (const r of details.reflections) {
          lines.push(`  [${r.id}] ${r.content}`);
        }
      }

      if (details.observations.length > 0) {
        lines.push("", "Observations:");
        for (const o of details.observations) {
          lines.push(`  [${o.id}] [${o.relevance}] ${o.timestamp} ${o.content}`);
        }
      }

      if (details.lifecycle?.state === "retired") {
        lines.push(
          "",
          `Lifecycle: retired (${details.lifecycle.retirement.reason}); preserved by ${details.lifecycle.retirement.preservedByObservationIds.join(", ")}`,
        );
      }

      if (details.lifecycle?.state === "superseded") {
        lines.push(
          "",
          `Lifecycle: superseded (${details.lifecycle.supersession.reason}) by ${details.lifecycle.supersession.supersededByReflectionId}`,
        );
      }

      if (details.sourceEntries.length > 0) {
        lines.push(
          "",
          "Sources (bounded chronological previews):",
          "  Use an 8-character source id with hm_recall to retrieve that exact entry.",
          "",
          ...renderSourceDetails(details.sourceEntries, true)
            .split("\n")
            .map((line) => `  ${line}`),
        );
      }

      if (details.missingObservationIds.length > 0) {
        lines.push("", `Missing supporting observations: ${details.missingObservationIds.join(", ")}`);
      }
      if (details.missingSourceIds.length > 0) {
        lines.push("", `Missing source entries: ${details.missingSourceIds.join(", ")}`);
      }

      if (details.message && details.status !== "ok") {
        lines.push("", details.message);
      }

      return new Text(lines.join("\n"), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const memoryId = params.id;
      if (!RECALL_ID_PATTERN.test(memoryId)) {
        const message = `Recall id must be a 12-character memory id or 8-character source id. Received: ${memoryId}.`;
        return textResult(message, emptyDetails("invalid_id", memoryId, message));
      }

      const entries = ctx.sessionManager.getBranch() as Entry[];
      const memoryIndex = buildBranchMemoryIndex(entries);
      if (SOURCE_ENTRY_ID_PATTERN.test(memoryId)) {
        const sourceEntry = memoryIndex.sourceEntryById(memoryId);
        if (!sourceEntry) {
          const message = `Source entry ${memoryId} is not available on the current branch.`;
          return textResult(message, emptyDetails("source_unavailable", memoryId, message));
        }

        const sourceDetails = sourceEntryDetails(
          [sourceEntry],
          { perSource: MAX_DIRECT_SOURCE_CHARS, total: MAX_DIRECT_SOURCE_CHARS },
        );
        const details: MatchDetails = {
          status: "ok",
          memoryId,
          observations: [],
          reflections: [],
          sourceEntries: sourceDetails,
          missingSourceIds: [],
          missingObservationIds: [],
        };
        return textResult(
          `Source entry ${memoryId}:\n\n${renderSourceDetails(sourceDetails)}`,
          details,
        );
      }

      if (!MEMORY_ID_PATTERN.test(memoryId)) {
        const message = `Memory id must be 12 lowercase alphanumeric characters. Received: ${memoryId}.`;
        return textResult(message, emptyDetails("invalid_id", memoryId, message));
      }

      const observation = memoryIndex.observationById(memoryId);
      if (observation) {
        const { entries: sourceEntries, missingIds: missingSourceIds } =
          memoryIndex.sourcesForObservation(memoryId);
        const sourceDetails = sourceEntryDetails(sourceEntries);

        const status: MatchDetails["status"] = missingSourceIds.length > 0 ? "source_unavailable" : sourceEntries.length > 0 ? "ok" : "no_source";

        const lifecycle = memoryIndex.observationLifecycle(memoryId);
        const details: MatchDetails = {
          status,
          memoryId,
          observations: [{
            id: observation.id,
            content: observation.content,
            timestamp: observation.timestamp,
            relevance: observation.relevance,
          }],
          reflections: [],
          sourceEntries: sourceDetails,
          missingSourceIds,
          missingObservationIds: [],
          lifecycle,
        };

        const lifecycleText = lifecycle?.state === "retired"
          ? `\n\nLifecycle: retired (${lifecycle.retirement.reason}); preserved by ${lifecycle.retirement.preservedByObservationIds.join(", ")}.`
          : "";
        const text = sourceEntries.length > 0
          ? `Observation ${memoryId}:\n${observation.content}${lifecycleText}\n\nSources (bounded chronological previews):\nUse an 8-character source id with hm_recall to retrieve that exact entry.\n\n${renderSourceDetails(sourceDetails)}`
          : `Observation ${memoryId}:\n${observation.content}${lifecycleText}\n\nNo source entries available.`;

        return textResult(text, details);
      }

      const reflection = memoryIndex.reflectionById(memoryId);
      if (reflection) {
        const evidence = memoryIndex.evidenceForReflection(memoryId);
        const sourceDetails = sourceEntryDetails(evidence.entries);
        const missingSourceIds = evidence.missingIds;
        const details: MatchDetails = {
          status: evidence.missingObservationIds.length > 0 || missingSourceIds.length > 0
            ? "source_unavailable"
            : "ok",
          memoryId,
          observations: evidence.observations.map(observation => ({
            id: observation.id,
            content: observation.content,
            timestamp: observation.timestamp,
            relevance: observation.relevance,
          })),
          reflections: [{ id: reflection.id, content: reflection.content }],
          sourceEntries: sourceDetails,
          missingSourceIds,
          missingObservationIds: evidence.missingObservationIds,
          lifecycle: memoryIndex.reflectionLifecycle(memoryId),
        };

        const lifecycle = memoryIndex.reflectionLifecycle(memoryId);
        const lifecycleText = lifecycle?.state === "superseded"
          ? `\n\nLifecycle: superseded (${lifecycle.supersession.reason}) by ${lifecycle.supersession.supersededByReflectionId}.`
          : "";
        const sections = [`Reflection ${memoryId}:\n${reflection.content}${lifecycleText}`];
        if (evidence.observations.length > 0) {
          sections.push(
            "Supporting observations:\n" + evidence.observations
              .map(observation => `[${observation.id}] [${observation.relevance}] ${observation.content}`)
              .join("\n"),
          );
        }
        if (sourceDetails.length > 0) {
          sections.push(
            "Sources (bounded chronological previews):\n" +
            "Use an 8-character source id with hm_recall to retrieve that exact entry.\n\n" +
            renderSourceDetails(sourceDetails),
          );
        }
        return textResult(sections.join("\n\n"), details);
      }

      const message = `No observation or reflection with id ${memoryId} was found on the current branch.`;
      return textResult(message, emptyDetails("not_found", memoryId, message));
    },
  });
};
