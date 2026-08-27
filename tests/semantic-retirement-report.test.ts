import { describe, expect, it } from "vitest";

import { formatSemanticRetirementReport } from "../evaluation/semantic-retirement/report.js";

describe("semantic retirement evaluation report", () => {
  it("renders compact decision metrics without fixture or response dumps", () => {
    const text = formatSemanticRetirementReport({
      timestamp: "2026-08-27T00:00:00.000Z",
      gitCommit: "abc123",
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      protocol: "combined",
      fixtureSize: 300,
      completionStates: ["success"],
      usage: [{
        input: 100,
        output: 20,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 135,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
      }],
      reflectionProposals: 2,
      retirementProposals: 1,
      validationIssues: [],
      quality: {
        valid: true,
        issues: [],
        failedRequiredFactIds: ["aaaaaaaaaaaa"],
        falseRetirementIds: ["aaaaaaaaaaaa"],
        falseRetentionIds: [],
        missingProvenanceIds: [],
        baselineTokens: 1_000,
        activeTokens: 700,
        reducedTokens: 300,
        reductionPercentage: 30,
        fingerprint: "fingerprint",
      },
    });

    expect(text).toContain("opencode-go/deepseek-v4-flash");
    expect(text).toContain("False retirements: 1 (aaaaaaaaaaaa)");
    expect(text).toContain("Reduced tokens: 300 (30.00%)");
    expect(text).not.toContain("Generated filler");
    expect(text).not.toContain("apiKey");
  });
});
