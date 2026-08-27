# Long-Session Memory Quality Harness Roadmap

**Status:** Approved harness design; implementation not started

## Objective

Create deterministic decision evidence for or against semantic observation retirement at 300, 600, and 900 observations without adding runtime behavior, provider calls, large snapshots, or a retirement protocol before its safety is justified.

The harness evaluates candidate current-memory projections. It does not authorize retirement and does not treat reflection citations as proof of semantic preservation.

## Test-only seam

The harness accepts:

```ts
{
  fixture,
  activeObservations,
  currentReflections,
  retiredObservationIds,
}
```

and returns a compact report containing:

- required-fact failures;
- false-retirement count;
- false-retention count;
- unknown or duplicate IDs;
- missing required provenance;
- active observation and reflection tokens;
- context reduction relative to retention-only baseline;
- projection fingerprint for convergence comparison.

The implementation remains under `tests/quality/`. Do not introduce runtime interfaces, configuration, provider adapters, or production dependencies solely for the harness.

## Fixture design

Generate deterministic 300/600/900-observation fixtures around a small fixed oracle.

Required facts cover:

- exact identifiers and paths;
- versions and configuration values;
- exact error text and diagnosis;
- user correction and scope change;
- decision and rationale;
- chronology and supersession transition;
- unresolved work and constraint;
- source provenance and explicit missing-source disclosure.

Each required fact has:

- a stable observation ID;
- an exact required payload marker;
- expected source IDs;
- disposition `must-retain` or `retirable-if-exactly-preserved`.

Generated filler uses compact deterministic strings and stable IDs. It must not accidentally contain required markers. No fixture stores hundreds of handwritten observation literals or snapshots megabytes of rendered output.

## Preservation oracle

A required fact is considered available when either:

1. its original observation remains active; or
2. a current reflection contains the fixture's exact required payload marker and cites that observation ID.

Citation alone is insufficient. Approximate wording is insufficient for deterministic acceptance. This is intentionally stricter than semantic equivalence and protects identifiers, paths, versions, errors, and rationale from being hidden behind lossy paraphrase.

Future optional LLM judging may classify nuanced semantic preservation, but it cannot override deterministic required-fact failures.

## Error metrics

### False retirement

A retired observation counts as false retirement when:

- it is marked `must-retain`; or
- it is marked `retirable-if-exactly-preserved` but no current reflection satisfies the exact preservation oracle.

### False retention

A still-active observation counts as false retention only when the fixture explicitly marks it `retirable-if-exactly-preserved` and a current reflection already satisfies the exact preservation oracle.

Unlabelled generated filler is not used as a semantic-retirement oracle. This avoids pretending that arbitrary synthetic text has a trustworthy deletion answer.

### Context reduction

Measure estimated active observation plus current reflection content tokens against the retention-only baseline. Report both absolute and percentage reduction.

Do not claim disk reclamation. The harness measures current projection/context only.

## Compared scenarios

The initial harness verifies:

1. **Retention-only baseline:** all observations active, no semantic retirements.
2. **Current deterministic lifecycle:** exact-duplicate observation retirement and reflection strengthening where applicable.
3. **Candidate semantic projection:** supplied later by Phase D experiments.

The harness must support the third scenario without knowing whether proposals come from a combined reflection call or a separate constrained retirement call. Provider protocol comparison belongs to the Phase D experiment, not this fixture module.

## Structural validity

The evaluator rejects or reports:

- active and retired overlap;
- unknown active or retired IDs;
- duplicate active IDs;
- reflection support IDs absent from immutable fixture evidence;
- duplicate reflection IDs;
- required source IDs omitted from immutable observation evidence;
- non-finite or negative token metrics.

It evaluates immutable fixture evidence, not session persistence mechanics already covered by lifecycle projector tests.

## Convergence

Evaluation of the same projection must produce the same fingerprint and metrics. A future Phase D candidate must also show that applying its retirement policy again emits no additional lifecycle change.

The harness itself tests deterministic report convergence. Policy idempotency remains tested through the future policy seam rather than simulated inside the evaluator.

## Token-efficient test plan

Use one parameterized 300/600/900 test to verify:

- fixture size and stable IDs;
- retention baseline has zero false retirement and zero reduction;
- one compact candidate projection detects one false retirement, one false retention, missing provenance, and positive reduction;
- repeated evaluation returns the same fingerprint and metrics.

Use one small structural-invalidity test for overlapping/unknown IDs and invalid reflection support. Do not duplicate these checks at every fixture size.

Do not snapshot full summaries or print all observations. Failure output should list only failed oracle IDs and metric counts.

## Completion criteria

- [ ] Deterministic 300/600/900 fixture generator implemented.
- [ ] Required-fact and provenance oracle implemented.
- [ ] Compact quality report implemented.
- [ ] Retention baseline verified at all three sizes.
- [ ] Failure metrics proven sensitive with one compact candidate.
- [ ] Structural-invalidity reporting covered once.
- [ ] Evaluation convergence verified.
- [ ] No runtime code or provider calls added.
- [ ] Focused harness tests pass.
- [ ] TypeScript, full suite, and production build pass.
- [ ] Harness committed separately from Phase D protocol experiments.
- [ ] Review completed before semantic retirement design begins.
