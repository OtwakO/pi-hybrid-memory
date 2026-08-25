import {
  convertToLlm,
  type FileOperations,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { AuthoritativeFileOperations } from "./extractor.js";
import { extractVccSummary } from "./summary.js";

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

export interface VccCompactionInput {
  messages: Message[];
  previousSummary?: string;
  fileOps: AuthoritativeFileOperations;
}

const authoritativeFileOperations = (fileOps: FileOperations): AuthoritativeFileOperations => ({
  read: fileOps.read,
  written: fileOps.written,
  edited: fileOps.edited,
});

export const prepareVccCompactionInput = (
  preparation: CompactionPreparation,
): VccCompactionInput => ({
  messages: convertToLlm([
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
  ]),
  previousSummary: extractVccSummary(preparation.previousSummary),
  fileOps: authoritativeFileOperations(preparation.fileOps),
});
