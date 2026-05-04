// Serialization: converts branch entries to text for the observer — ported from pi-observational-memory
import type { Message } from "@mariozechner/pi-ai";
import type { Entry } from "../types.js";

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
}

export const serializeSourceAddressedBranchEntries = (entries: Entry[]): SourceAddressedSerialization => {
  const blocks: string[] = [];
  const sourceEntryIds: string[] = [];
  for (const entry of entries) {
    if (!entry.id || !isSourceRenderable(entry)) continue;
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
    if (!rendered?.trim()) continue;
    sourceEntryIds.push(entry.id);
    blocks.push(`[Source entry id: ${entry.id}]\n${rendered}`);
  }
  return { text: blocks.join("\n\n"), sourceEntryIds };
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
