# Compaction Quality, Main-Context Efficiency, and Fold Reliability Roadmap

**Date:** 2026-08-25
**Status:** Design approved for tracking; implementation not started
**Supersedes for ordering:** cache-prefix milestones G/H in `THIRD_PARTY_REVIEW_VERIFICATION_2026-08-25.md` until fold correctness and compaction effectiveness are established

## 1. Purpose

This roadmap addresses a production failure observed on a long session:

- Pi compacted from 253,316 tokens, but the post-compaction context remained large.
- The observation pool contained 828 observations and about 36,756 content tokens.
- Reflector and pruner provider requests completed but both produced `invalid-output` lifecycle results.
- Reflector used 53,687 input and 40,990 output tokens, accepted no reflections.
- Pruner used 71,626 input and 68,229 output tokens, then safely fell back to retaining all 828 observations.
- Observer behavior was healthy: 50 successful calls, 95.9% provider-reported cache reuse, and no baseline pressure.

The immediate objective is not simply to make compaction cheaper. It is to make the memory fold reliable, quality-preserving, and capable of producing a substantially smaller, stable main-model context.

## 2. Optimization objectives

### 2.1 Main-session flagship model

Priority:

```text
memory fidelity and task correctness
→ information density and attention quality
→ smaller post-compaction context
→ stable post-compaction prefix
→ lower uncached and cached flagship-model input
```

The first main-model request after compaction establishes a new prefix because the old raw history is replaced by a summary plus Pi's retained tail. Cross-compaction cache reuse cannot be guaranteed. The portable optimization is to make that first cold request materially smaller and keep the new prefix byte-stable afterward.

### 2.2 Extension-owned compaction model

Priority:

```text
memory fidelity
→ validated and safe consolidation
→ reliability and recoverability
→ effective context reduction
→ cache reuse
→ monetary cost
```

A cheaper model may need substantial reasoning and complete evidence. Cost optimization must not reduce source evidence, chronology, corrections, provenance, or necessary reasoning. Quality-neutral savings remain desirable: constrained outputs, no dependent calls after prerequisite failure, stable prefixes, and avoiding malformed-output retries.

## 3. Non-negotiable invariants

1. Pi branch entries remain authoritative durable state.
2. Failed, aborted, truncated, malformed, or semantically invalid fold work cannot delete observations or advance memory state.
3. Existing `MemoryDetailsV4` sessions remain readable until a separately approved additive schema version is introduced.
4. No observation is retired merely because a reflection cites it.
5. No uncited observation is retired by default.
6. High and critical observations require an explicit, validated preservation claim before retirement.
7. Exact corrections, supersession, paths, identifiers, errors, decisions, rationale, chronology, and provenance must survive consolidation when semantically material.
8. A configured summary ceiling must never silently delete the sole durable representation of information.
9. Main-context optimization must be measured separately from compaction-model cache and cost.
10. Provider transport success is not fold success.

## 4. Confirmed design flaws

### 4.1 Free-form fold output is not constrained

The repository defines reflector and pruner JSON schemas but does not enforce them at the provider seam. `completeSimple()` receives no tools, no constrained sampling, no output limit, and no explicit reasoning level. Free-form text is parsed with heuristic JSON extraction.

The active host (`@earendil-works/pi-ai` 0.84.3) supports:

- JSON-schema constrained tool sampling with `strict: "prefer"`.
- `maxTokens`.
- Provider-neutral reasoning levels.
- Explicit `length` stop reasons.

The repository develops against `@mariozechner/*` 0.66.1, which does not expose these runtime capabilities in its types. Runtime feature use therefore needs either a narrow compatibility module or the later isolated SDK-alignment milestone; it must not be scattered through callers.

### 4.2 Stop reason `length` is misclassified

Current fold code treats every stop reason other than `error` and `aborted` as transport success. A truncated response can therefore be reported as a successful provider call and only later collapse into generic `invalid-output`.

### 4.3 Pruner output can be dangerously incomplete

A parseable `observationsToKeep: []` currently produces an empty observation set. More generally, an incomplete keep-list can silently remove uncited or unique observations. Local validation does not reject unknown IDs, duplicate IDs, omitted IDs, or unsafe removal classes.

The fallback that protects observations runs only when the model keeps all observations, not when it proposes over-aggressive deletion.

### 4.4 Reflection support is not absorption

`supportingObservationIds` means an observation supports a reflection. It does not prove that the reflection preserves every important detail from that observation. The current pruner prompt and coverage tags conflate citation with safe retirement.

A safe fold needs an explicit preservation/absorption decision or must conservatively retain the observation.

### 4.5 Reflector failure still triggers expensive pruning

The compaction hook calls the pruner after the reflector returns its unchanged fallback. This can spend another large call without new coverage evidence. Pruning should depend on an explicit valid reflector outcome, not merely an array return value.

### 4.6 Reflector validation is incomplete

Current validation filters malformed reflection items but does not require all supporting IDs to belong to the active observation pool. It can accept partial proposals while reporting generic success. Exact semantic duplicates use whitespace normalization but no explicit active/superseded policy.

### 4.7 Durable memory and main-context projection are coupled

`applySummaryBudget()` removes observations from both the rendered summary and the `MemoryDetailsV4.observations` stored on the next compaction. This forces an unsafe binary choice:

```text
keep protected observation in main context
or
forget it from current durable memory state
```

For high-quality long-session memory, durable evidence and model-visible projection need separate concepts. A smaller main summary should not require deleting recoverable evidence.

### 4.8 Recall has a confirmed compatibility gap for compaction-only evidence

The inspected NovelReader compaction did not reproduce observation loss: all 659 observations in its details also existed in custom observation entries and were therefore discoverable by `hm_recall`. However, `hm_recall` indexes observations only from custom observation entries, while `getMemoryState()` can load committed observations from compaction details. Bootstrap or future compaction-only evidence is therefore not guaranteed discoverable. Reflection recall also shows reflection text without traversing supporting observations or source entries. Any retirement design must define carry-forward and recall scope intentionally.

### 4.9 Relevance calibration is already polluted

Existing long sessions contain hundreds of observations classified as `critical`. Prompt improvements affect future extraction but do not safely reclassify existing observations. Relevance alone cannot be the retirement authority.

### 4.10 Compaction effectiveness is not measured end-to-end

Current telemetry measures extension LLM calls but not the main-context outcome:

- summary tokens by section,
- protected overflow,
- retained-tail estimate,
- context before compaction,
- first main-model context after compaction,
- cold-transition size,
- subsequent warm reuse.

Without these, cache percentage can be mistaken for efficiency and summary growth can go unnoticed.

## 5. Verification audit of identified issues

The following findings were rechecked against repository HEAD, the active Pi 0.84.3 documentation/types, and the captured NovelReader session before implementation was approved.

| Finding | Verdict | Direct evidence | Implementation order |
|---|---|---|---|
| Reflector/pruner outputs are free-form and schemas are not enforced | **Confirmed defect** | `callModel()` invokes `completeSimple()` without tools, constrained sampling, `maxTokens`, or reasoning policy; JSON is recovered heuristically | Q1, after Q0 safety |
| `stopReason: "length"` is treated as success | **Confirmed defect** | `callModel()` maps only `error` and `aborted` away from success | Q0 |
| Empty or incomplete pruner keep-list can delete observations | **Confirmed critical defect** | `keepSet` is built from any string array and all omitted observations are removed; `[]` yields an empty set | Q0: disable current deletion path |
| Keep-all fallback can still delete low/medium observations | **Confirmed critical defect** | `kept.length >= observations.length` enters local destructive fallback at `runPruner()` | Q0: disable fallback |
| Reflection citation proves full absorption | **False assumption / confirmed model gap** | `supportingObservationIds` records evidence support only; no preservation/absorption field exists | Q2/Q3 schema and retirement decision |
| Pruner runs after reflector failure | **Confirmed defect** | `runReflector()` returns the old array on failure and caller unconditionally invokes `runPruner()` | Q0 |
| Reflector accepts unsupported provenance IDs | **Confirmed defect** | It filters strings but never checks IDs against the active observation set; a non-empty unknown-only list can be persisted | Q0 validation, then Q1 module |
| Reflector failure/success is not explicit to caller | **Confirmed design defect** | `runReflector()` returns only an array, so unchanged fallback, deliberate empty, and successful no-new-reflection states are ambiguous | Q0/Q1 typed result |
| Branch/session fence is absent after long fold calls | **Confirmed correctness gap** | Fence is checked before catch-up append, but not after reflector/pruner and immediately before returning compaction content | Q0 |
| Summary budgeting mutates durable carried-forward observation state | **Confirmed correctness gap** | `applySummaryBudget()` removes observations and `mergePipelines()` stores `budgeted.observations` in `MemoryDetailsV4` | Q0 conservative stopgap; Q4 final projection design |
| Separate custom entry and Pi compaction write can be atomic | **False assumption / confirmed transaction gap** | `pi.appendEntry()` writes immediately; hook only returns proposed compaction and Pi persists it later, acknowledged through `session_compact`/`session_compact_failed` | Q2 transaction decision |
| Reflections can accumulate indefinitely and conflict after supersession | **Confirmed architectural gap** | Existing reflections are always copied forward; summary budget never trims them; no supersession/current projection field exists | Q4 decision gate |
| A second LLM pruner is necessary | **Unproven hypothesis, not a defect** | Current two-call design exists, but no comparison against deterministic or combined-call retirement | Q3 compare designs before approval |
| Current inspected compaction observations are unrecoverable through `hm_recall` | **Not reproduced in inspected session** | All 659 details observations also existed in custom observation entries | Do not claim current loss |
| Compaction-only/bootstrap observations and reflection support are always recallable | **Confirmed compatibility gap** | `hm_recall` indexes observations only from custom entries, reflections only from compaction details, and does not traverse reflection support | Q2 recall scope/carry-forward decision |
| Existing relevance labels are reliable retirement authority | **False assumption confirmed by data** | All 659 observations in compaction `80c05f5e` were `critical` | Q5; never sole authority |
| Fold output always fits one call/correction loop | **Unproven assumption / confirmed feasibility gap** | No current output limit or worst-case contract sizing; active host exposes model limits and `length` | Q1 prerequisite |
| Main-request post-compaction cache usage is fully observable | **Unproven host capability** | Current extension telemetry excludes main requests; docs prove context estimates but not the full desired provider metrics | Q8 capability spike |
| Current telemetry measures end-to-end compaction effectiveness | **Confirmed gap** | It measures extension LLM calls, not section sizes, retained tail, or first post-compaction main context | Q4/Q8 |

Only confirmed defects and correctness gaps are mandatory implementation work. Unproven hypotheses remain decision gates or measurement spikes.

## 6. Chosen module design

Introduce one deep fold module behind a small interface. The compaction hook should not orchestrate reflector parsing, preservation rules, pruning validation, retry logic, and telemetry itself.

Illustrative interface:

```ts
interface MemoryFoldInput {
  existingReflections: readonly MemoryReflection[];
  observations: readonly ObservationRecord[];
  targetSummaryTokens: number;
}

type MemoryFoldResult =
  | {
      ok: true;
      reflections: MemoryReflection[];
      activeObservations: ObservationRecord[];
      retiredEvidence: RetiredObservationEvidence[];
      diagnostics: FoldDiagnostics;
    }
  | {
      ok: false;
      stage: "reflection" | "retirement";
      reason: FoldFailureReason;
      diagnostics: FoldDiagnostics;
    };

async function foldMemory(input: MemoryFoldInput, model: FoldModelPort): Promise<MemoryFoldResult>;
```

The exact additive persistence type for `retiredEvidence` is a decision gate, not approved by this document.

### Why this seam

- **Depth:** one interface hides provider calls, constrained tools, correction loops, schema validation, semantic safety checks, retirement policy, and telemetry.
- **Locality:** fold failures and policy changes remain in one module rather than `compaction-hook.ts`, prompts, and merge code independently interpreting results.
- **Testability:** tests inject a scripted model adapter and assert only on the fold result.
- **Caller simplicity:** the compaction hook receives either a fully validated fold result or a fail-closed result.

### Dependency classification

The provider is a true external dependency. The fold module owns a small internal model port with:

- a production adapter over the Pi AI runtime,
- a scripted test adapter.

Do not expose provider-specific request options through the fold module's public interface.

## 7. Fold protocol

### Stage 1 — Canonical evidence preparation

- Serialize all active observations and existing reflections deterministically.
- Preserve IDs, timestamps, relevance, exact content, and chronology.
- Compute a fingerprint over the input IDs/content for stale-result validation.
- Do not drop evidence for cost or cache reasons.

### Stage 2 — Reflection proposal through a tool

Use a `submit_reflections` tool rather than free-form JSON.

Contract:

```ts
{
  reflections: Array<{
    content: string;
    supportingObservationIds: string[];
  }>;
}
```

Rules:

- Provider-side constrained sampling uses `strict: "prefer"` where supported; unsupported providers may fall back, so this is not a validation guarantee.
- Local validation remains authoritative.
- Supporting IDs must be non-empty, unique, and from the exact active pool.
- Content must be non-empty and bounded per item.
- Existing reflections are preserved unless a future explicit supersession contract is approved.
- Zero proposals is a valid deliberate-empty result.
- A tool-validation error may be corrected in the same bounded agent loop.
- Uncorrected invalid output fails the reflection stage.

### Stage 3 — Reflection validation

Produce an explicit outcome containing:

- proposed count,
- accepted count,
- rejected count by reason,
- added versus strengthened reflections,
- exact covered/support sets.

Unknown support IDs, truncation, missing tool completion, terminal error, or terminal abort fail closed.

### Stage 4 — Observation retirement proposal

Do not ask the model for only a keep-list. A keep-list is omission-sensitive: one missing ID becomes deletion.

Prefer an explicit retirement proposal:

```ts
{
  retirements: Array<{
    observationId: string;
    preservedByReflectionIds: string[];
    reason: "fully-absorbed" | "exact-duplicate" | "superseded";
  }>;
}
```

Omitted observations are retained automatically.

Local policy:

- Unknown or duplicate observation IDs reject the affected proposal.
- Every cited reflection ID must exist in the validated post-reflection set.
- `fully-absorbed` requires explicit reflection preservation evidence.
- `exact-duplicate` requires deterministic local equality; the model alone cannot assert it.
- `superseded` requires explicit replacement evidence and must preserve chronology/current state.
- Uncited observations remain active.
- High/critical observations remain active unless the strict preservation gate passes.
- Ambiguity retains the observation.

### Stage 5 — Validated fold result and host transaction boundaries

The fold module returns a complete validated result and persists nothing. The compaction hook can return proposed compaction details, but Pi persists the `CompactionEntry` afterward. A separate `pi.appendEntry()` write cannot be atomic with that later host write.

The implementation must explicitly model these boundaries:

1. Optional observer catch-up custom-entry append.
2. Reflection/retirement fold result in memory.
3. Final session/branch fence and input-fingerprint validation immediately before returning compaction content.
4. Pi persistence of the returned compaction.
5. `session_compact` success or `session_compact_failed` acknowledgment.

A separate retired-evidence custom entry is not approved unless idempotency, duplicate detection, partial-write recovery, reload behavior, and host-persistence failure are defined. Prefer carrying additive evidence inside the returned compaction details when that can satisfy recall and compatibility requirements.

Reflection success followed by retirement failure must not partially change durable state in the first implementation. Conservative result: fail the fold and retain the pre-fold memory set. A later milestone may approve keeping validated new reflections while retaining all observations, but only with explicit persistence and idempotency semantics.

## 8. Output and reasoning policy

### 8.1 Quality-first reasoning

Do not default all cheaper models to minimal reasoning. Initial policy:

- Use a configurable or model-capability-aware default of `medium` for fold stages.
- Preserve full evidence input.
- Measure provider-reported reasoning tokens when available.
- Change reasoning only after differential quality evaluation.

### 8.2 Bound valid output, not analysis quality

Tool output should be sized from the maximum valid serialized result, not from arbitrary small constants.

- Reflection output budget derives from input pool size, target summary budget, model maximum, and a generous per-reflection envelope.
- Retirement output budget derives from the maximum number of explicit retirements and fixed ID/reason overhead.
- Budgets must leave room for a correction attempt.
- `stopReason: "length"` is an explicit `truncated-output` failure.
- Tool-result continuation text must be short and deterministic.

### 8.3 Retry policy

- Allow one correction within the same agent/tool loop for locally rejected arguments.
- Do not automatically launch a second fresh provider request in the first implementation.
- Provider errors, aborts, and truncation fail closed and remain user-visible through telemetry.
- A future retry may be added only with idempotency, bounded total tokens, and clear operator visibility.

## 9. Durable evidence and projection decision gate

A high-quality solution likely needs an additive distinction:

```text
active observations        included in normal memory projection
retired evidence           omitted from normal projection but recallable
reflections                durable synthesized orientation
```

Potential additive schema:

```ts
interface RetiredObservationEvidence {
  observation: ObservationRecord;
  retiredAt: string;
  reason: "fully-absorbed" | "exact-duplicate" | "superseded";
  preservedByReflectionIds: string[];
}
```

Open decisions requiring discussion before implementation:

1. Store retired evidence inside a new compaction-details version or append a separate custom entry. A separate entry additionally requires partial-write recovery because it cannot be atomic with Pi's compaction write.
2. Whether `hm_recall(reflectionId)` should recursively show supporting observations and bounded source previews.
3. Carry-forward policy across every later compaction so evidence does not disappear when older compaction entries leave the current branch view.
4. Lookup scope and branch/fork behavior: current branch only, ancestor path, or another explicitly indexed scope.
5. ID uniqueness and duplicate handling across carried-forward evidence.
6. Whether "recallable" guarantees full observation text, bounded source evidence, or paginated/chunked retrieval. Current exact-source lookup is itself bounded.
7. Retention policy for retired evidence and whether it may ever expire.
8. Migration behavior for existing V4 compactions.

Until this decision is approved, no new observation-deletion policy should ship.

## 10. Main-context projection and summary budgeting

After a safe active/retired distinction exists:

- Reflections are the primary durable orientation tier.
- Active observations preserve unresolved, unique, recent, uncertain, and not-fully-absorbed evidence.
- Retired evidence remains recallable but is omitted from the normal model-visible summary.
- VCC transcript and stale structural history trim before semantic memory.
- Protected overflow remains explicit, but should become exceptional.

Budget diagnostics must report token contribution from:

- reflection text,
- active observations by relevance,
- VCC structural sections,
- VCC transcript,
- headers/formatting,
- total target and overflow.

The summary projection must be deterministic: stable ordering, whitespace, headings, and no volatile display-only data.

## 11. Compaction effectiveness telemetry

Add a separate session-local compaction outcome aggregate, distinct from extension-call cache telemetry.

Before compaction:

- reason (`manual`, `threshold`, `overflow`),
- `tokensBefore`,
- first-kept boundary,
- estimated retained-tail tokens and entry count,
- active observation/reflection counts and tokens,
- relevance histogram.

Fold result:

- reflection stage outcome and failure reason,
- retirement stage outcome and failure reason,
- proposed/accepted/rejected/retired counts,
- covered versus uncited observations,
- reasoning/output tokens when reported.

Summary result:

- target tokens,
- actual tokens,
- protected overflow,
- section contribution estimates,
- projected `summary + retained tail` tokens.

After compaction:

- first run an API-capability spike to determine which post-compaction main-request usage and cache fields are actually observable from an extension,
- use `session_compact` to record successful persistence and `session_compact_failed` for terminal failure,
- pair the first subsequent main assistant/context measurement with the compaction attempt when the host exposes a reliable seam,
- distinguish estimated context from provider-reported request usage,
- report actual first-request context tokens/cache ratio only when authoritatively available; otherwise label estimates explicitly,
- distinguish first cold-transition request from later requests.

This telemetry remains content-free and session-local unless persistence is separately approved.

## 12. Progressive implementation milestones

### Q0 — Immediate safety patch — implemented locally

Implemented as a retention-first foundation rather than isolated guards. Production compaction now crosses one `foldMemory()` seam: below-threshold work is skipped, valid reflections may enrich memory, every failure retains the pre-fold state, and no observation-retirement interface exists in the active path.

Implemented confirmed critical defects in this order:

1. Disable all observation deletion from the current omission-sensitive keep-list pruner, including its local low/medium fallback. Until the approved retirement contract exists, every qualifying compaction retains the complete pre-prune observation set.
2. Add final session/branch fence validation immediately before returning compaction content so navigation during reflector/pruner work cannot apply stale results.
3. Do not run retirement/pruning after reflector failure or deliberate-empty-with-no-new-coverage.
4. Make reflector outcome explicit to the caller and validate every supporting observation ID against the active pool.
5. Classify `stopReason: "length"` as truncation rather than provider success.
6. Add explicit fold outcomes including `truncated-output`, `missing-tool-call`, `invalid-schema`, and `unsafe-retirement`.
7. Prevent summary-budget trimming from silently deleting the only carried-forward observation representation. The Q0 stopgap is conservative: if budgeting would remove observations before Q2/Q4 define durable retired evidence, preserve those observations in details and report that projection/durable state remain intentionally decoupled only where fully tested.
8. Add focused regression tests for all paths above, including empty/incomplete/unknown/duplicate/keep-all pruner outputs, branch change during fold, unsupported reflection IDs, and `length` stop reason.

**Risk:** high correctness, small code surface
**Rollback:** revert to retaining all observations
**Verification:** 163 tests across 18 files pass, TypeScript and the production build pass, AFT reports no changed-scope diagnostics/dead code/unused exports, and the installed bundle matches the build byte-for-byte. An independent review found one observer-wait fence-transition defect; it was corrected with a shared append-only transition validator and session/navigation regressions before this checkpoint.

**Done when:** no valid-looking model output, summary-budget trim, or stale branch result can silently delete or misapply observations.

### Q1 — Deep fold module and constrained reflection tool

- Add a narrow runtime-capability adapter and tests for the active host's constrained tools, stop reasons, reasoning options, and output limits before relying on them. Full dependency alignment remains Q9.
- Introduce the fold module and scripted model port.
- Move reflection orchestration, validation, and telemetry behind its interface.
- Use constrained `submit_reflections` tool calls with strict-prefer runtime support.
- Add bounded correction behavior and dynamic output budgets with a pre-call feasibility check: model output limit, reasoning-token behavior, worst-case schema size, per-attempt ceiling, and total loop ceiling must fit. If not, fail closed before the provider call rather than truncate the contract.
- Preserve current memory outputs on every failure.

**Risk:** standard/high
**Rollback:** old reflector path behind one temporary internal adapter until differential tests pass
**Done when:** representative large pools reliably produce valid reflection outcomes without free-form JSON parsing.

### Q2 — Retired-evidence persistence decision

- Decide and document the additive data shape and migration policy.
- Add direct and reflection-linked recall behavior.
- Prove old sessions remain readable.
- Do not implement retirement before this decision is approved.

**Risk:** high/persisted schema
**Decision gate:** user approval required.

### Q3 — Retirement architecture decision and local safety policy

Before choosing orchestration, compare three designs against the Q6 fixtures:

1. Deterministic-only retirement for locally provable exact duplicates and explicit supersession.
2. Preservation/retirement claims emitted in the reflection call.
3. A separate constrained retirement-model call.

Approve a second LLM stage only if it provides material safety or quality benefit over the first two options. Whichever design is selected must:

- replace omission-sensitive keep lists with explicit retirement proposals,
- implement local absorption, exact-duplicate, and supersession validation,
- carry active and retired evidence through the approved Q2 host transaction design,
- keep ambiguity and invalid proposals active,
- revalidate the branch/session fence and input fingerprint immediately before returning compaction content.

**Risk:** high/data retention
**Rollback:** retain all observations and keep accepted reflections only if that partial behavior was explicitly approved; otherwise fail the whole fold
**Done when:** no observation disappears without a locally auditable preservation reason.

### Q4 — Reflection lifecycle, main-context projection, and compaction effectiveness

Before claiming convergence, decide additive reflection lifecycle semantics:

- strengthening versus creating a new reflection,
- explicit supersession/current-state relationships,
- whether historical superseded reflections stay recallable but leave the normal projection,
- compatibility for legacy string reflections,
- prevention of contradictory active reflections.

Until that persisted-schema decision is approved, active-observation retirement alone is not expected to guarantee convergence because existing reflections are currently protected and carried forward indefinitely.


- Render only current/projected reflections plus active observations into the normal summary.
- Keep retired evidence recallable outside the main projection.
- Add section-level summary accounting and projected post-compaction size.
- Add real-session fixture regressions for 300–900 observation pools.

**Risk:** high/context behavior
**Done when:** representative long-session compactions materially reduce context while recall and differential quality tests preserve required information.

### Q5 — Relevance calibration and existing-pool recovery

- Evaluate future observer relevance distribution.
- Do not mass-demote historical critical observations.
- Let validated reflection/retirement operate independently of relevance labels.
- Consider an explicit review/reclassification operation only if still needed after safe folding.

**Risk:** medium/high memory policy
**Decision gate:** approve any automated reclassification separately.

### Q6 — Quality evaluation harness

Create deterministic fixtures from sanitized representative sessions and assertions covering:

- user constraints,
- corrections and supersession,
- completed work,
- exact identifiers/errors,
- chronology,
- source provenance,
- reflection support,
- recall after retirement,
- summary token reduction.

Compare baseline versus candidate on:

- required-fact retention,
- unsupported claims,
- contradictions,
- observation retirement safety,
- summary size,
- provider usage.

LLM-as-judge may be supplementary but cannot be the sole authority. Critical facts require deterministic fixture assertions.

### Q7 — Compaction-model cache optimization

Only after Q1–Q6 are green:

- Canonicalize shared reflection/retirement memory prefixes.
- Measure provider cache reuse and total cost.
- Preserve all evidence and reasoning policy.
- Revert experiments that reduce quality.

The unified cache-continuous fold remains optional and requires a separate approval if the simpler shared-prefix design is insufficient.

### Q8 — Main-model cold-transition evaluation

- Begin with an extension API-capability spike; do not assume provider-reported main-request input/cache data is exposed.
- Measure the first post-compaction main request separately using authoritative usage when available and clearly labeled context estimates otherwise.
- Optimize summary size and deterministic rendering.
- Confirm subsequent requests regain cache reuse.
- Do not retain old raw history merely to raise the first request's cache percentage.

### Q9 — SDK alignment

- Align development dependencies/imports with the supported `@earendil-works` host in a separate compatibility change.
- Verify constrained tools, stop reasons, reasoning options, cache routing, build externals, and package metadata.
- Do not mix this with memory-policy changes.

## 13. Test matrix

### Fold interface tests

- valid reflection proposal,
- deliberate empty,
- invalid support ID,
- duplicate support IDs,
- malformed tool arguments then correction,
- uncorrected invalid tool arguments,
- provider error,
- abort,
- length/truncation,
- missing tool call,
- stale input fingerprint.

### Retirement safety tests

- empty retirement proposal retains all,
- omitted observation retains it,
- unknown observation/reflection ID rejected,
- uncited high/critical retained,
- cited but incompletely preserved retained,
- exact duplicate requires local equality,
- supersession preserves current state and chronology,
- invalid retirement causes no partial persistence,
- branch/session change during reflection or retirement rejects the result,
- Pi compaction-persistence failure follows the approved recovery/idempotency policy,
- repeated compactions carry retired evidence without duplication or orphaning.

### Persistence and recall tests

- old V4 details load unchanged,
- approved additive details round-trip,
- reflection recall resolves retained/retired evidence according to the approved branch scope and bounded/full-output contract,
- source previews remain available where branch entries exist,
- missing raw sources are reported explicitly,
- repeated compactions do not orphan evidence.

### Effectiveness tests

- 300, 600, and 900 observation fixtures,
- summary target respected when current projected protected content fits,
- overflow explicit when it genuinely cannot fit,
- repeated folds converge rather than grow monotonically,
- `summary + retained tail` materially below `tokensBefore`,
- deterministic rendering produces byte-identical output for identical state.

## 14. Acceptance criteria

The fold-quality roadmap is complete only when:

1. The reflector and retirement stages return validated structured outcomes on representative large pools.
2. No unsafe model output can delete uncited observations.
3. Every retired observation has a durable audit trail and preservation reason, carried across repeated compactions and recallable within the explicitly approved branch/output scope.
4. Existing sessions remain compatible or have an explicit migration path.
5. Reflection and retirement failures leave memory unchanged.
6. A 40–90% context compaction typically produces a materially smaller post-compaction context, with exact expectations qualified by Pi's configured `keepRecentTokens` and fixed system/tool overhead.
7. Protected overflow is exceptional and diagnosed by contribution, not normal steady-state growth.
8. Main-model first-request cold cost and later warm reuse are measured separately.
9. Compaction-model cost/cache improvements do not reduce memory quality.
10. Focused tests, full typecheck, relevant suite, production build, installation hash, and documentation all pass.

## 15. Risk register and wrong-assumption checks

| Assumption or risk | Current judgment | Required check |
|---|---|---|
| Constrained tool sampling alone guarantees valid output | False; unsupported providers may fall back under `strict: "prefer"`, and semantic validation is still local | Keep local validation authoritative and test supported/fallback paths |
| More reasoning always improves memory quality | Unproven; excessive reasoning may still produce poor tool arguments or cost | Start quality-first at medium, measure reasoning tokens and fixture quality before tuning |
| A reflection citing an observation makes the observation removable | False | Require explicit preservation/retirement claim and local policy |
| Critical relevance reliably marks only indispensable facts | False for existing pools | Treat relevance as a signal, never sole retirement authority |
| A fixed reflection-count cap is safe | False | Bound output by valid serialized capacity and target projection, not arbitrary item count |
| A successful provider response means a successful fold | False | Track transport and lifecycle outcomes separately |
| The first post-compaction main request can be made fully warm | Generally false for prefix caches | Minimize its total size and measure stable reuse afterward |
| A lower post-compaction token count always means better quality | False | Pair effectiveness with deterministic required-fact and contradiction checks |
| Retired evidence can live only in old compaction details forever | Risky; later branches/compactions may make lookup incomplete | Approve an additive persistence/recall model before retirement |
| Existing reflection IDs are globally unique enough for all future migrations | Probably, but generated base-36 IDs and legacy strings coexist | Preserve compatibility and validate IDs at schema transition |
| One giant fold call scales indefinitely | Unproven; large pools may exceed model attention or output reliability | Add 300/600/900 fixtures; design staged batches only if quality evidence requires it |
| Retiring active observations alone makes memory converge | False while every historical reflection remains protected/current | Add explicit reflection strengthening/supersession/projection decision before claiming convergence |
| Splitting reflection into batches is automatically safe | False; cross-batch duplication and global supersession can be missed | Defer batching until a deterministic merge and global review stage is designed |
| Pi's retained tail is controlled by this extension | False; Pi selects `firstKeptEntryId` from `keepRecentTokens` | Report retained-tail contribution and do not promise a fixed post-compaction percentage |
| Historical source entries always remain on the current branch | False | Recall must report missing sources and retired evidence must not depend solely on raw-entry availability |
| Pruner is necessary as a second LLM stage | Unproven | After explicit reflection coverage exists, compare model retirement with deterministic conservative retirement before retaining two stages |

## 16. Pauses and decision gates

Pause and request discussion before:

- introducing a new persisted memory-details version,
- defining reflection supersession or removing historical reflections from the normal projection,
- deciding where retired evidence lives,
- allowing accepted reflections to persist when retirement fails,
- automated reclassification of existing observations,
- changing default reasoning level based on cost rather than quality evidence,
- selecting deterministic, combined-call, or separate-LLM retirement orchestration,
- unified reflection/retirement agent orchestration,
- any hard deletion or expiration policy for retired evidence.
