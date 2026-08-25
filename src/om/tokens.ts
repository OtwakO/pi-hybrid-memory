// Token utilities aligned with Pi's conservative compaction estimator.
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const CHARS_PER_TOKEN = 4;
const EMPTY_ENTRY_OVERHEAD_TOKENS = 5;

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: string; text: string } =>
        !!part
        && typeof part === "object"
        && part.type === "text"
        && typeof part.text === "string")
      .map(part => part.text)
      .join("\n");
  }
  return "";
};

const extensionEntryBody = (entry: Record<string, unknown>): string => {
  if (entry.type === "custom" && typeof entry.content === "string") return entry.content;
  if (entry.type === "custom_message") return textOf(entry.content);
  if (entry.type === "branch_summary" && typeof entry.summary === "string") return entry.summary;
  return "";
};

export const estimateStringTokens = (text: string): number =>
  text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);

export const estimateEntryTokens = (entry: unknown): number => {
  if (!entry || typeof entry !== "object") return EMPTY_ENTRY_OVERHEAD_TOKENS;
  const value = entry as Record<string, unknown>;

  if (value.type === "message" && value.message && typeof value.message === "object") {
    return Math.max(1, estimateTokens(value.message as AgentMessage));
  }

  const text = extensionEntryBody(value);
  return text ? estimateStringTokens(text) : EMPTY_ENTRY_OVERHEAD_TOKENS;
};
