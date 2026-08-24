# Third-Party Cache and Memory Review — Independent Verification and Progressive Roadmap

**Date:** 2026-08-25
**Status:** Analysis complete; progressive implementation tracked below
**Source review:** [`pi-hybrid-memory-cache-independent-third-party-review.md`](./pi-hybrid-memory-cache-independent-third-party-review.md)

## Purpose

This document records an independent verification of the third-party architectural review of `pi-hybrid-memory`. The source review is treated as a second opinion and hypothesis list, not as an authority.

Each material claim was checked against the current implementation, tests, Pi lifecycle behavior, installed dependency versions, and available post-epoch telemetry. This document is the tracking source for later progressive implementation. It is not an instruction to implement every proposal.

The governing constraint is:

> Memory quality, durable coverage correctness, and cache efficiency are co-equal. A cache optimization is not successful if it weakens evidence, chronology, correction handling, provenance, or recoverability.

## Current architectural assessment

The bounded append-only observer epoch remains the correct foundation:

- Pi branch entries are authoritative durable state.
- Epoch state is runtime-only and disposable.
- A cold epoch freezes a deterministic memory baseline.
- Warm runs append source deltas and exact observer/tool transcript suffixes.
- Proactive observation persists durable coverage before committing runtime epoch state.
- Failed or aborted observation does not advance coverage.
- Compaction catch-up processes bounded chunks fail-closed.
- Successful compaction invalidates the old epoch.
- Telemetry distinguishes local cold/warm state from provider-reported cache behavior.

Post-update telemetry confirms meaningful cross-run cache reuse, including warm first observer calls with approximately 85–95% provider-reported cache reads. The architecture should be strengthened rather than replaced.

## Verification summary

| Review claim or direction | Verdict | Priority |
|---|---|---:|
| Catch-up `expectedCoverageId` can validate the epoch against itself | **Confirmed correctness defect** | P0 |
| Epoch stale-transaction checks fully cover concurrency | **Partially valid; production serialization is good, fork lifecycle fencing is incomplete** | P0 |
| Successful compaction invalidation is correct | **Confirmed, with a later-failure caveat** | P0/P1 |
| Forked catch-up is atomic | **Locally confirmed; integration behavior after later failure needs tests** | P0 |
| Pending observations should precede committed observations as fallback | **Semantically reasonable but not an authoritative coverage solution** | Replace approach |
| 60k chunk plus 96k epoch leaves only about 30k | **Incorrect model of current implementation** | Reject |
| Proactive reflection near epoch capacity is an easy high-leverage win | **Potentially useful but high-complexity and memory-risky** | Defer/design first |
| Split reflections and observations into separate baseline messages | **Low-risk experiment with narrower, provider-dependent benefit** | P3 |
| Deduplicate identical/near-identical raw content | **Exact duplicates may be testable; fuzzy dedup is memory-risky** | P3/defer |
| Add baseline/reset-frequency telemetry | **Confirmed useful, low memory risk** | P1 |
| Summary budget is suspect under protected overflow | **Policy is sound and tested; estimator remains approximate** | P2/P3 |
| Centralize the 6,144-token reservation | **Confirmed small locality improvement** | P1 |
| Provider caching is limited as described by the review | **Version-specific and partly inaccurate** | Qualify |
| Compaction cache optimization mainly concerns final summary generation | **Incorrect: catch-up, reflector, and pruner are the only compaction-time LLM calls; VCC and merge work are local** | Clarify |
| Compaction-time cache reuse can be improved without reducing memory input | **Partly confirmed: catch-up continuity and telemetry are low-risk; reflector/pruner prefix sharing requires measured experiments** | P0/P1/P3 |
| Reflector and pruner should be combined immediately | **Potentially high cache benefit but unproven quality equivalence and higher orchestration risk** | Defer behind experiment |

---

## P0 — Correctness and branch authority

### 1. Replace self-referential catch-up coverage validation

#### Confirmed problem

Compaction catch-up currently initializes `expectedCoverageId` by preferring:

```text
draftEpoch.stats().coverageEndId
```

It then asks that same draft epoch to compare its state against the supplied value. When the fork is active, the comparison is effectively:

```text
epoch coverage == epoch coverage
```

This does not prove that the retained epoch is continuous with the currently active Pi branch.

#### Reachable risk

A warm epoch associated with branch A may survive a tree/branch transition and be reused during catch-up on branch B if the runtime is not fully replaced. The stale context can influence observer deduplication and interpretation before compaction.

#### Required design

Create one branch-authoritative coverage seam used by both proactive observation and compaction catch-up. Conceptually:

```ts
resolveObservationCoverageAnchor(entries): {
  coveredSourceId?: string;
  coveredSourceIndex: number;
}
```

The authoritative value must come from durable observation-entry coverage (`coversUpToId`) resolved against the current branch. It must not come from:

- Epoch state
- The last observation record
- `sourceEntryIds` provenance
- A guessed compaction boundary when a durable coverage marker exists

#### Completion criteria

- Proactive observation and catch-up use the same branch-derived anchor.
- An active epoch from another branch causes a cold `coverage-discontinuity` reset.
- Empty coverage entries are handled even though they contain no observation records.
- No existing session or memory schema migration is required.

#### Required tests

- Warm epoch from branch A, then catch-up on branch B.
- Empty observation entry as latest durable coverage marker.
- Missing covered source entry with documented safe fallback.
- Linear same-branch catch-up remains warm.

### 2. Fence asynchronous catch-up against session and branch changes

#### Confirmed gap

`ObserverEpochManager.fork()` copies the live transaction counter, but the live manager and fork evolve independently afterward. Invalidating the live manager during asynchronous catch-up does not stale the fork.

#### Required design

Capture a lifecycle fence when catch-up begins, such as:

```text
Pi session identity
+ branch/tree generation or stable branch fingerprint
+ starting durable coverage anchor
```

Revalidate it immediately before any durable append. If the active session or branch changed, discard the draft and cancel the compaction attempt.

The exact fingerprint should use Pi-supported stable information rather than hashing prompt content.

#### Completion criteria

- A catch-up started on one active branch cannot append into a different active branch.
- Session switch, fork, tree navigation, or reload during catch-up causes safe cancellation.
- No prompt or source content is retained for fencing.

#### Required tests

- Session invalidation while a catch-up observer request is in flight.
- Branch navigation while the fork is active.
- Unchanged branch successfully persists consolidated catch-up observations.

### 3. Define epoch behavior after catch-up persistence but later compaction failure

#### Current behavior

Catch-up may append a consolidated observation entry before reflection, pruning, VCC extraction, budgeting, and final compaction assembly. If later work fails, durable coverage changed but successful-compaction invalidation is never reached.

Normal proactive observation should later detect the branch mismatch, but retaining a known-stale live epoch is unnecessary risk.

#### Preferred conservative policy

Once catch-up coverage is durably appended outside the live epoch, invalidate the live epoch immediately. An extra cold observer call is preferable to retaining runtime context known not to include the new durable coverage entry.

Do not attempt to merge the draft into the live epoch unless a clear transactional interface can prove equivalent or stronger safety.

#### Required tests

- Catch-up append succeeds, later compaction assembly throws, next observer is cold and rebuilt.
- Successful compaction still reports reset reason `compaction`.
- Failed catch-up before persistence leaves the live epoch unchanged.

### 4. Complete the `overrideDefaultCompaction` off-switch

#### Confirmed configuration defect

The proactive compaction trigger respects `overrideDefaultCompaction: false`, but `session_before_compact` still intercepts manual or Pi-triggered compaction.

#### Completion criteria

- When disabled, the hook returns `undefined` and Pi performs its default compaction.
- Hybrid proactive compaction remains disabled.
- Observer operation may continue independently if that is the documented policy.
- README and tests match actual behavior.

---

## P1 — Measurement and small design cleanup

### 5. Add aggregate epoch and reset telemetry

Current telemetry retains whole-session LLM usage totals but only ten recent call records. Reset reasons and cold/warm metadata are not aggregated, so long-session trends cannot be evaluated reliably.

#### Proposed aggregate-only metrics

```text
epoch resets by reason:
  session-change
  compaction
  coverage-discontinuity
  capacity
  compatibility-change
  manual

observer transactions:
  prepared
  committed
  failed/abandoned
  cold
  warm

size/headroom:
  latest/min/max baseline tokens
  latest/min/max source-delta tokens
  latest/min/max retained transcript tokens
  minimum observed fresh capacity headroom

cache outcomes:
  locally warm + provider cache read > 0
  locally warm + provider cache read = 0

compaction catch-up:
  chunk count per compaction
  first chunk cold/warm and reset reason
  baseline/delta/transcript tokens
  provider cache-read tokens per chunk
  minimum capacity headroom

reflection and pruning:
  input observation count/tokens
  provider cache-read tokens
  outcome and skip reason
  reflections proposed/accepted
  observations before/after pruning
```

#### Constraints

- Session-local only unless persistence is separately approved.
- Aggregate metadata only.
- No prompts, observations, source text, API keys, headers, or content hashes.
- Missing provider usage remains `unknown`, not zero.

#### Completion criteria

`/hm-cache-info` can answer:

- Are capacity resets common?
- Are coverage discontinuities recurring in linear use?
- Is the durable baseline growing?
- How often is a locally warm request a provider-side cache miss?

### 6. Centralize observer fixed-token reservation

`6_144` currently appears in both proactive observation and compaction catch-up paths.

Create one named constant, for example:

```ts
OBSERVER_FIXED_TOKEN_RESERVE
```

Do not yet claim this value can be exactly derived from prompt text. Provider framing, tool schemas, and tokenizer overhead are not represented by the local estimator.

#### Completion criteria

- One source of truth.
- Both call paths use it.
- Capacity tests lock the shared behavior.

### 7. Add integration-level epoch tests

The manager state machine is tested well, but several caller invariants are not.

Add focused integration seams for:

- Catch-up coverage anchor selection
- Catch-up fork cancellation
- Catch-up consolidated persistence
- Successful compaction invalidation
- Failure after catch-up persistence
- Empty coverage entries
- Branch/session changes during asynchronous work

Tests should exercise durable branch entries and epoch state together rather than only testing `ObserverEpochManager` in isolation.

---

## P2 — Memory quality and long-session resilience

### 8. Improve per-observation provenance precision

#### Current limitation

Every observation produced during a chunk receives every allowed source entry ID:

```text
observation.sourceEntryIds = all chunk source IDs
```

This makes provenance broad rather than precise.

#### Consequences

- `hm_recall` may display unrelated evidence.
- Reflection support can inherit imprecise provenance.
- Pruning decisions have weaker evidence confidence.
- Large chunks make the problem worse.

#### Proposed direction

Extend the observer tool contract so each observation cites a validated, non-empty subset of the current chunk’s allowed source IDs.

#### Safety requirements

- Reject IDs outside the allowed chunk set.
- Preserve compatibility with existing observations lacking precise subsets.
- Do not discard otherwise valid observations solely because a model emits imperfect provenance until behavior has been evaluated.
- Consider non-blocking validation/diagnostics before strict rejection.

### 9. Segment oversized single source entries

#### Current limitation

When one source entry exceeds the observer budget, serialization sends a marked head/tail excerpt and marks the whole entry covered. The original source remains recallable, but durable semantic observations can miss important middle content.

#### Proposed direction

Represent within-entry coverage as bounded segments while retaining the original Pi source entry ID and an internal segment cursor/range.

#### Design questions

- How is partial coverage persisted without breaking `ObservationEntryData` compatibility?
- Can a sidecar segment marker remain additive and backward compatible?
- How does exact-source recall continue to return the original complete entry?
- How are overlapping or retried segments deduplicated?
- What segment boundaries preserve code/log meaning better than arbitrary characters?

This is a higher memory-quality priority than fuzzy raw-content deduplication.

### 10. Define a baseline-pressure policy

#### Potential long-term failure mode

A fresh observer request must fit:

```text
fixed reservation
+ durable baseline
+ instructions
+ source delta
```

The durable baseline contains active reflections plus committed and pending observations. If protected or pending memory grows close to the epoch limit, no meaningful source delta may fit.

Compaction currently performs:

```text
catch-up
→ reflection/pruning
→ final compaction
```

This can create a circular dependency:

```text
baseline too large for catch-up
→ catch-up required before reflection/pruning
→ reflection/pruning could reduce baseline
→ compaction cancels
```

#### First step

Define and measure a minimum fresh-delta reserve. Surface explicit `baseline-pressure` diagnostics rather than treating all failures as generic fresh-baseline overflow.

#### Candidate future remedy: compaction-scoped staged fold

1. Temporarily reflect/prune already durable memory.
2. Use the staged reduced baseline for catch-up.
3. Process the complete gap.
4. Reconcile catch-up observations and run final fold if required.
5. Persist only through successful compaction.
6. Discard all staged results on failure.

This requires design and behavioral evaluation before implementation. Background proactive pruning is not approved by this roadmap.

### 11. Improve summary token estimation without weakening protected memory

The current budget is policy-correct but uses an approximate word-based estimator. `maxSummaryTokens` is therefore a growth target, not a strict active-model token guarantee.

Potential future work:

- Compare the current estimator against representative provider tokenizers.
- Add conservative model-family factors if exact tokenization is unavailable.
- Preserve `protectedOverflow` semantics.
- Never solve estimator error by silently dropping reflections or critical observations.

---

## P3 — Cache refinements requiring measurement

### 12. Clarify the compaction-time cache surface

Hybrid compaction does not use one monolithic summarization LLM call. Its pipeline is:

```text
observer catch-up                 LLM, zero or more calls
reflector                         LLM, only when the reflection gate is reached
pruner                            LLM, after a qualifying reflector run
VCC extraction and historical merge   local deterministic code
summary budgeting and assembly        local deterministic code
```

The cache optimization surface is therefore limited to catch-up, reflector, and pruner. The first main-agent request after successful compaction establishes a new provider-visible prefix because raw history has been replaced by the new summary and retained tail; a cold or reduced-reuse request there is expected and should not be treated as a compaction defect.

#### Quality-neutral goals

- Reuse catch-up context only when branch-authoritative continuity is proven.
- Avoid false cold resets without weakening valid reset conditions.
- Keep bounded catch-up chunks contiguous within one compaction attempt.
- Measure cache behavior separately for catch-up, reflector, and pruner.
- Preserve every observation, reflection, coverage tag, chronology marker, and provenance input used by the current contracts.

#### Out of scope

- Manipulating the main Pi conversation solely to raise its post-compaction cache percentage.
- Hiding or deleting memory evidence to reduce prompt size.
- Treating locally warm state as proof of provider cache availability.

### 13. Measure compaction LLM behavior before changing prompts

Add aggregate and recent-call telemetry sufficient to answer:

```text
Catch-up:
  How many chunks ran?
  Was the first chunk cold or warm?
  Why did a cold reset occur?
  How much prefix reuse was predicted and reported?

Reflector:
  Did it skip below threshold, succeed, return deliberately empty,
  return malformed output, fail, or abort?
  How many reflections were proposed and accepted?

Pruner:
  Did it run and succeed?
  How many observations existed before and after?
  How much cache reuse was reported?
```

Metadata must remain session-local and content-free unless a separate persistence decision is approved.

#### Completion criteria

- `/hm-cache-info` distinguishes proactive observer calls from compaction catch-up calls.
- Reflector/pruner skip and outcome reasons are visible without retaining prompts or memory text.
- Cold/warm local state and provider cache-read usage remain separate measurements.
- A representative qualifying compaction can be compared before and after later experiments.

### 14. Evaluate a stable common memory prefix for reflector and pruner

The current reflector and pruner prompts serialize overlapping memory through different operation-specific structures. A low-risk experiment may factor their prompts into:

```text
stable shared memory-management instructions
stable canonical memory serialization
operation-specific suffix and output contract
```

The experiment must preserve all current information and validation behavior. It must not remove coverage annotations from pruning or weaken the reflector’s provenance requirements.

#### Expected limitation

Different system prompts, operation cache identities, provider cache breakpoints, and pruner dependence on newly generated reflections may limit cross-operation reuse. Benefit is provider-dependent and must be measured rather than assumed.

#### Acceptance criteria

- Prompt contract tests prove that no instruction or memory input was lost.
- Representative observation pools produce memory outputs of equivalent or better quality.
- Provider cache-read tokens or total cost improve measurably.
- The experiment is reverted if quality equivalence cannot be established.

### 15. Prototype a unified transactional fold only if measurements justify it

A larger future experiment could combine reflection and pruning as sequential stages of one cache-continuous agent conversation:

```text
shared durable-memory context
→ validated reflection proposal
→ appended validated result
→ pruning decision
```

This offers the largest theoretical cache gain because the pruning request could reuse the reflector request as an exact prefix. It is not currently approved for production implementation because it changes orchestration, failure isolation, telemetry attribution, and fallback behavior.

#### Required safeguards

- Persisted `MemoryDetailsV4` and summary contracts remain unchanged.
- Reflection and pruning outputs are validated independently.
- A reflection success followed by pruning failure retains the current safe fallback semantics.
- Abort, malformed output, and provider failure cannot partially commit memory state.
- Differential evaluation uses representative long-session observation pools.

Proceed only if telemetry shows reflector/pruner cost is material and the simpler shared-prefix experiment is insufficient.

### 16. Evaluate separate reflection and observation baseline messages

Potential shape:

```text
message 1: stable reflection tier
message 2: observation tier
message 3+: append-only deltas/transcript
```

Potential benefit: some providers may reuse an unchanged reflection prefix across a cold epoch reset when observations changed.

Limits:

- Both tiers still count toward capacity.
- It does not reduce fresh request size by itself.
- Exact token-prefix providers may already reuse the unchanged portion.
- Cache benefit is provider-dependent.

Only evaluate after telemetry can compare cold-reset reuse and baseline composition.

### 17. Consider conservative exact-duplicate source compression

Do not begin with fuzzy or near-duplicate semantic matching.

A safer experiment is limited to large byte-identical tool results while preserving:

- Every occurrence’s source ID
- Chronological position
- Timestamp and tool identity
- Explicit recurrence semantics
- A stable reference to the original full-content source entry

Example observer representation:

```text
[Source entry id: current]
[Repeated byte-identical tool result; same content as source original]
```

Validate that the observer can still record facts such as “the same failure recurred.”

### 18. Align development dependencies with the supported Pi host

The project currently builds and tests against `@mariozechner/*` 0.66.1 while the active host is `@earendil-works/*` 0.84.3. Lifecycle types and provider cache behavior have already diverged.

Treat alignment as a separate compatibility milestone:

- Decide the supported Pi distribution and minimum version.
- Update development dependencies and imports deliberately.
- Verify extension API, agent-loop signatures, provider options, and packaging.
- Preserve compatibility with existing installed sessions and configuration.
- Do not mix this dependency change into memory-policy work.

---

## Rejected or deferred proposals

### Do not lower `observerChunkMaxTokens` based only on 60k/96k arithmetic

Current serialization already caps source content to the fresh capacity remaining after baseline, instructions, and the fixed reservation. The configured 60k value is a maximum, not an unconditional request size.

Revisit only if aggregate telemetry shows poor extraction quality, frequent capacity rollover, excessive cost, or weak cache reuse attributable to chunk size.

### Do not trigger proactive reflection/pruning without a persistence design

Early reflection/pruning requires additional model calls, concurrency handling, durable-state semantics, restart recovery, and evidence that transient state is not over-promoted or uniquely useful observations removed too early.

### Do not perform fuzzy raw-content deduplication

Near-identical outputs can contain the changed line that matters. Repetition can itself be evidence. Fuzzy collapse risks chronology, provenance, and memory quality.

### Do not trade memory evidence for cache metrics

Do not remove or shorten the following merely to raise cache-hit percentages:

- Reflections
- Prior observations
- Corrections and supersession history
- Timestamps where chronology matters
- Provenance
- Technical identifiers or exact errors
- Deduplication context

### Do not replace protected overflow with hard truncation

Reflections and critical observations remain protected. If protected content exceeds the configured summary ceiling, surface the overflow explicitly rather than silently deleting it.

---

## Provider-cache interpretation

Provider behavior must be qualified by active runtime version and endpoint.

- The repository currently develops against `@mariozechner/pi-ai` 0.66.1.
- The active Pi host inspected during this review is `@earendil-works/pi-ai` 0.84.3.
- Newer provider adapters expose more cache-key, retention, compatibility, and affinity behavior than the older development package.
- A locally warm epoch proves structured-message continuity, not provider cache retention.
- `warm + cache read 0` is a provider/routing/TTL miss, not necessarily an epoch failure.
- Exact append-only prefix stability remains the portable architectural foundation.

---

## Progressive implementation order

Each milestone should be independently reviewable, tested, and reversible.

### Milestone A — Branch-authoritative coverage

- Replace self-referential catch-up anchor.
- Add branch/session generation fence.
- Define failure-after-catch-up invalidation.
- Complete compaction override off-switch.
- Add focused integration tests.

**Risk:** correctness-sensitive
**Expected benefit:** prevents stale cross-branch observer context and restores trustworthy continuity checks

### Milestone B — Epoch observability

- Add reset/cold/warm histograms.
- Add baseline/delta/transcript/headroom trends.
- Centralize fixed reservation.

**Risk:** low
**Expected benefit:** enables evidence-based tuning and diagnosis

### Milestone C — Provenance quality

- Add per-observation validated source subsets.
- Preserve backward compatibility and non-blocking diagnostics initially.

**Risk:** medium
**Expected benefit:** more trustworthy recall, reflection support, and pruning

### Milestone D — Oversized-entry coverage

- Design and evaluate segmented source coverage.
- Preserve exact-source recall and compatibility.

**Risk:** medium/high
**Expected benefit:** avoids semantic blind spots in very large tool/subagent outputs

### Milestone E — Baseline pressure

- Add explicit pressure telemetry and minimum delta reserve.
- Design staged compaction fold only if measurements show a real need.

**Risk:** high if lifecycle changes are required
**Expected benefit:** prevents long-session memory growth from blocking catch-up

### Milestone F — Compaction cache observability

- Distinguish proactive observer and compaction catch-up calls.
- Add catch-up chunk, prefix, reset, and headroom metrics.
- Add reflector/pruner skip, outcome, input-size, cache, and accepted-result metrics.
- Capture one representative qualifying compaction before prompt experiments.

**Risk:** low
**Expected benefit:** identifies whether catch-up, reflection, or pruning is the material compaction-time cost and prevents optimization by assumption

### Milestone G — Quality-neutral compaction prefix experiment

- Factor reflector/pruner inputs through a canonical shared memory serializer.
- Preserve operation-specific instructions, coverage annotations, provenance, schemas, validation, and fallbacks.
- Compare memory quality, provider cache reads, and total cost against the baseline from Milestone F.

**Risk:** low to medium; prompt ordering can still affect model behavior
**Expected benefit:** provider-dependent partial prefix reuse without reducing memory input

### Milestone H — Optional unified transactional fold prototype

- Prototype reflection and pruning as validated stages of one cache-continuous conversation only if Milestone F shows material cost and Milestone G is insufficient.
- Keep persisted output contracts unchanged.
- Require differential quality evaluation and complete failure isolation.

**Risk:** high orchestration and memory-quality risk
**Expected benefit:** potentially large reuse for the pruning stage

### Milestone I — Other measured cache refinements

- Evaluate split observer baseline tiers.
- Evaluate exact duplicate compression.
- Compare with telemetry before and after.

**Risk:** low to medium depending on experiment
**Expected benefit:** provider-dependent incremental cache improvement

### Milestone J — SDK alignment

- Align development dependencies with the supported Pi host in an isolated compatibility change.

**Risk:** structural/compatibility
**Expected benefit:** compile-time coverage of actual runtime contracts and provider behavior

---

## Definition of done for future improvements

A future cache or memory architecture change is complete only when:

- Durable branch coverage remains authoritative.
- Failure cannot advance coverage falsely.
- Session/branch changes cannot receive stale observer output.
- Existing sessions remain readable or have an explicit migration plan.
- `hm_recall` provenance remains at least as precise as before.
- Critical observations and reflections are not silently removed.
- Cache improvement is measured with locally cold/warm state separated from provider cache behavior.
- Compaction cache measurements distinguish catch-up, reflector, and pruner; local VCC/merge work is not misreported as provider activity.
- The first main-agent request after compaction is evaluated separately from extension-owned compaction LLM calls.
- Targeted tests cover normal behavior and the real failure mode.
- Full typecheck, tests, and production build pass.
- README, PLAN, and DEVELOPMENT records are updated where durable behavior changed.

## Tracking status

| Milestone | Status |
|---|---|
| Localized `/hm-memory` context and reflection-gate reporting | Implemented locally; focused tests, typecheck, build, and installation verified; not committed |
| A — Branch-authoritative coverage | Implemented locally: shared durable coverage anchor, session/leaf catch-up fence, catch-up-persisted epoch invalidation, and functional compaction override off-switch; focused verification complete, not committed |
| B — Epoch observability | Not started |
| C — Provenance quality | Implemented locally: optional validated per-observation source subsets with legacy all-chunk fallback and observer compatibility-version bump; focused verification complete, not committed |
| D — Oversized-entry coverage | Design not started |
| E — Baseline pressure | Evidence gathering not started |
| F — Compaction cache observability | Implemented locally: observer proactive/catch-up source, cold/warm/reset aggregates, provider hit/miss counts, capacity headroom, shared fixed reservation, and reflector/pruner skip/outcome/input/result counts; focused verification complete, not committed |
| G — Quality-neutral compaction prefix experiment | Deferred pending Milestone F telemetry |
| H — Optional unified transactional fold prototype | Not approved; evidence and quality evaluation required |
| I — Other measured cache refinements | Deferred pending telemetry |
| J — SDK alignment | Deferred as separate compatibility milestone |
