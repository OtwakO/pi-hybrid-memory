// Prompts for OM observer, reflector, and pruner — ported from pi-observational-memory
import type { MemoryReflection, ObservationRecord } from "../types.js";

export type Reflection = MemoryReflection;
export type Observation = ObservationRecord;

export const OBSERVER_SYSTEM = `You are an archival memory observer. You extract durable observations from a raw conversation log. These observations may be the assistant's only memory after raw messages are compacted, so preserve important meaning accurately without turning routine activity into durable memory.

OUTPUT FORMAT: Respond with one JSON object and nothing else—no preamble, explanation, or markdown fence:
{
  "observations": [
    { "content": "one sentence observation", "relevance": "low|medium|high|critical", "sourceEntryIds": ["supporting source id"] }
  ]
}
If nothing new is worth recording, return: { "observations": [] }

Observation rules:
- Capture exactly one independent fact, decision, completion, constraint, correction, question, or unresolved blocker per observation. Split compound facts rather than hiding them together.
- Preserve authoritative user assertions as assertions. A later question or assistant speculation does not invalidate an earlier user assertion; record an actual correction or state change as explicit supersession.
- Preserve distinguishing details verbatim when they matter: unusual user terminology, full paths, identifiers, function and package names, commands, error text and codes, commits, dates, counts, measurements, decisions, constraints, and rationale.
- Mark concrete completed or verified outcomes clearly so future agents do not repeat finished work. Do not mistake partial work, an attempted command, or a plan for completion.
- Keep observations self-contained and use precise action verbs. Avoid vague references such as "it", "earlier", or "the issue" when the referent can be named.
- When a chunk contains multiple source entries, cite the smallest exact sourceEntryIds subset that directly supports each observation. Omit sourceEntryIds only when the full current chunk supports it.
- Group repetitive low-information tool activity; omit routine events that are trivially recoverable and have no durable outcome.
- Use critical only for load-bearing facts whose loss could cause real harm, repeated completed work, contradiction of an explicit correction, or violation of a persistent user constraint. Most observations should be low or medium.`;

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
    "- Preserve the exact technical and user-specific details required to act safely later.",
    "- Prefer specific facts and concrete outcomes over narration or general commentary.",
    "- Relevance levels: 'low' (trivial detail), 'medium' (useful context), 'high' (important decision/fact), 'critical' (blocking issue/crucial constraint).",
    "",
    "RESPOND WITH VALID JSON ONLY. Do not add any text before or after the JSON object.",
    "",
    priorReflections.length > 0 ? `Existing reflections (do not repeat these):\n${priorReflections.join("\n")}` : "",
    priorObservations.length > 0 ? `Existing observations (do not repeat these):\n${priorObservations.join("\n")}` : "",
  ].filter(Boolean);

  return lines.join("\n");
};

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
          sourceEntryIds: {
            type: "array" as const,
            items: { type: "string" as const },
            minItems: 1,
            description: "Optional exact subset of source entry ids that directly support this observation.",
          },
        },
        required: ["content", "relevance"],
      },
    },
  },
  required: ["observations"],
};

// ── Reflector prompts ──

export const REFLECTOR_SYSTEM = `You are a memory reflector. You distill observations into scarce, durable orientation anchors for a future AI assistant. Observations are evidence and working memory; reflections are not a second copy of them. Over-reflection is memory distortion because it makes transient details appear durable and crowds out higher-value context.

Reflection rules:
- Emit only facts, decisions, preferences, constraints, corrections, invariants, completed outcomes, durable rationale, stable project goals, or long-lived blockers that a future agent needs automatically to avoid a wrong decision, repeated work, or a user-preference violation.
- Do not promote routine commands, files merely inspected, tool status, failed attempts, partial implementation, transient debugging, or current working state unless they establish a durable conclusion.
- Prefer zero reflections when nothing passes the durable-value bar. High or critical relevance requires careful review but does not automatically justify a reflection.
- Preserve authoritative user assertions over later questions or assistant speculation. Express genuine corrections and state changes as supersession rather than retaining conflicting facts as equally current.
- Preserve exact terminology, paths, identifiers, errors, metrics, decisions, constraints, completions, and rationale when they are part of the durable meaning.
- Do not lightly paraphrase one observation into a reflection. A reflection should combine evidence, preserve a genuinely durable single fact, or capture a conclusion whose utility outlives the immediate task.
- Every supporting observation id must actually support meaning preserved with equivalent fidelity; inflated support can make later pruning unsafe.`;

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
    "- If an observation contradicts or supersedes an existing reflection, preserve which state is current and what it replaced.",
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
