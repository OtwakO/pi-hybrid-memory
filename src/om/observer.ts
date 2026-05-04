// OM Observer: LLM-based observation extraction
import { completeSimple, type Context, type Message } from "@mariozechner/pi-ai";
import type { ObservationRecord, Relevance } from "../types.js";
import { OBSERVER_PROMPT, OBSERVER_SYSTEM, OBSERVER_USER_PREFIX } from "./prompts.js";

const RELEVANCE_VALUES: readonly Relevance[] = ["low", "medium", "high", "critical"];

const sanitizeRelevance = (v: unknown): Relevance => {
  if (typeof v === "string" && RELEVANCE_VALUES.includes(v as Relevance)) return v as Relevance;
  return "medium";
};

let idCounter = 0;

const makeId = (): string => {
  idCounter++;
  return `${Date.now().toString(36).slice(-8)}${idCounter.toString(36).padStart(4, "0")}`;
};

export interface ObserverParams {
  model: unknown;
  apiKey: string;
  headers?: Record<string, string>;
  priorReflections: string[];
  priorObservations: string[];
  chunk: string;
  allowedSourceEntryIds: string[];
  signal?: AbortSignal;
}

export const runObserver = async (params: ObserverParams): Promise<ObservationRecord[]> => {
  const { model, apiKey, headers, priorReflections, priorObservations, chunk, signal } = params;

  const system = OBSERVER_SYSTEM;
  const user = OBSERVER_PROMPT(priorReflections, priorObservations) + "\n\n" + OBSERVER_USER_PREFIX + "\n\n" + chunk;

  const context: Context = {
    systemPrompt: system,
    messages: [{ role: "user", content: user, timestamp: Date.now() } as Message],
  };

  try {
    const response = await completeSimple(
      model as Parameters<typeof completeSimple>[0],
      context,
      {
        apiKey,
        headers,
        signal,
      },
    );

    const text = extractTextFromAssistantMessage(response);
    if (!text) return [];

    // Try to parse JSON from the response
    const jsonStr = extractJsonFromText(text);
    if (!jsonStr) return [];

    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const observations = parsed.observations;
    if (!Array.isArray(observations)) return [];

    const records: ObservationRecord[] = [];
    for (const obs of observations) {
      if (!obs || typeof obs !== "object") continue;
      const o = obs as Record<string, unknown>;
      if (typeof o.content !== "string" || !o.content.trim()) continue;
      records.push({
        id: makeId(),
        content: o.content.trim(),
        timestamp: new Date().toISOString(),
        relevance: sanitizeRelevance(o.relevance),
        sourceEntryIds: [...params.allowedSourceEntryIds],
      });
    }

    return records;
  } catch {
    return [];
  }
};

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
  // Try parsing the whole text as JSON first
  try {
    JSON.parse(text);
    return text;
  } catch { /* not valid JSON */ }

  // Try to find a JSON block
  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlock) {
    try {
      JSON.parse(codeBlock[1].trim());
      return codeBlock[1].trim();
    } catch { /* not valid JSON */ }
  }

  // Try to find a JSON object in the text
  const objMatch = text.match(/\{[\s\S]*"observations"[\s\S]*\}/);
  if (objMatch) {
    try {
      JSON.parse(objMatch[0]);
      return objMatch[0];
    } catch { /* not valid JSON */ }
  }

  return null;
};

export const observationsToPromptLines = (records: ObservationRecord[]): string[] =>
  records.map((r) => `[${r.id}] [${r.relevance}] ${r.content}`);
