import { execFileSync } from "node:child_process";

import { createMemoryQualityFixture } from "../../tests/quality/memory-quality-fixture.js";
import { evaluateMemoryQuality } from "../../tests/quality/memory-quality-harness.js";
import { SemanticRetirementModel } from "./model.js";
import {
  combinedSystemPrompt,
  combinedUserPrompt,
  reflectionSystemPrompt,
  reflectionUserPrompt,
  retirementSystemPrompt,
  retirementUserPrompt,
} from "./prompts.js";
import {
  validateProtocolProposal,
  type CompletionState,
  type ProtocolProposal,
  type RetirementProtocol,
} from "./protocol.js";
import { writeSemanticRetirementReport } from "./report.js";

interface Options {
  protocol: RetirementProtocol | "both";
  size: 300 | 600 | 900;
  execute: boolean;
}

const parseOptions = (args: string[]): Options => {
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const protocol = value("--protocol") ?? "both";
  const size = Number(value("--size") ?? "300");
  if (!(["combined", "separate", "both"] as const).includes(protocol as Options["protocol"])) {
    throw new Error("--protocol must be combined, separate, or both");
  }
  if (![300, 600, 900].includes(size)) throw new Error("--size must be 300, 600, or 900");
  return { protocol: protocol as Options["protocol"], size: size as Options["size"], execute: args.includes("--execute") };
};

const gitCommit = (): string => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const runProtocol = async (
  protocol: RetirementProtocol,
  size: Options["size"],
  model: SemanticRetirementModel,
): Promise<string> => {
  const fixture = createMemoryQualityFixture(size);
  let proposal: ProtocolProposal = { reflections: [], retirements: [] };
  const states: CompletionState[] = [];
  const usage = [];

  if (protocol === "combined") {
    const completion = await model.combined(combinedSystemPrompt, combinedUserPrompt(fixture.observations));
    states.push(completion.state);
    if (completion.usage) usage.push(completion.usage);
    if (completion.value) proposal = completion.value;
  } else {
    const reflectionCompletion = await model.reflections(
      reflectionSystemPrompt,
      reflectionUserPrompt(fixture.observations),
    );
    states.push(reflectionCompletion.state);
    if (reflectionCompletion.usage) usage.push(reflectionCompletion.usage);
    if (reflectionCompletion.value) {
      const retirementCompletion = await model.retirements(
        retirementSystemPrompt,
        retirementUserPrompt(fixture.observations, reflectionCompletion.value.reflections),
      );
      states.push(retirementCompletion.state);
      if (retirementCompletion.usage) usage.push(retirementCompletion.usage);
      proposal = {
        reflections: reflectionCompletion.value.reflections,
        retirements: retirementCompletion.value?.retirements ?? [],
      };
    }
  }

  const completionState: CompletionState = states.every(state => state === "success")
    ? "success"
    : states.at(-1) ?? "error";
  const proposalForValidation = protocol === "separate" && states[0] === "success" && states[1] !== "success"
    ? { reflections: proposal.reflections, retirements: [] }
    : proposal;
  const proposalState = protocol === "separate" && states[0] === "success" && states[1] !== "success"
    ? "success"
    : completionState;
  const validated = validateProtocolProposal({
    protocol,
    observations: fixture.observations,
    proposal: proposalForValidation,
    completionState: proposalState,
  });
  const quality = evaluateMemoryQuality(fixture, validated);
  return writeSemanticRetirementReport({
    timestamp: new Date().toISOString(),
    gitCommit: gitCommit(),
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    protocol,
    fixtureSize: size,
    completionStates: states,
    usage,
    reflectionProposals: proposal.reflections.length,
    retirementProposals: proposal.retirements.length,
    validationIssues: validated.issues,
    quality,
  });
};

const main = async (): Promise<void> => {
  const options = parseOptions(process.argv.slice(2));
  const protocols: RetirementProtocol[] = options.protocol === "both"
    ? ["combined", "separate"]
    : [options.protocol];

  console.log(`Semantic retirement evaluation: opencode-go/deepseek-v4-flash, ${options.size} observations, ${protocols.join(" + ")}`);
  if (!options.execute) {
    console.log("Dry run only. No provider calls were made. Add --execute to run the evaluation.");
    return;
  }

  const model = await SemanticRetirementModel.create();
  for (const protocol of protocols) {
    const path = await runProtocol(protocol, options.size, model);
    console.log(`${protocol}: wrote ${path}`);
  }
};

await main();
