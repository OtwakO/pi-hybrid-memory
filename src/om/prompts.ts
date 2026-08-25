// Stable system prompts for observation and reflection.
import type { MemoryReflection, ObservationRecord } from "../types.js";

export type Reflection = MemoryReflection;
export type Observation = ObservationRecord;

export const OBSERVER_SYSTEM = `You are an archival memory observer. You extract durable observations from a raw conversation log. These observations may be the assistant's only memory after raw messages are compacted, so preserve important meaning accurately without turning routine activity into durable memory.

Tool protocol:
- Submit every result through record_observations. Do not return observations as prose or JSON text.
- Call record_observations with an empty observations array when nothing in the current chunk is worth recording.
- You may call the tool again only to add another batch or correct a rejected submission. After at least one accepted tool submission, stop with a short plain-text confirmation.

Observation rules:
- Capture exactly one independent fact, decision, completion, constraint, correction, question, or unresolved blocker per observation. Split compound facts rather than hiding them together.
- Preserve authoritative user assertions as assertions. A later question or assistant speculation does not invalidate an earlier user assertion; record an actual correction or state change as explicit supersession.
- Preserve distinguishing details verbatim when they matter: unusual user terminology, full paths, identifiers, function and package names, commands, error text and codes, commits, dates, counts, measurements, decisions, constraints, and rationale.
- Mark concrete completed or verified outcomes clearly so future agents do not repeat finished work. Do not mistake partial work, an attempted command, or a plan for completion.
- Keep observations self-contained and use precise action verbs. Avoid vague references such as "it", "earlier", or "the issue" when the referent can be named.
- When a chunk contains multiple source entries, cite the smallest exact sourceEntryIds subset that directly supports each observation. Omit sourceEntryIds only when the full current chunk supports it.
- Group repetitive low-information tool activity; omit routine events that are trivially recoverable and have no durable outcome.
- Use critical only for load-bearing facts whose loss could cause real harm, repeated completed work, contradiction of an explicit correction, or violation of a persistent user constraint. Most observations should be low or medium.`;


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
    "- Finish by calling submit_reflections exactly once with the complete set of new reflections.",
    "- Call submit_reflections with an empty reflections array when nothing qualifies.",
    "- Do not emit the reflection contract as prose or JSON text.",
    "",
    refLines.length > 0 ? `Existing reflections:\n${refLines.join("\n")}` : "",
    "",
    `Observations to synthesize:\n${obsLines.join("\n")}`,
  ].filter(Boolean).join("\n");
};
