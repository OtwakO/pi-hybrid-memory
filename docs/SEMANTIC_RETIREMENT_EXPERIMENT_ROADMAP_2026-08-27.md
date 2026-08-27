# Semantic Retirement Protocol Experiment Roadmap

**Status:** Phase D decision complete — semantic retirement remains disabled
**Evaluation model:** `opencode-go/deepseek-v4-flash`

## Objective

Compare combined and separate semantic-retirement protocols against the deterministic 300/600/900 quality harness without enabling semantic retirement in the extension or modifying real Pi sessions.

The experiment measures whether either protocol can produce explicit, locally valid retirement claims with zero deterministic required-fact loss and useful context reduction at acceptable provider cost.

## Execution policy

- Manual opt-in command only.
- Dry-run is the default.
- 300 observations must be evaluated before 600 or 900.
- Pi's `ModelRuntime` owns model lookup, credentials, provider translation, and completion.
- No API key is accepted as a command argument or written to disk.
- No extension runtime module imports experiment code.
- No real session or lifecycle journal is modified.
- Raw provider responses are not persisted by default.
- Reports contain compact metrics, usage, validation failures, and bounded failed IDs.

## Shared proposal shapes

Reflection proposal:

```ts
{
  proposalId: string;
  content: string;
  supportingObservationIds: string[];
}
```

Retirement proposal:

```ts
{
  observationId: string;
  preservedByReflectionIds: string[];
  reason: "fully-absorbed";
}
```

Proposal IDs are evaluation-local handles, not persisted memory IDs.

## Protocol A — combined

One constrained call returns reflections and retirement proposals together.

Local validation requires:

- unique non-empty reflection proposal IDs;
- known, unique observation support IDs;
- unique retirement target IDs;
- every retirement target names immutable fixture evidence;
- every preserving reflection exists in the same validated response;
- every preserving reflection cites the target observation;
- omitted observations remain active;
- malformed, truncated, errored, or aborted output produces no candidate retirements.

## Protocol B — separate

Call 1 returns reflections only. After local reflection validation, call 2 receives immutable observations plus the validated reflections and returns retirement proposals only.

The retirement validator applies the same rules as the combined protocol. Failure of call 2 retains every observation while preserving call-1 results only inside the experiment report; no runtime persistence decision is implied.

## Prompt policy

Both protocols receive the same canonical observation rendering and preservation rules. The separate retirement call additionally receives the validated reflection set.

Prompts emphasize:

- explicit per-observation proposals rather than keep lists;
- conservative retention under ambiguity;
- exact preservation of paths, IDs, versions, errors, corrections, rationale, chronology, unresolved work, and constraints;
- retirement only when cited reflections preserve the complete durable meaning;
- no retirement based only on relevance, age, or citation.

## Candidate conversion

Validated proposal-local reflections receive deterministic evaluation IDs derived from protocol, run, and proposal order. The candidate projection contains:

- all observations except valid explicit retirement targets;
- validated current reflections;
- exact retired observation IDs.

The existing quality harness evaluates required facts, false retirement/retention, provenance, structural validity, context reduction, and fingerprint convergence.

## Compact reports

Write reports under `evaluation-results/semantic-retirement/`, which is gitignored. A report records:

- timestamp and git commit;
- provider/model;
- protocol and fixture size;
- completion status and stop reason;
- input/output/cache token usage and reported cost;
- proposal counts;
- local validation issues;
- quality-harness metrics;
- bounded failed ID lists;
- projection fingerprint.

Do not store credentials, complete prompts, complete fixtures, thinking text, or raw responses by default.

## Token-efficient deterministic tests

1. One table-driven protocol validator test covers combined and separate valid outputs using the same compact fixture.
2. One fail-closed table covers malformed shape, unknown support, missing preservation link, duplicate target, and truncated/error status without separate tests per protocol.
3. Existing 300/600/900 harness tests remain authoritative for fixture scale; protocol tests use a tiny fixture and do not duplicate scale cases.
4. One report formatter assertion checks compact metric fields, not a full snapshot.

Routine `npm test` makes no provider calls. The manual evaluation command performs actual completions only with `--execute`.

## Manual command sequence

```bash
npm run evaluate:retirement -- --protocol both --size 300
npm run evaluate:retirement -- --protocol both --size 300 --execute
```

Larger runs require explicit size and successful prior 300 reports:

```bash
npm run evaluate:retirement -- --protocol both --size 600 --execute
npm run evaluate:retirement -- --protocol both --size 900 --execute
```

## Decision gate

Neither protocol may enter runtime unless representative repeated runs show:

- zero deterministic `must-retain` false retirements;
- zero required-fact failures;
- invalid/truncated calls retire nothing;
- valid IDs and provenance;
- repeat-run stability sufficient for safe operation;
- meaningful active-context reduction;
- acceptable usage, latency, and output validity;
- successful sanitized real-session evaluation in addition to generated fixtures.

If neither protocol passes, semantic retirement remains disabled.

## Completion criteria

- [x] Shared proposal types and local validator implemented.
- [x] Combined protocol adapter implemented.
- [x] Separate protocol adapter implemented.
- [x] Pi-native model runtime adapter implemented.
- [x] Dry-run and explicit execute guard implemented.
- [x] Compact report writer implemented with gitignored output.
- [x] Minimal deterministic protocol tests pass.
- [x] TypeScript, full suite, and production build pass.
- [x] First 300-observation provider evaluation run manually and reviewed.
- [x] No runtime semantic retirement enabled.
- [x] Experiment committed separately from any runtime decision.
- [x] Repeat 300-observation stability check completed.
- [x] Phase D decision recorded: no semantic retirement protocol approved.

## First 300-observation result

Using `opencode-go/deepseek-v4-flash`:

| Protocol | Required failures | False retirements | False retentions | Reduction | Total usage | Reported cost |
|---|---:|---:|---:|---:|---:|---:|
| Combined | 0 | 0 | 3 | 84.61% | 40,405 tokens | 0.021320 |
| Separate | 12 | 12 | 0 | 0.00% | 30,802 tokens | 0.009650 |

The separate protocol fails the deterministic safety gate in its current form because all 12 required facts were retired without exact preservation.

A repeat combined-only 300-observation run also failed decisively:

| Combined run | Required failures | False retirements | False retentions | Reduction | Retirement proposals | Total usage |
|---|---:|---:|---:|---:|---:|---:|
| First | 0 | 0 | 3 | 84.61% | 288 | 40,405 tokens |
| Repeat | 9 | 9 | 0 | 0.70% | 12 | 15,761 tokens |

The same model, fixture, protocol, and size produced radically different safety and convergence outcomes. Neither combined nor separate protocol is approved for runtime semantic retirement. Do not run 600/900; larger fixtures cannot rescue a protocol that fails deterministic required facts and repeat stability at 300 observations. Semantic retirement remains disabled.
