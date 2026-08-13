// Serialization: converts branch entries to text for the observer — ported from pi-observational-memory
import type { Message } from "@mariozechner/pi-ai";
import type { Entry } from "../types.js";
import { estimateStringTokens } from "./tokens.js";

const pad = (n: number): string => n.toString().padStart(2, "0");

const fmtLocal = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const formatTimestamp = (v: number | string | undefined): string => {
  if (v === undefined) return "????-??-?? ??:??";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "????-??-?? ??:??" : fmtLocal(d);
};

const textOnly = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
};

const serializeMessage = (msg: Message): string | null => {
  const time = formatTimestamp(msg.timestamp);
  if (msg.role === "user") return `[User @ ${time}]: ${textOnly(msg.content)}`;
  if (msg.role === "assistant") {
    const text = textOnly(msg.content);
    if (!text) return null;
    return `[Assistant @ ${time}]: ${text}`;
  }
  return `[Tool result: ${(msg as { toolName?: string }).toolName ?? "unknown"} @ ${time}]: ${textOnly(msg.content)}`;
};

const isSourceRenderable = (entry: Entry): boolean =>
  entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";

export interface SourceAddressedSerialization {
  text: string;
  sourceEntryIds: string[];
  coversUpToId?: string;
  hasMore: boolean;
  truncatedSourceEntryId?: string;
}

const renderSourceEntry = (entry: Entry): string | null => {
  if (entry.type === "message" && entry.message) {
    return serializeMessage(entry.message as Message);
  }
  if (entry.type === "custom_message") {
    const content = textOnly(entry.content);
    if (!content) return null;
    const time = formatTimestamp(entry.timestamp);
    const tag = entry.customType ? `Custom (${entry.customType})` : "Custom";
    return `[${tag} @ ${time}]: ${content}`;
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    const time = formatTimestamp(entry.timestamp);
    return `[Branch summary @ ${time}]: ${entry.summary}`;
  }
  return null;
};

const sourceBlock = (entry: Entry, rendered: string): string =>
  `[Source entry id: ${entry.id}]\n${rendered}`;

const truncateBlockToTokenBudget = (block: string, maxTokens: number): string => {
  const marker = "\n\n[source entry truncated for observer budget]\n\n";
  const maxChars = Math.max(64, maxTokens * 4);
  if (block.length <= maxChars) return block;
  const available = Math.max(16, maxChars - marker.length);
  const headChars = Math.ceil(available / 2);
  const tailChars = Math.floor(available / 2);
  return `${block.slice(0, headChars)}${marker}${block.slice(-tailChars)}`;
};

export const serializeSourceAddressedBranchEntries = (
  entries: Entry[],
  maxTokens = Number.POSITIVE_INFINITY,
): SourceAddressedSerialization => {
  const renderable = entries.flatMap((entry) => {
    if (!entry.id || !isSourceRenderable(entry)) return [];
    const rendered = renderSourceEntry(entry);
    return rendered?.trim() ? [{ entry, block: sourceBlock(entry, rendered) }] : [];
  });
  const blocks: string[] = [];
  const sourceEntryIds: string[] = [];
  let usedTokens = 0;
  let truncatedSourceEntryId: string | undefined;

  for (const item of renderable) {
    const separatorTokens = blocks.length > 0 ? estimateStringTokens("\n\n") : 0;
    const blockTokens = estimateStringTokens(item.block);
    if (usedTokens + separatorTokens + blockTokens <= maxTokens) {
      blocks.push(item.block);
      sourceEntryIds.push(item.entry.id);
      usedTokens += separatorTokens + blockTokens;
      continue;
    }

    if (blocks.length === 0 && maxTokens > 0) {
      const excerpt = truncateBlockToTokenBudget(item.block, maxTokens);
      blocks.push(excerpt);
      sourceEntryIds.push(item.entry.id);
      truncatedSourceEntryId = item.entry.id;
    }
    break;
  }

  return {
    text: blocks.join("\n\n"),
    sourceEntryIds,
    coversUpToId: sourceEntryIds.at(-1),
    hasMore: sourceEntryIds.length < renderable.length,
    truncatedSourceEntryId,
  };
};

export const serializeBranchEntries = (entries: Entry[]): string => {
  const blocks: string[] = [];
  for (const entry of entries) {
    let rendered: string | null = null;
    if (entry.type === "message" && entry.message) {
      rendered = serializeMessage(entry.message as Message);
    } else if (entry.type === "custom_message" && typeof entry.content === "string") {
      const time = formatTimestamp(entry.timestamp);
      const tag = entry.customType ? `Custom (${entry.customType})` : "Custom";
      rendered = `[${tag} @ ${time}]: ${entry.content}`;
    } else if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      const time = formatTimestamp(entry.timestamp);
      rendered = `[Branch summary @ ${time}]: ${entry.summary}`;
    }
    if (rendered?.trim()) blocks.push(rendered);
  }
  return blocks.join("\n\n");
};
