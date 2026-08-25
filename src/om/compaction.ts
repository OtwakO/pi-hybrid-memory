// Reflection synthesis and memory rendering.
import { completeSimple, type Context, type Message, type Model } from "@mariozechner/pi-ai";
import type {
  CacheOperation,
  CacheTelemetry,
  MemoryLifecycleOutcome,
} from "../cache-telemetry.js";
import type { CacheOptions } from "../cache-options.js";
import type { MemoryReflection, ObservationRecord } from "../types.js";
import { estimateStringTokens } from "./tokens.js";
import { REFLECTOR_PROMPT, REFLECTOR_SYSTEM } from "./prompts.js";
import { observationsToPromptLines } from "./observer.js";

export const reflectionContent = (reflection: MemoryReflection): string =>
  typeof reflection === "string" ? reflection : reflection.content;

export type ObservationCoverageTag = "uncited" | "cited" | "reinforced";

/** Count how many provenance-backed reflections cite each observation. */
export function deriveCoverageTags(
  reflections: MemoryReflection[],
  observations: ObservationRecord[],
): Map<string, ObservationCoverageTag> {
  const activeIds = new Set(observations.map((observation) => observation.id));
  const counts = new Map<string, number>();
  for (const observation of observations) counts.set(observation.id, 0);

  for (const reflection of reflections) {
    if (typeof reflection === "string" || reflection.legacy) continue;
    const cited = reflection.supportingObservationIds.filter((id) => activeIds.has(id));
    for (const id of cited) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const tags = new Map<string, ObservationCoverageTag>();
  for (const observation of observations) {
    const count = counts.get(observation.id) ?? 0;
    tags.set(observation.id, count === 0 ? "uncited" : count >= 4 ? "reinforced" : "cited");
  }
  return tags;
}

let idCounter = 0;

const makeId = (): string => {
  idCounter++;
  return `${Date.now().toString(36).slice(-8)}${idCounter.toString(36).padStart(4, "0")}`;
};

export interface ReflectorParams {
  model: unknown;
  apiKey: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  telemetry?: CacheTelemetry;
  cacheOptions?: CacheOptions;
}

const extractTextFromAssistantMessage = (message: unknown): string => {
  if (!message || typeof message !== "object") return "";
  const candidate = message as Record<string, unknown>;
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return "";
  return candidate.content
    .filter((part): part is Record<string, unknown> =>
      Boolean(part) && typeof part === "object" && part.type === "text")
    .map((part) => (part as Record<string, string>).text ?? "")
    .join("\n");
};

const extractJsonFromText = (text: string): string | null => {
  try {
    JSON.parse(text);
    return text;
  } catch {
    // Try compatibility formats used by older prompts/providers.
  }
  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlock) {
    try {
      JSON.parse(codeBlock[1].trim());
      return codeBlock[1].trim();
    } catch {
      // Continue to object extraction.
    }
  }
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (!objectMatch) return null;
  try {
    JSON.parse(objectMatch[0]);
    return objectMatch[0];
  } catch {
    return null;
  }
};

export type ReflectorFailureReason =
  | "truncated-output"
  | "invalid-output"
  | "invalid-provenance"
  | "error"
  | "aborted";

export type ReflectorResult =
  | {
      ok: true;
      outcome: "success" | "deliberate-empty";
      reflections: MemoryReflection[];
      proposedItems: number;
      acceptedItems: number;
    }
  | {
      ok: false;
      reason: ReflectorFailureReason;
    };

type ModelCallResult =
  | { ok: true; json: string }
  | { ok: false; reason: Exclude<ReflectorFailureReason, "invalid-provenance"> };

const callModel = async (
  params: ReflectorParams,
  operation: Extract<CacheOperation, "reflector">,
  systemPrompt: string,
  userPrompt: string,
): Promise<ModelCallResult> => {
  const context: Context = {
    systemPrompt,
    messages: [{ role: "user", content: userPrompt, timestamp: Date.now() } as Message],
  };
  try {
    const response = await completeSimple(
      params.model as Parameters<typeof completeSimple>[0],
      context,
      {
        apiKey: params.apiKey,
        headers: params.headers,
        signal: params.signal,
        sessionId: params.cacheOptions?.sessionId,
        cacheRetention: params.cacheOptions?.cacheRetention,
      },
    );
    const callOutcome = response.stopReason === "error" ? "error"
      : response.stopReason === "aborted" ? "aborted"
        : response.stopReason === "length" ? "truncated"
          : "success";
    params.telemetry?.record(operation, params.model as Model<any>, callOutcome, response.usage);

    if (callOutcome === "error" || callOutcome === "aborted") {
      return { ok: false, reason: callOutcome };
    }
    if (callOutcome === "truncated") return { ok: false, reason: "truncated-output" };

    const text = extractTextFromAssistantMessage(response);
    if (!text) return { ok: false, reason: "invalid-output" };
    const json = extractJsonFromText(text);
    return json ? { ok: true, json } : { ok: false, reason: "invalid-output" };
  } catch {
    return { ok: false, reason: "error" };
  }
};

const recordReflectorFailure = (
  params: ReflectorParams,
  reason: ReflectorFailureReason,
  inputItems: number,
  inputTokens: number,
  proposedItems = 0,
): ReflectorResult => {
  params.telemetry?.recordMemoryLifecycle(
    "reflector",
    reason as MemoryLifecycleOutcome,
    { inputItems, inputTokens, proposedItems, acceptedItems: 0 },
  );
  return { ok: false, reason };
};

const normalizedReflectionKey = (content: string): string => content.trim().replace(/\s+/g, " ");

export const runReflector = async (
  params: ReflectorParams,
  reflections: MemoryReflection[],
  observations: ObservationRecord[],
): Promise<ReflectorResult> => {
  const inputTokens = observations.reduce(
    (sum, observation) => sum + estimateStringTokens(observation.content),
    0,
  );
  const modelResult = await callModel(
    params,
    "reflector",
    REFLECTOR_SYSTEM,
    REFLECTOR_PROMPT(reflections, observations),
  );
  if (!modelResult.ok) {
    return recordReflectorFailure(params, modelResult.reason, observations.length, inputTokens);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(modelResult.json) as Record<string, unknown>;
  } catch {
    return recordReflectorFailure(params, "invalid-output", observations.length, inputTokens);
  }

  const proposed = parsed.reflections;
  if (!Array.isArray(proposed)) {
    return recordReflectorFailure(params, "invalid-output", observations.length, inputTokens);
  }

  const activeObservationIds = new Set(observations.map((observation) => observation.id));
  const validated: Array<{ content: string; supportingObservationIds: string[] }> = [];
  for (const candidate of proposed) {
    if (!candidate || typeof candidate !== "object") {
      return recordReflectorFailure(params, "invalid-output", observations.length, inputTokens, proposed.length);
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.content !== "string" || !record.content.trim()) {
      return recordReflectorFailure(params, "invalid-output", observations.length, inputTokens, proposed.length);
    }
    if (!Array.isArray(record.supportingObservationIds)) {
      return recordReflectorFailure(params, "invalid-provenance", observations.length, inputTokens, proposed.length);
    }
    const supportingIds = record.supportingObservationIds;
    if (
      supportingIds.length === 0
      || supportingIds.some((id) => typeof id !== "string" || !activeObservationIds.has(id))
      || new Set(supportingIds).size !== supportingIds.length
    ) {
      return recordReflectorFailure(params, "invalid-provenance", observations.length, inputTokens, proposed.length);
    }
    validated.push({
      content: record.content.trim(),
      supportingObservationIds: [...supportingIds] as string[],
    });
  }

  const merged: MemoryReflection[] = [...reflections];
  const contentIndex = new Map<string, number>();
  for (let index = 0; index < reflections.length; index++) {
    contentIndex.set(normalizedReflectionKey(reflectionContent(reflections[index])), index);
  }

  let acceptedItems = 0;
  for (const candidate of validated) {
    const key = normalizedReflectionKey(candidate.content);
    const existingIndex = contentIndex.get(key);
    if (existingIndex === undefined) {
      merged.push({
        id: makeId(),
        content: candidate.content,
        supportingObservationIds: candidate.supportingObservationIds,
      });
      contentIndex.set(key, merged.length - 1);
      acceptedItems++;
      continue;
    }

    const existing = merged[existingIndex];
    if (typeof existing === "string") {
      merged[existingIndex] = {
        id: makeId(),
        content: candidate.content,
        supportingObservationIds: candidate.supportingObservationIds,
        legacy: true,
      };
      acceptedItems++;
      continue;
    }

    const supportingObservationIds = [
      ...new Set([...existing.supportingObservationIds, ...candidate.supportingObservationIds]),
    ];
    if (supportingObservationIds.length !== existing.supportingObservationIds.length) {
      merged[existingIndex] = { ...existing, supportingObservationIds };
      acceptedItems++;
    }
  }

  const outcome = proposed.length === 0 ? "deliberate-empty" : "success";
  params.telemetry?.recordMemoryLifecycle("reflector", outcome, {
    inputItems: observations.length,
    inputTokens,
    proposedItems: proposed.length,
    acceptedItems,
  });
  return {
    ok: true,
    outcome,
    reflections: merged,
    proposedItems: proposed.length,
    acceptedItems,
  };
};

export const renderSummary = (
  reflections: MemoryReflection[],
  observations: ObservationRecord[],
): string => {
  const parts: string[] = [];
  if (reflections.length > 0) {
    parts.push("Reflections:");
    for (const reflection of reflections) {
      if (typeof reflection === "string") parts.push(`- ${reflection}`);
      else parts.push(`- [${reflection.id}] ${reflection.content}`);
    }
  }
  if (observations.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("Observations:");
    parts.push(observationsToPromptLines(observations).join("\n"));
  }
  return parts.join("\n");
};
