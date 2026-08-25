// Serialization: converts branch entries to text for the observer — ported from pi-observational-memory
import type { Message } from "@mariozechner/pi-ai";
import type { Entry, SourceProgress } from "../types.js";
export type { SourceProgress } from "../types.js";
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
  completedSourceEntryIds: string[];
  coversUpToId?: string;
  sourceProgress?: SourceProgress;
  hasMore: boolean;
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

const sourceSegment = (
  sourceEntryId: string,
  rendered: string,
  startOffset: number,
  maxTokens: number,
): { text: string; nextOffset: number; complete: boolean } => {
  const safeStart = Math.max(0, Math.min(startOffset, rendered.length));
  const maxChars = Math.max(64, maxTokens * 4);
  const header = `[Source segment: ${sourceEntryId} ${safeStart}-`;
  const suffix = `/${rendered.length}]\n`;
  const available = Math.max(1, maxChars - header.length - suffix.length - 12);
  const nextOffset = Math.min(rendered.length, safeStart + available);
  return {
    text: `${header}${nextOffset}${suffix}${rendered.slice(safeStart, nextOffset)}`,
    nextOffset,
    complete: nextOffset >= rendered.length,
  };
};

export const serializeSourceAddressedBranchEntries = (
  entries: Entry[],
  maxTokens = Number.POSITIVE_INFINITY,
  progress?: SourceProgress,
): SourceAddressedSerialization => {
  const renderable = entries.flatMap((entry) => {
    if (!entry.id || !isSourceRenderable(entry)) return [];
    const rendered = renderSourceEntry(entry);
    return rendered?.trim() ? [{ entry, block: sourceBlock(entry, rendered) }] : [];
  });
  const blocks: string[] = [];
  const sourceEntryIds: string[] = [];
  const completedSourceEntryIds: string[] = [];
  let usedTokens = 0;
  let sourceProgress: SourceProgress | undefined;
  const startIndex = progress
    ? renderable.findIndex(item => item.entry.id === progress.sourceEntryId)
    : 0;
  const activeRenderable = startIndex >= 0 ? renderable.slice(startIndex) : renderable;

  for (let index = 0; index < activeRenderable.length; index++) {
    const item = activeRenderable[index];
    const startOffset = index === 0 && progress?.sourceEntryId === item.entry.id
      ? progress.nextOffset
      : 0;
    const rendered = renderSourceEntry(item.entry);
    if (!rendered) continue;
    if (startOffset > 0 || estimateStringTokens(item.block) > maxTokens) {
      if (blocks.length > 0) break;
      const segment = sourceSegment(item.entry.id, rendered, startOffset, maxTokens);
      blocks.push(segment.text);
      sourceEntryIds.push(item.entry.id);
      if (segment.complete) completedSourceEntryIds.push(item.entry.id);
      else sourceProgress = {
        sourceEntryId: item.entry.id,
        nextOffset: segment.nextOffset,
        totalLength: rendered.length,
      };
      break;
    }
    const separatorTokens = blocks.length > 0 ? estimateStringTokens("\n\n") : 0;
    const blockTokens = estimateStringTokens(item.block);
    if (usedTokens + separatorTokens + blockTokens <= maxTokens) {
      blocks.push(item.block);
      sourceEntryIds.push(item.entry.id);
      completedSourceEntryIds.push(item.entry.id);
      usedTokens += separatorTokens + blockTokens;
      continue;
    }

    break;
  }

  return {
    text: blocks.join("\n\n"),
    sourceEntryIds,
    completedSourceEntryIds,
    coversUpToId: completedSourceEntryIds.at(-1),
    sourceProgress,
    hasMore: sourceProgress !== undefined || completedSourceEntryIds.length < activeRenderable.length,
  };
};
