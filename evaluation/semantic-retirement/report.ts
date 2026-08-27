import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Usage } from "@earendil-works/pi-ai";
import type { MemoryQualityReport } from "../../tests/quality/memory-quality-harness.js";
import type { CompletionState, RetirementProtocol } from "./protocol.js";

export interface SemanticRetirementReport {
  timestamp: string;
  gitCommit: string;
  provider: "opencode-go";
  model: "deepseek-v4-flash";
  protocol: RetirementProtocol;
  fixtureSize: number;
  completionStates: CompletionState[];
  usage: Usage[];
  reflectionProposals: number;
  retirementProposals: number;
  validationIssues: string[];
  quality: MemoryQualityReport;
}

const bounded = (ids: readonly string[]): string => ids.slice(0, 12).join(", ") || "none";

export const formatSemanticRetirementReport = (report: SemanticRetirementReport): string => {
  const usage = report.usage.reduce((total, item) => ({
    input: total.input + item.input,
    output: total.output + item.output,
    cacheRead: total.cacheRead + item.cacheRead,
    cacheWrite: total.cacheWrite + item.cacheWrite,
    totalTokens: total.totalTokens + item.totalTokens,
    cost: total.cost + item.cost.total,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });

  return `# Semantic Retirement Evaluation

- Timestamp: ${report.timestamp}
- Git commit: ${report.gitCommit}
- Model: ${report.provider}/${report.model}
- Protocol: ${report.protocol}
- Fixture observations: ${report.fixtureSize}
- Completion states: ${report.completionStates.join(", ")}
- Proposals: ${report.reflectionProposals} reflections, ${report.retirementProposals} retirements
- Validation: ${report.validationIssues.length === 0 ? "valid" : report.validationIssues.join(", ")}
- Usage: ${usage.input} input, ${usage.output} output, ${usage.cacheRead} cache-read, ${usage.cacheWrite} cache-write, ${usage.totalTokens} total
- Reported cost: ${usage.cost.toFixed(6)}

## Quality

- Structurally valid: ${report.quality.valid}
- Required-fact failures: ${report.quality.failedRequiredFactIds.length} (${bounded(report.quality.failedRequiredFactIds)})
- False retirements: ${report.quality.falseRetirementIds.length} (${bounded(report.quality.falseRetirementIds)})
- False retentions: ${report.quality.falseRetentionIds.length} (${bounded(report.quality.falseRetentionIds)})
- Missing provenance: ${report.quality.missingProvenanceIds.length} (${bounded(report.quality.missingProvenanceIds)})
- Baseline tokens: ${report.quality.baselineTokens}
- Active tokens: ${report.quality.activeTokens}
- Reduced tokens: ${report.quality.reducedTokens} (${report.quality.reductionPercentage.toFixed(2)}%)
- Projection fingerprint: ${report.quality.fingerprint}
`;
};

export const writeSemanticRetirementReport = async (
  report: SemanticRetirementReport,
  root = "evaluation-results/semantic-retirement",
): Promise<string> => {
  await mkdir(root, { recursive: true });
  const safeTimestamp = report.timestamp.replace(/[:.]/g, "-");
  const path = join(root, `${safeTimestamp}-${report.protocol}-${report.fixtureSize}.md`);
  await writeFile(path, formatSemanticRetirementReport(report), "utf8");
  return path;
};
