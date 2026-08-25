export const VCC_SUMMARY_HEADER =
  "## Session State (Structural Summary)\n" +
  "The following is a structural summary of what happened in this session.\n\n";

export const extractVccSummary = (summary: string | undefined): string | undefined => {
  if (!summary) return undefined;
  const start = summary.indexOf(VCC_SUMMARY_HEADER);
  if (start < 0) return undefined;

  const bodyStart = start + VCC_SUMMARY_HEADER.length;
  const nextSection = summary.indexOf("\n\n---\n\n## ", bodyStart);
  const body = summary.slice(bodyStart, nextSection >= 0 ? nextSection : undefined).trim();
  return body || undefined;
};
