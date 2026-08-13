// Reflector and pruner: LLM-based reflection synthesis and observation pruning
import { completeSimple, type Context, type Message } from "@mariozechner/pi-ai";
import type { MemoryReflection, ObservationRecord, Relevance } from "../types.js";
import {
  PRUNER_PROMPT,
  PRUNER_SYSTEM,
  REFLECTOR_PROMPT,
  REFLECTOR_SYSTEM,
} from "./prompts.js";
import { observationsToPromptLines } from "./observer.js";

import { estimateStringTokens } from "./tokens.js";

export const reflectionContent = (r: MemoryReflection): string =>
  typeof r === "string" ? r : r.content;

export type ObservationCoverageTag = "uncited" | "cited" | "reinforced";

/** Count how many provenance-backed reflections cite each observation */
export function deriveCoverageTags(
  reflections: MemoryReflection[],
  observations: ObservationRecord[],
): Map<string, ObservationCoverageTag> {
  const activeIds = new Set(observations.map((o) => o.id));
  const counts = new Map<string, number>();
  for (const o of observations) counts.set(o.id, 0);

  for (const reflection of reflections) {
    if (typeof reflection === "string" || reflection.legacy) continue;
    const cited = reflection.supportingObservationIds.filter((id) => activeIds.has(id));
    for (const id of cited) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const tags = new Map<string, ObservationCoverageTag>();
  for (const o of observations) {
    const c = counts.get(o.id) ?? 0;
    tags.set(o.id, c === 0 ? "uncited" : c >= 4 ? "reinforced" : "cited");
  }
  return tags;
}

/** Render observations for pruner prompt with coverage tags */
export function renderObservationsWithCoverage(
  observations: ObservationRecord[],
  tags: ReadonlyMap<string, ObservationCoverageTag>,
): string {
  if (observations.length === 0) return "(none yet)";
  return observations
    .map((o) => `[${o.id}] ${o.timestamp} [${o.relevance}] [coverage: ${tags.get(o.id) ?? "uncited"}] ${o.content}`)
    .join("\n");
}

let idCounter = 0;

const makeId = (): string => {
  idCounter++;
  return `${Date.now().toString(36).slice(-8)}${idCounter.toString(36).padStart(4, "0")}`;
};

type ModelParams = { model: unknown; apiKey: string; headers?: Record<string, string>; signal?: AbortSignal };

const extractTextFromAssistantMessage = (msg: unknown): string => {
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p): p is Record<string, unknown> => p && typeof p === "object" && p.type === "text")
      .map((p) => (p as Record<string, string>).text ?? "")
      .join("\n");
  }
  return "";
};

const extractJsonFromText = (text: string): string | null => {
  try { JSON.parse(text); return text; } catch { /* not valid JSON */ }
  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlock) {
    try { JSON.parse(codeBlock[1].trim()); return codeBlock[1].trim(); } catch { /* not valid JSON */ }
  }
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { JSON.parse(objMatch[0]); return objMatch[0]; } catch { /* not valid JSON */ }
  }
  return null;
};

const callModel = async (params: ModelParams, systemPrompt: string, userPrompt: string): Promise<string | null> => {
  const context: Context = {
    systemPrompt,
    messages: [{ role: "user", content: userPrompt, timestamp: Date.now() } as Message],
  };
  try {
    const response = await completeSimple(
      params.model as Parameters<typeof completeSimple>[0],
      context,
      { apiKey: params.apiKey, headers: params.headers, signal: params.signal },
    );
    const text = extractTextFromAssistantMessage(response);
    if (!text) return null;
    return extractJsonFromText(text);
  } catch {
    return null;
  }
};

export const runReflector = async (
  params: ModelParams,
  reflections: MemoryReflection[],
  observations: ObservationRecord[],
): Promise<MemoryReflection[]> => {
  const jsonStr = await callModel(params, REFLECTOR_SYSTEM, REFLECTOR_PROMPT(reflections, observations));
  if (!jsonStr) return reflections;

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const newReflections = parsed.reflections;
    if (!Array.isArray(newReflections)) return reflections;

    // Build content-to-index map for dedup/strengthening
    const contentIndex = new Map<string, number>();
    for (let i = 0; i < reflections.length; i++) {
      contentIndex.set(reflectionContent(reflections[i]).trim().replace(/\s+/g, " "), i);
    }

    const merged: MemoryReflection[] = [...reflections];
    for (const ref of newReflections) {
      if (!ref || typeof ref !== "object") continue;
      const r = ref as Record<string, unknown>;
      if (typeof r.content !== "string" || !r.content.trim()) continue;
      const content = r.content.trim();
      const supportingIds = Array.isArray(r.supportingObservationIds)
        ? (r.supportingObservationIds as unknown[]).filter((id): id is string => typeof id === "string")
        : [];

      if (supportingIds.length === 0) continue; // reflection without provenance — skip

      // Strengthen: if content matches existing, merge supporting ids
      const key = content.replace(/\s+/g, " ");
      const existingIdx = contentIndex.get(key);
      if (existingIdx !== undefined) {
        const existing = merged[existingIdx];
        if (typeof existing !== "string") {
          const newIds = new Set([...existing.supportingObservationIds, ...supportingIds]);
          merged[existingIdx] = { ...existing, supportingObservationIds: [...newIds] };
        } else {
          // Promote legacy string reflection to structured
          merged[existingIdx] = { id: makeId(), content, supportingObservationIds: supportingIds, legacy: true };
        }
      } else {
        merged.push({ id: makeId(), content, supportingObservationIds: supportingIds });
        contentIndex.set(key, merged.length - 1);
      }
    }
    return merged;
  } catch {
    return reflections;
  }
};

export const runPruner = async (
  params: ModelParams,
  reflections: MemoryReflection[],
  observations: ObservationRecord[],
  _threshold: number,
  coverageTags?: ReadonlyMap<string, ObservationCoverageTag>,
): Promise<{ observations: ObservationRecord[]; fellBack: boolean }> => {
  const obsText = coverageTags
    ? renderObservationsWithCoverage(observations, coverageTags)
    : observationsToPromptLines(observations).join("\n");

  const jsonStr = await callModel(params, PRUNER_SYSTEM, PRUNER_PROMPT(reflections, observations, obsText));
  if (!jsonStr) return { observations, fellBack: true };

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const keepIds = parsed.observationsToKeep;
    if (!Array.isArray(keepIds)) return { observations, fellBack: true };

    const keepSet = new Set(keepIds.filter((id): id is string => typeof id === "string"));
    const kept = observations.filter((o) => keepSet.has(o.id));

    // Fallback: if LLM pruning didn't work, use coverage-aware fallback
    if (kept.length >= observations.length) {
      if (coverageTags) {
        // Keep uncited observations, drop cited first
        const uncited = observations.filter((o) => (coverageTags.get(o.id) ?? "uncited") === "uncited");
        const cited = observations.filter((o) => (coverageTags.get(o.id) ?? "uncited") !== "uncited");
        // Drop low-priority cited observations first
        const relevanceOrder: Relevance[] = ["low", "medium", "high", "critical"];
        const toDrop = cited.filter((o) => o.relevance === "low" || o.relevance === "medium");
        if (toDrop.length > 0) {
          const dropIds = new Set(toDrop.map((o) => o.id));
          return { observations: [...uncited, ...cited.filter((o) => !dropIds.has(o.id))], fellBack: false };
        }
      }
      // Last resort: drop low relevance
      const relevanceOrder: Relevance[] = ["low", "medium", "high", "critical"];
      const sorted = [...observations].sort((a, b) =>
        relevanceOrder.indexOf(a.relevance) - relevanceOrder.indexOf(b.relevance)
      );
      const filtered = sorted.filter((o) => o.relevance === "high" || o.relevance === "critical");
      if (filtered.length < sorted.length) return { observations: filtered, fellBack: false };
    }

    return { observations: kept, fellBack: false };
  } catch {
    return { observations, fellBack: true };
  }
};

export const renderSummary = (reflections: MemoryReflection[], observations: ObservationRecord[]): string => {
  const parts: string[] = [];
  if (reflections.length > 0) {
    parts.push("Reflections:");
    for (const r of reflections) {
      if (typeof r === "string") parts.push(`- ${r}`);
      else parts.push(`- [${r.id}] ${r.content}`);
    }
  }
  if (observations.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("Observations:");
    parts.push(observationsToPromptLines(observations).join("\n"));
  }
  return parts.join("\n");
};
