// Prompts for OM observer, reflector, and pruner — ported from pi-observational-memory
import type { MemoryReflection, ObservationRecord } from "../types.js";

export type Reflection = MemoryReflection;
export type Observation = ObservationRecord;

export const OBSERVER_SYSTEM =
  "You are an archival memory observer. You extract durable observations from a raw conversation log.\n" +
  "\n" +
  "OUTPUT FORMAT: You MUST respond with a single JSON object and NOTHING else. No preamble, no explanation, no markdown code fences.\n" +
  "The JSON must have this exact structure:\n" +
  '{\n  "observations": [\n    { "content": "one sentence observation", "relevance": "low|medium|high|critical" }\n  ]\n}\n' +
  "If you find no observations, return: { \"observations\": [] }\n" +
  "\n" +
  "Each observation must capture exactly one distinct piece of context that will be useful to an AI assistant " +
  "in a future session. Observations should be self-contained, specific, and free of vague references.";

export const OBSERVER_PROMPT = (
  priorReflections: string[],
  priorObservations: string[],
): string => {
  const lines = [
    "Extract observations from the conversation chunk below.",
    "",
    "Rules:",
    "- Do not repeat observations already recorded (below). If something is already captured, skip it.",
    "- Do not contradict existing reflections (below). If the conversation invalidates a prior reflection, note that explicitly.",
    "- Keep each observation self-contained. No 'as discussed earlier' or 'see above'.",
    "- Include concrete details: file paths, function names, error messages, decisions made, constraints given by the user.",
    "- Prefer specific facts over general commentary.",
    "- One topic per observation. If the conversation covers three unrelated things, produce three observations.",
    "- Relevance levels: 'low' (trivial detail), 'medium' (useful context), 'high' (important decision/fact), 'critical' (blocking issue/crucial constraint).",
    "",
    "RESPOND WITH VALID JSON ONLY. Do not add any text before or after the JSON object.",
    "",
    priorReflections.length > 0 ? `Existing reflections (do not repeat these):\n${priorReflections.join("\n")}` : "",
    priorObservations.length > 0 ? `Existing observations (do not repeat these):\n${priorObservations.join("\n")}` : "",
  ].filter(Boolean);

  return lines.join("\n");
};

export const OBSERVER_USER_PREFIX = "Conversation chunk:";

export const OBSERVER_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    observations: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          content: { type: "string" as const },
          relevance: { type: "string" as const, enum: ["low", "medium", "high", "critical"] },
        },
        required: ["content", "relevance"],
      },
    },
  },
  required: ["observations"],
};

// ── Reflector prompts ──

export const REFLECTOR_SYSTEM =
  "You are a memory reflector. You synthesize a set of raw observations into durable reflections — " +
  "insights that an AI assistant should remember across sessions. Each reflection is a distilled insight " +
  "supported by one or more observation ids.";

export const REFLECTOR_PROMPT = (
  reflections: Reflection[],
  observations: Observation[],
): string => {
  const refLines = reflections.map((r) => {
    if (typeof r === "string") return `- [existing] ${r}`;
    return `- [existing] [${r.id}] ${r.content}`;
  });

  const obsLines = observations.map((o) => `- [${o.id}] [${o.relevance}] ${o.content}`);

  return [
    "Synthesize the observations below into reflections.",
    "",
    "Rules:",
    "- Each reflection should capture one durable insight that applies beyond the immediate conversation.",
    "- Each reflection must list the observation ids that support it.",
    "- Merge related observations into a single reflection when they support the same insight.",
    "- Do not repeat existing reflections.",
    "- If an observation contrad an existing reflection, either update the reflection or note the contradiction.",
    "",
    refLines.length > 0 ? `Existing reflections:\n${refLines.join("\n")}` : "",
    "",
    `Observations to synthesize:\n${obsLines.join("\n")}`,
  ].filter(Boolean).join("\n");
};

export const REFLECTOR_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    reflections: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          content: { type: "string" as const },
          supportingObservationIds: {
            type: "array" as const,
            items: { type: "string" as const },
          },
        },
        required: ["content", "supportingObservationIds"],
      },
    },
  },
  required: ["reflections"],
};

// ── Pruner prompts ──

export const PRUNER_SYSTEM =
  "You are a memory pruner. You remove observations that have been absorbed into reflections " +
  "or are redundant with other observations. The goal is to keep the observation set small and high-signal.\n" +
  "\n" +
  "Observations include [coverage: uncited/cited/reinforced] tags:\n" +
  "- uncited: no reflection cites this observation — prune cautiously\n" +
  "- cited: 1-3 reflections cite it — safer to drop if reflection captures equivalent meaning\n" +
  "- reinforced: 4+ reflections cite it — likely redundant but verify exact details";

export const PRUNER_PROMPT = (
  reflections: Reflection[],
  observations: Observation[],
  obsText?: string,  // pre-formatted with coverage tags
): string => {
  const refLines = reflections.map((r) => {
    if (typeof r === "string") return `- ${r}`;
    return `- [${r.id}] ${r.content}`;
  });

  const obsLines = obsText || observations.map((o) => `- [${o.id}] [${o.relevance}] ${o.content}`).join("\n");

  return [
    "Remove observations that are redundant.",
    "",
    "An observation is redundant if:",
    "- It has been absorbed into a reflection (the reflection's supportingObservationIds includes it).",
    "- It is a subset or restatement of another observation.",
    "",
    "Keep observations that:",
    "- Contain unique, specific details not covered elsewhere.",
    "- Have high or critical relevance and are not fully captured by reflections.",
    "",
    refLines.length > 0 ? `Reflections:\n${refLines.join("\n")}` : "",
    "",
    `Observations:\n${obsLines}`,
  ].filter(Boolean).join("\n");
};

export const PRUNER_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    observationsToKeep: {
      type: "array" as const,
      items: { type: "string" as const },
    },
  },
  required: ["observationsToKeep"],
};
