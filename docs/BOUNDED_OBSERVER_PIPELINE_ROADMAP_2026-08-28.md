# Bounded Observer Pipeline Roadmap

**Status:** M1–M6 complete; repository bundle validated, installed rollout remains separate

**Scope:** Observer context, observer segment protocol, durable coverage orchestration, and compaction catch-up behavior

**Primary goal:** Keep observation operational and token-efficient as a session grows, while preserving immutable evidence, memory quality, and cache-prefix reuse.

## 1. Production evidence

A real long session reached this state:

```text
active observer baseline prefix: ~95,059 tokens
configured observer limit:        96,000 tokens
fresh source capacity:            hundreds of tokens
```

A manual compaction then issued dozens of sequential catch-up completions. Telemetry showed:

- 410 observer completions in the process lifetime;
- 191 catch-up completions;
- 372 cold epochs and 366 capacity resets;
- 95.7% provider-reported cache-read ratio;
- recent catch-up requests repeatedly projected at or near the complete epoch limit;
- normal source processing produced an observation tool call followed by a second short confirmation completion;
- cancellation failed closed and persisted no incomplete compaction.

Raising `observerEpochMaxTokens` to the model-relative maximum of 108,800 increased source headroom but retained the same extension-owned behavior: a ~95K baseline on each cold request, sequential source segments, and two normal provider completions per segment.

The provider was returning requests normally. The amplification came from extension orchestration and context design.

## 2. Root causes

### 2.1 Unbounded observer baseline

`observerBaselineText()` currently serializes every active reflection and every committed/pending observation. Durable evidence growth therefore directly increases every fresh observer request.

Source fitting can shrink the new source, but cannot shrink this baseline. The resulting progression is:

```text
baseline grows
→ useful source capacity shrinks
→ more source segments are required
→ warm epochs stop fitting
→ the baseline is repeatedly resent on cold epochs
→ eventually no useful source segment fits
```

### 2.2 Interactive protocol for a transactional operation

`runObserver()` continues after a valid `record_observations` tool submission and waits for a plain-text confirmation. The confirmation contributes no durable observation data, but adds another sequential provider completion for the common case.

### 2.3 Unbounded catch-up inside compaction

The compaction hook drains the complete uncovered gap in a `while` loop before assembly. The amount of provider work inside `/compact` therefore depends on arbitrary backlog size and available source capacity. There is no whole-catch-up segment or call bound.

### 2.4 Cold catch-up loses new-record awareness

Catch-up computes one static baseline before the loop. When capacity forces each segment into a cold epoch, later segments do not see observations accepted from earlier segments in the same catch-up run. This weakens duplicate/correction awareness as well as performance.

## 3. Architectural target

Hybrid memory remains an append-only, branch-local evidence journal. Model-facing observer context becomes a bounded derived view.

```text
immutable branch journal
        │
        ▼
authoritative BranchMemoryIndex
        │
        ├── exact lookup/provenance ──► hm_recall
        ├── active projection ─────────► compaction summary
        └── bounded observer plan ─────► one source segment
```

The observer pipeline keeps the existing durable coverage records and source progress. No new queue, database, embedding service, or persisted lifecycle schema is required.

## 4. Required invariants

### 4.1 Evidence and replay

1. Original source entries and observation provenance remain immutable.
2. Every persisted memory ID remains exactly recallable.
3. Observer-context omission never retires or deletes evidence.
4. V5 lifecycle replay and atomic batch validation remain unchanged.
5. The journal remains authoritative; any retrieval/planning structure is derived.

### 4.2 Coverage

1. Coverage advances only after a locally valid observer result is durably appended.
2. Deliberate-empty observation remains valid coverage.
3. Failed, cancelled, timed-out, or stale work advances nothing.
4. Partial-source progress remains contiguous and length-validated.
5. Coverage is branch-local, monotonic, and restartable.
6. Proactive and compaction paths use the same source/request preparation rules.

### 4.3 Capacity

1. Source capacity is reserved before historical context is selected.
2. Historical observer context has a strict token ceiling independent of total session age.
3. The selected context plus complete dynamic source envelope fits the effective observer limit.
4. Protected-context overflow is diagnosed explicitly rather than hidden by arbitrary omission.
5. Provider-specific token or cache behavior is not used as a correctness dependency.

### 4.4 Operational behavior

1. One valid observation tool submission completes a normal source segment.
2. Invalid submissions may receive at most one bounded correction completion.
3. `/compact` cannot execute an unbounded observer loop.
4. Covered compaction performs no observer completion.
5. Any bounded compaction catch-up performs at most one source segment; if backlog remains, compaction cancels with exact progress information.
6. The epoch remains a cache optimization, never the authority for durable coverage.

## 5. Bounded observer context

### 5.1 Module seam

Add one pure observer-specific planner. Conceptually:

```ts
planObserverContext(input): ObserverContextPlan
```

Input contains the active branch memory, a preview of the upcoming source, and explicit token budgets. Output contains the rendered stable baseline, source-related historical context, selected IDs, token estimates, and content-free diagnostics.

Callers should not implement selection or budgeting themselves.

### 5.2 Request layout

Preserve an exact reusable prefix where practical:

```text
stable epoch prefix
├── observer system/tool contract
├── bounded current reflections
├── bounded protected observations
└── bounded recent continuity

per-segment delta
├── bounded source-related historical observations
├── valid source IDs and instructions
└── current source content
```

The stable core is deterministic for one compatible epoch. Source-related retrieval is placed in the delta so changing source material does not invalidate the largest reusable prefix.

A cold reset recomputes the stable core from the latest durable projection. Within an epoch, accepted observation/tool transcript extends the prefix as it does today.

### 5.3 Budget order

Capacity is assigned in this order:

```text
effective observer limit
- fixed tool/output/provider reserve
- guaranteed source allocation
- bounded source-related context allocation
= maximum stable baseline allocation
```

Exact values must be chosen from evaluation evidence, not embedded in the design document. The important rule is that historical context cannot consume the guaranteed source allocation.

### 5.4 Selection policy

Use existing record metadata and deterministic text analysis only.

Stable core priority:

1. current reflection revisions, within their own cap;
2. critical observations, within an explicit protected cap;
3. high-relevance observations that fit the remaining protected allowance;
4. a token-bounded recent continuity window.

Source-related delta priority:

1. exact normalized-content matches;
2. distinctive shared paths, identifiers, hashes, versions, quoted strings, errors, and numbers;
3. deterministic lexical overlap;
4. relevance, recency, and stable active-order tie-breaking.

Deduplicate observation IDs across categories. Do not add embeddings, semantic deletion, or a persistent retrieval index in this milestone.

### 5.5 Overflow behavior

No category may silently become unbounded. If protected records exceed their allowance:

- include the highest-priority deterministic prefix that fits;
- report protected overflow in diagnostics and status;
- keep all omitted evidence recallable;
- do not claim complete historical visibility.

The quality target is bounded high-value retrieval with lossless evidence, not impossible perfect awareness of an unbounded history.

## 6. One-shot observer segment protocol

A source segment is a transaction, not a conversation.

Normal path:

```text
one completion
→ one or more record_observations calls in that response
→ local validation
→ accept complete record set
→ durable coverage commit
```

A valid deliberate-empty submission also completes immediately.

Correction path:

```text
invalid submission
→ append the local validation error
→ allow one correction completion
→ accept or fail closed
```

A plain-text response before any valid submission remains failure. Unknown tools, truncated output, cancellation, timeout, or a second invalid submission remain fail-closed.

The transcript suffix returned for epoch caching contains the accepted assistant tool call and local tool result; no routine final assistant confirmation is required.

## 7. Incremental coverage and compaction

### 7.1 Reuse existing proactive processing

The existing turn-end observer already performs one bounded durable segment and stores source progress. Keep this simple behavior as the normal coverage processor.

Do not introduce a generalized job queue. Each eligible turn may start at most one observer task. Successful partial progress makes the next eligible turn continue from the durable cursor.

### 7.2 Compaction becomes a bounded coverage barrier

Remove complete-gap draining from the compaction hook.

Desired behavior:

1. wait for an already-running proactive observer, preserving current branch/session fencing;
2. recompute authoritative coverage;
3. when coverage reaches the required compaction boundary, assemble normally;
4. when a small uncovered gap remains, optionally process at most one bounded source segment through the shared planner/request path;
5. if that segment does not complete the required gap, persist its valid progress and cancel compaction with a precise backlog message;
6. never continue into another observer segment in the same compaction attempt.

This gives manual compaction useful bounded progress without allowing an arbitrary provider-call chain. A later `/compact` or ordinary turn resumes from durable coverage.

### 7.3 No new drain command initially

Do not add `/hm-drain` or background scheduling infrastructure in the first implementation. Existing turn-end processing plus one bounded manual-compaction segment is sufficient to test whether backlog remains controlled in practice. Add an explicit drain command only if real usage shows a clear need and its operational benefit justifies another interface.

## 8. Cache-quality rules

1. Deterministic ordering is mandatory; identical journal and source input must produce identical plans.
2. The stable baseline should change only when its selected durable projection changes or compatibility changes.
3. Source-related context belongs after the stable prefix.
4. Do not trade memory quality for cache hits: critical corrections and distinctive matching evidence outrank prefix stability.
5. Do not preserve a warm epoch when doing so leaves less than the useful source allocation; cache reuse is an optimization after correctness and source progress.
6. Telemetry remains content-free and records selected token/count totals, not observation text.

## 9. Implementation milestones

### M1. One-shot observer result

Change `runObserver()` so a valid submission completes immediately and only one invalid submission can receive one correction attempt.

Completion criteria:

- normal and deliberate-empty segments use one completion;
- invalid provenance can be corrected once;
- failure/cancellation/timeout behavior remains fail-closed;
- epoch transcript validation still accepts the exact returned suffix.

### M2. Evaluation-only context planner

Add a pure deterministic planner and evaluate it against synthetic long baselines plus a read-only real-session report.

Implemented result:

- one pure in-memory pass over active records;
- explicit caller-supplied category budgets, with no runtime setting or persisted index;
- deterministic protected, recent, and source-related selection;
- exact rendered-token fitting and explicit protected-overflow diagnostics;
- 300/600/900 quality fixtures retain every required high/critical fact and deterministically retrieve an older source-related fact;
- on the current real branch (613 active observations, no replay issues), the full baseline measured ~75,809 tokens; a candidate 36K protected / 8K recent / 8K source-related partition retained every critical/high observation and produced ~40,720 stable plus ~7,992 source-related tokens. With the existing 6,144 fixed reserve and a 32K source/envelope allowance, the projected ceiling was ~86,856 of 108,800 tokens. This is evaluation evidence, not a runtime default.

Completion criteria:

- plan remains within its historical-context budget;
- guaranteed source allocation is preserved;
- output fingerprint is deterministic;
- required quality-harness facts and correction pairs selected by the fixture remain available;
- no runtime behavior changes yet.

### M3. Shared runtime context planning

Use the planner for proactive observation and the bounded compaction segment. Keep source fitting in `prepareObserverSourceRequest()`.

Implemented result:

- budgets derive from the already-effective observer limit rather than adding a new configuration surface;
- 38% protects high/critical observations, with 7% each for reflections, recent continuity, and source-related history;
- source-related history is rendered inside the dynamic delta and counted by the existing complete-envelope binary-search fitter;
- both proactive and catch-up callers use `planObserverContextForSource()`;
- catch-up replans against records accepted earlier in that bounded operation, so a cold reset retains within-operation awareness;
- the obsolete full-active-memory baseline renderer was removed;
- the observer compatibility version advanced so old full-baseline epochs cannot be reused.

Completion criteria:

- both callers consume one shared plan;
- full active memory remains in `BranchMemoryIndex` and `hm_recall`;
- request size stays bounded as fixture observation count grows;
- cold-reset plans include valid records accepted earlier in the current bounded operation.

### M4. Compaction coverage barrier

Replace complete-gap draining with at most one bounded durable segment per compaction attempt.

Implemented result:

- the complete-gap `while` loop was removed;
- a compaction attempt processes at most one source segment through the shared planner/request path;
- valid observations or deliberate-empty progress are persisted immediately with existing `SourceProgress` semantics;
- a completed gap continues into normal fold/VCC assembly;
- remaining backlog cancels compaction after preserving the one valid segment;
- no fold or final assembly runs behind uncovered backlog;
- branch/session fencing remains immediately before persistence.

Completion criteria:

- covered compaction makes zero observer completions;
- uncovered compaction makes at most one normal observer completion, or one correction completion after invalid output;
- remaining backlog cancels compaction promptly after preserving valid progress;
- branch/session fencing and atomic lifecycle assembly remain intact.

### M5. Telemetry and status

Expose only operational data needed to understand the bounded pipeline:

Implemented result: the existing session-local cache telemetry retains the latest content-free bounded-context summary (stable/source-related tokens, selected/omitted observation counts, and protected overflow) and renders it through `/hm-cache-info`. No prompt content, persistent analytics, new command, or generalized metrics path was added.

- pending raw token estimate;
- effective observer limit;
- stable/source-related/source selected token totals;
- omitted counts by selection category;
- protected overflow;
- whether compaction proceeded, advanced one segment, or stopped behind coverage.

Do not add persistent analytics or prompt-content logging.

### M6. Controlled live gate

Verify the bounded pipeline through complementary gates rather than spending provider calls to duplicate assertions that Pi RPC cannot observe.

Completed evidence:

- focused `runObserver` tests prove one completion for a valid or deliberate-empty segment and exactly one bounded correction opportunity;
- 300/600/900 growth tests prove deterministic bounded planning and required-fact availability;
- read-only replay of the real 613-observation branch proves clean lifecycle projection and practical bounded capacity;
- host-hook integration proves one segment maximum, durable partial progress, and no fold/assembly behind backlog;
- deterministic isolated Pi RPC validation passes compaction, restart/replay, idempotency, and unchanged installed bundle with repository hash `1f41a970d82bc5c8896a403b6015fe6563ac8474c2630a2bcc6026b67dc8b01f`;
- model-assisted isolated Pi validation passes observer output, supported reflection persistence, restart replay, exact source provenance, and an actual `hm_recall` tool invocation for marker `HM-LIVE-MODEL-7Q9X`, path `/srv/hybrid-memory/live-gate/config.json`, and value `41729`;
- Pi RPC does not expose exact provider-call count, so the live gate does not claim to measure it. The extension-owned one-shot contract is proven at its direct interface.

The installed bundle remained `0a03dd3de03fd74d0b1f027ed14f3bcc060182b6ade0b86028314b6748016103` throughout both gates. Rollout of the new repository bundle requires separate approval and a fresh Pi process.

The validated behaviors are:

- one completion for a valid segment;
- bounded request size;
- stable-prefix cache reuse across compatible segments;
- restart-resumable durable progress;
- at most one segment during compaction;
- exact observation/source recall;
- installed bundle and real sessions remain untouched until rollout approval.

## 10. Test strategy

Use the fewest tests that prove the practical risks.

1. Update the existing observer protocol test to assert one completion and exact accepted transcript suffix.
2. Retain one invalid-provenance correction test and change it to exactly two completions.
3. Add one table-driven planner test covering bounded selection, deterministic ordering, and protected overflow.
4. Add one growth test at a few observation counts asserting request size remains bounded; reuse the existing quality fixture rather than creating another large dataset.
5. Update compaction safety integration to prove one-segment maximum, durable partial progress, prompt cancellation when backlog remains, and zero observer calls when already covered.
6. Reuse existing cancellation, branch fencing, source-conservation, replay, and recall tests.

Do not add provider-specific token snapshots, timing-sensitive tests, embeddings, combinatorial ranking tests, or duplicate proactive/catch-up tests for planner internals.

## 11. Explicitly out of scope

- provider changes or provider-specific workarounds;
- parallel source observation;
- semantic observation retirement;
- reflection protocol redesign or independent reflection persistence;
- persistent retrieval indexes, embeddings, or vector databases;
- generalized queues, workers, schedulers, or retry frameworks;
- journal vacuuming or source deletion;
- new lifecycle schema versions;
- arbitrary timeout/cap tuning as the architectural fix;
- unrelated cache infrastructure.

The recorded reflector `invalid-provenance` outcome remains a separate issue unless it blocks validation of this observer milestone.

## 12. Decision gates

Implementation proceeds only if each step demonstrates its intended value:

1. M1 must materially reduce normal provider completions without weakening validation.
2. M2 must restore meaningful source capacity while preserving deterministic required facts.
3. M3 must retain exact recall and measurable cache-prefix stability.
4. M4 must remove unbounded compaction work without silently abandoning coverage.
5. Any broader mechanism must be proposed with benefit and cost before implementation.

## 13. Tracking checklist

- [x] Production call-amplification evidence captured.
- [x] Root cause assigned to extension context/orchestration behavior.
- [x] Minimal architecture and non-goals documented.
- [x] M1 one-shot observer protocol implemented.
- [x] M2 bounded planner evaluated without runtime activation.
- [x] M3 shared runtime planning implemented.
- [x] M4 bounded compaction coverage barrier implemented.
- [x] M5 focused operational telemetry implemented.
- [x] M6 isolated live validation passed.
- [x] Full targeted verification, typecheck, suite, and build pass.
- [ ] Installed rollout separately approved.
