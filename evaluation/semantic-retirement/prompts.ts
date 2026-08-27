import type { ObservationRecord } from "../../src/types.js";
import type { ProposedReflection } from "./protocol.js";

const observationsText = (observations: readonly ObservationRecord[]): string =>
  observations.map(observation =>
    `[${observation.id}] [${observation.relevance}] ${observation.timestamp}\n${observation.content}`)
  .join("\n\n");

const preservationRules = `Retirement safety rules:
- Propose retirement explicitly per observation. Omitted observations remain active.
- Retire only when the named reflections preserve the complete durable meaning.
- Preserve exact paths, identifiers, versions, configuration values, errors, diagnoses, corrections, decisions, rationale, chronology, unresolved work, and constraints.
- Citation alone is not preservation.
- Do not retire based on age, relevance, repetition of topic, or approximate paraphrase.
- When uncertain, retain the observation.`;

export const combinedSystemPrompt = `You evaluate durable memory. Produce reflections and conservative fully-absorbed retirement proposals through the required tool. ${preservationRules}`;

export const combinedUserPrompt = (observations: readonly ObservationRecord[]): string => `Review these immutable observations. Create only durable reflections, then propose fully-absorbed retirements only when those new reflections preserve every important detail.\n\n${observationsText(observations)}`;

export const reflectionSystemPrompt = `You create scarce durable reflections from immutable observations. Preserve exact details and use explicit observation support IDs. Do not make retirement decisions.`;

export const reflectionUserPrompt = (observations: readonly ObservationRecord[]): string =>
  `Create durable reflections from these immutable observations.\n\n${observationsText(observations)}`;

export const retirementSystemPrompt = `You conservatively evaluate whether observations are fully absorbed by validated reflections. ${preservationRules}`;

export const retirementUserPrompt = (
  observations: readonly ObservationRecord[],
  reflections: readonly ProposedReflection[],
): string => {
  const reflectionText = reflections.map(reflection =>
    `[${reflection.proposalId}] supports ${reflection.supportingObservationIds.join(", ")}\n${reflection.content}`)
  .join("\n\n");
  return `Validated reflections:\n\n${reflectionText || "<none>"}\n\nImmutable observations:\n\n${observationsText(observations)}`;
};
