// HM-Recall tool: retrieves memory evidence by ID — ported from pi-observational-memory
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import type { Entry, ObservationRecord, ReflectionRecord, MemoryReflection } from "../types.js";
import { OBSERVATION_CUSTOM_TYPE, MEMORY_ID_PATTERN } from "../types.js";
import { estimateEntryTokens } from "../om/tokens.js";

const isObservationEntry = (entry: Entry): boolean =>
  entry.type === "custom" && entry.customType === OBSERVATION_CUSTOM_TYPE;

const isObservationEntryData = (v: unknown): v is { records: ObservationRecord[] } =>
  !!v && typeof v === "object" && "records" in v && Array.isArray((v as Record<string, unknown>).records);

interface MatchDetails {
  status: "ok" | "no_source" | "source_unavailable" | "not_found" | "invalid_id";
  memoryId: string;
  observations: Array<{ id: string; content: string; timestamp: string; relevance: string }>;
  reflections: Array<{ id: string; content: string }>;
  sourceEntries: Array<{ id: string; origin: string; timestamp: string; tokens: number }>;
  missingSourceIds: string[];
  message?: string;
}

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

const collectAllObservations = (entries: Entry[]): Map<string, ObservationRecord> => {
  const map = new Map<string, ObservationRecord>();
  for (const entry of entries) {
    if (!isObservationEntry(entry)) continue;
    if (!isObservationEntryData(entry.data)) continue;
    for (const record of entry.data.records) {
      map.set(record.id, record);
    }
  }
  return map;
};

const collectAllReflections = (entries: Entry[]): MemoryReflection[] => {
  const reflections: MemoryReflection[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction" && entry.details) {
      const details = entry.details as Record<string, unknown>;
      if (details.type === "observational-memory" && Array.isArray(details.reflections)) {
        reflections.push(...(details.reflections as MemoryReflection[]));
      }
    }
  }
  return reflections;
};

const findReflectionById = (reflections: MemoryReflection[], id: string): ReflectionRecord | undefined => {
  for (const r of reflections) {
    if (typeof r === "object" && "id" in r && r.id === id) return r as ReflectionRecord;
  }
  return undefined;
};

const textResult = (text: string, details: MatchDetails) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const emptyDetails = (status: MatchDetails["status"], memoryId: string, message: string): MatchDetails => ({
  status, memoryId, observations: [], reflections: [], sourceEntries: [], missingSourceIds: [], message,
});

export const registerRecallTool = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: "hm-recall",
    label: "Hybrid memory recall",
    description:
      "Recover exact evidence and source context behind a compacted hybrid-memory observation or reflection id. " +
      "Use when compressed memory is important and original source context is needed.",
    promptSnippet: "Use hm-recall(<id>) to recover exact source context behind compacted memory when precision matters.",
    parameters: Type.Object({
      id: Type.String({
        pattern: "^[a-f0-9]{12}$",
        description: "12-character lowercase hex observation or reflection id shown in compacted memory or a previous recall result.",
      }),
    }) as any,
    renderCall(args: Record<string, unknown>) {
      return new Text(`recall ${(args.id as string) ?? "..."}`, 0, 0);
    },
    renderResult(result, options) {
      const details = result.details as MatchDetails | undefined;
      if (!details) {
        const text = result.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n");
        return new Text(text || "hm-recall", 0, 0);
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

      if (details.sourceEntries.length > 0) {
        lines.push("", "Sources:");
        for (const s of details.sourceEntries) {
          lines.push(`  [${s.id}] ${s.origin} @ ${s.timestamp} (~${s.tokens} tokens)`);
        }
      }

      if (details.missingSourceIds.length > 0) {
        lines.push("", `Missing source entries: ${details.missingSourceIds.join(", ")}`);
      }

      if (details.message && details.status !== "ok") {
        lines.push("", details.message);
      }

      return new Text(lines.join("\n"), 0, 0);
    },
    async execute(_toolCallId, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      const memoryId = typeof params.id === "string" ? params.id : String(params.id ?? "");
      if (!MEMORY_ID_PATTERN.test(memoryId)) {
        const message = `Memory id must be 12 lowercase hex characters. Received: ${memoryId}`;
        return textResult(message, emptyDetails("invalid_id", memoryId, message));
      }

      const entries = ctx.sessionManager.getBranch() as Entry[];
      const allObs = collectAllObservations(entries);
      const allReflections = collectAllReflections(entries);

      // Check if it's an observation id
      const observation = allObs.get(memoryId);
      if (observation) {
        const sourceEntries: Entry[] = [];
        const missingSourceIds: string[] = [];
        if (observation.sourceEntryIds && observation.sourceEntryIds.length > 0) {
          const entryMap = new Map(entries.map((e) => [e.id, e]));
          for (const sid of observation.sourceEntryIds) {
            const entry = entryMap.get(sid);
            if (entry) sourceEntries.push(entry);
            else missingSourceIds.push(sid);
          }
        }

        const sourceDetails = sourceEntries.map((e) => ({
          id: e.id,
          origin: sourceOrigin(e),
          timestamp: formatTimestamp(e.timestamp),
          tokens: estimateEntryTokens(e),
        }));

        const status: MatchDetails["status"] = missingSourceIds.length > 0 ? "source_unavailable" : sourceEntries.length > 0 ? "ok" : "no_source";

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
        };

        const text = sourceEntries.length > 0
          ? `Observation ${memoryId}:\n${observation.content}\n\nSources:\n${sourceDetails.map((s) => `[${s.id}] ${s.origin} @ ${s.timestamp}`).join("\n")}`
          : `Observation ${memoryId}:\n${observation.content}\n\nNo source entries available.`;

        return textResult(text, details);
      }

      // Check if it's a reflection id
      const reflection = findReflectionById(allReflections, memoryId);
      if (reflection) {
        const details: MatchDetails = {
          status: "ok",
          memoryId,
          observations: [],
          reflections: [{
            id: reflection.id,
            content: reflection.content,
          }],
          sourceEntries: [],
          missingSourceIds: [],
        };

        const text = `Reflection ${memoryId}:\n${reflection.content}`;
        return textResult(text, details);
      }

      const message = `No observation or reflection with id ${memoryId} was found on the current branch.`;
      return textResult(message, emptyDetails("not_found", memoryId, message));
    },
  });
};
