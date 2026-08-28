import { MAX_REFLECTION_CONTENT_CHARS } from "./reflection-budget.js";
import type { ReflectionProposalItem } from "./reflection-validation.js";

export interface ReflectionHandleProposalItem {
  content: string;
  supportingEvidenceHandles: string[];
}

export interface ReflectionHandleResolution {
  proposedItems: number;
  rejectedItems: number;
  candidates: ReflectionProposalItem[];
}

export const resolveReflectionHandles = (
  proposal: readonly ReflectionHandleProposalItem[],
  handleToObservationId: Readonly<Record<string, string>>,
): ReflectionHandleResolution => {
  const candidates: ReflectionProposalItem[] = [];
  let rejectedItems = 0;

  for (const candidate of proposal) {
    const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
    const handles = candidate.supportingEvidenceHandles;
    if (
      !content
      || content.length > MAX_REFLECTION_CONTENT_CHARS
      || !Array.isArray(handles)
      || handles.length === 0
      || handles.some(handle => typeof handle !== "string" || !handleToObservationId[handle])
      || new Set(handles).size !== handles.length
    ) {
      rejectedItems++;
      continue;
    }

    candidates.push({
      content,
      supportingObservationIds: handles.map(handle => handleToObservationId[handle]),
    });
  }

  return {
    proposedItems: proposal.length,
    rejectedItems,
    candidates,
  };
};
