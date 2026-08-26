# Branch-Local Memory Lifecycle Design

**Date:** 2026-08-26  
**Status:** Phase A implemented and verified; Phase B remains gated
**Scope:** Q2–Q4 / G3 persisted memory lifecycle, disk growth, recall, reflection revision, and safe convergence

## 1. Executive decision

The earlier proposal to carry a full or partially full memory snapshot in every compaction is rejected as the target architecture. Repeating active or retired observation records causes cumulative session growth and is unnecessary because Pi already provides an append-only branch path of custom and compaction entries.

The recommended target is a **branch-local memory journal with a materialized in-memory projection**:

```text
one-time observation evidence entries
+ one-time reflection/lifecycle events in successful compactions
→ deterministic branch replay
→ current memory projection
→ bounded context projection
```

The journal is authoritative for memory lifecycle. The current projection is derived and disposable. The compaction summary is the model-visible snapshot and contains no retired evidence.

This design intentionally optimizes four different resources separately:

1. **Memory quality:** immutable evidence, explicit correction history, fail-closed retirement.
2. **Main-model tokens and attention:** only current reflections and active observations render automatically.
3. **Provider cache stability:** current context changes only at compaction and renders deterministically.
4. **Disk:** full observation text is written once, not copied through every later compaction.

## 2. Verified Pi host facts

The design relies only on behavior verified in Pi 0.84.3:

- Session JSONL storage is append-only during normal operation.
- `appendCustomEntry()` and `appendCompaction()` append one child of the current leaf.
- Plain custom entries do not participate in LLM context.
- `getBranch()` walks the parent chain from the active leaf and includes every entry type on that path.
- Compaction changes context selection; it does not delete earlier branch entries.
- A successful extension compaction persists its summary and `details` together in one `CompactionEntry`.
- If compaction fails before `appendCompaction()`, neither its details nor lifecycle events are persisted.
- Tree navigation to an earlier point creates a branch that correctly excludes later lifecycle events.
- Forking a session copies the selected root-to-leaf path, preserving inherited observation and lifecycle entries.
- `session_compact` acknowledges successful persistence; `session_compact_failed` reports failure or abort.

These facts make branch-local one-time lifecycle events viable without a sidecar database or pre-compaction custom-entry write.

## 3. Rejected storage designs

### 3.1 Full V5 snapshot

Every compaction repeats active observations, retired evidence, current reflections, and superseded reflections.

Rejected because historical data grows roughly with the sum of every snapshot size. An archive that grows each compaction produces quadratic-like cumulative duplication.

### 3.2 Active snapshot plus complete retired archive

Current observations are bounded, but every compaction repeats all retired observations.

Rejected because the largest historical tier still accumulates in every snapshot.

### 3.3 Active full records plus one-time lifecycle deltas

Retirement events are written once, but every compaction still repeats every active observation record.

Better, but still unnecessary. A large active pool can add tens or hundreds of kilobytes to every compaction details record even though its complete observations already exist in custom entries.

### 3.4 Separate custom-entry lifecycle ledger

Retirement and supersession are appended before or after compaction as custom entries.

Rejected for the first design because it creates a second write boundary. A pre-compaction lifecycle append can survive when Pi later fails to persist the corresponding summary; a post-compaction append can be missing after successful context replacement. Recovery and idempotency are possible but add complexity without benefit because compaction details are already an atomic host-owned lifecycle write.

### 3.5 Sidecar database

Rejected for current scope. It introduces session/branch identity, backup, export, orphan cleanup, concurrency, transaction coordination, portability, and recovery obligations. The current branch-local lifecycle does not justify that complexity.

## 4. Recommended durable records

### 4.1 Observation evidence — existing custom entries

Observation records remain in `hybrid-memory.observation` custom entries and are written once when coverage advances:

```ts
interface ObservationRecord {
  id: string;
  content: string;
  timestamp: string;
  relevance: "low" | "medium" | "high" | "critical";
  sourceEntryIds?: string[];
}
```

An observation entry may contain several records because one observer chunk produces a batch. Empty coverage entries remain valid and carry no evidence.

For the new architecture, an observation can become retireable only if its complete record exists in an observation custom entry on the active branch. V4-only inline observations may remain active as compatibility evidence but do not shape the normal V5 design.

### 4.2 Reflection revisions — immutable

Every accepted reflection is an immutable revision:

```ts
interface ReflectionRevision {
  id: string;
  content: string;
  supportingObservationIds: string[];
}
```

Any change to content or support creates a new revision ID. This is stricter than the current in-place support strengthening, but it produces unambiguous audit history and makes compaction events immutable.

### 4.3 Lifecycle compaction details

A successful hybrid compaction appends only the records created by that fold:

```ts
interface MemoryLifecycleDetailsV5 {
  type: "observational-memory";
  version: 5;
  generation: {
    inputFingerprint: string;
    parentMemoryCompactionId?: string;
  };
  reflectionsAdded: ReflectionRevision[];
  observationsRetired: ObservationRetirement[];
  reflectionsSuperseded: ReflectionSupersession[];
}
```

Retirement event:

```ts
interface ObservationRetirement {
  observationId: string;
  reason: "exact-duplicate" | "fully-absorbed" | "superseded";
  preservedByObservationIds: string[];
  preservedByReflectionIds: string[];
}
```

Reflection supersession event:

```ts
interface ReflectionSupersession {
  reflectionId: string;
  supersededByReflectionId: string;
  reason: "strengthened" | "corrected" | "superseded";
}
```

No active-memory array and no retired-evidence archive is copied into V5 details.

## 5. Current-state reconstruction

`buildBranchMemoryIndex()` becomes the sole projector.

It replays the active branch in order:

1. Index observation records from observation custom entries.
2. Add reflection revisions from successful V5 compactions.
3. Apply observation retirement events.
4. Apply reflection supersession events.
5. Validate every event against state known earlier on the branch.
6. Produce:
   - active observations,
   - retired observations,
   - current reflections,
   - superseded reflections,
   - preservation links,
   - exact lookup and provenance traversal.

### 5.1 Invalid persisted events

A malformed or impossible event must not partially mutate the projection.

Recommended reader behavior:

- reject the complete V5 lifecycle batch for that compaction;
- retain the projection produced before that compaction;
- surface a diagnostic in `/hm-status` and `/hm-memory`;
- keep raw lookup available for the malformed entry;
- do not silently guess.

### 5.2 Replay performance

Branch replay is linear in memory records and lifecycle events. The active branch is already traversed by several extension operations.

Initial implementation should remain simple and measure replay time. Do not add process snapshots or checkpoint entries preemptively.

If measured replay becomes material, add sparse lifecycle checkpoints as a performance optimization only. Checkpoints must be deletable/rebuildable and must not become the source of truth.

## 6. Branch and fork semantics

Lifecycle is branch-local by construction.

### 6.1 Descendant branch

A branch created after retirement inherits:

- the observation evidence,
- the reflection revision,
- the retirement event.

The observation remains retired.

### 6.2 Branch from before retirement

A branch created before retirement contains the observation evidence but not the later retirement event.

The observation is active again on that branch. This is correct: the branch represents an earlier memory state.

### 6.3 Branch summary of an abandoned path

Pi attaches branch-summary text at the navigation target but does not transplant custom observation or lifecycle entries from the abandoned branch. Hybrid memory must not infer that abandoned-branch memory became current merely because VCC text mentions it.

Cross-branch memory import is outside the target design.

### 6.4 Forked session

Pi copies the selected path into the new session file. The fork inherits exactly the evidence and lifecycle state on that path and receives a new session ID. No external database linkage is needed.

## 7. Retirement safety analysis

Retirement changes automatic context and must be treated as semantic deletion even though evidence remains recallable.

### 7.1 Citation is not preservation

A reflection listing an observation as support proves only that the observation contributed evidence. It does not prove that all important details were preserved.

Example:

```text
Observation: Build fails on Windows with error EINVAL in src/cache.ts after Node 25.9.0 upgrade.
Reflection: The project has a Windows build issue.
```

The reflection cites the observation but loses the error, path, version, and causal timing. Retirement would reduce memory quality.

### 7.2 Deterministic exact duplicate — safe first class

Exact-duplicate retirement is locally auditable when two observations have identical canonical semantic payload under a deliberately narrow equality rule.

Recommended first equality:

- exact content after line-ending and surrounding-whitespace normalization;
- same relevance;
- retained observation is the earliest ID for stable chronology;
- each original observation and its provenance remain immutable;
- the retirement event names the retained observation as the preserving representative;
- no fuzzy, embedding, or model-based equivalence.

This can retire duplicates without an LLM retirement decision. Recall of either ID still returns that observation's original source provenance; no evidence record is merged or rewritten.

### 7.3 Fully absorbed — unsafe without evaluation

A model can propose that a reflection preserves an observation, but local code cannot generally prove semantic completeness.

Do not enable this class merely because the tool schema is valid. It requires:

- explicit per-observation preservation claims;
- a reflection content contract designed for lossless absorption rather than broad orientation;
- deterministic critical-detail fixtures;
- contradiction and omission tests;
- measured false-retirement rates on representative sessions;
- conservative default retention when uncertain.

### 7.4 Superseded observation — conditionally safe

A correction can supersede an earlier observation, but the older record often remains valuable chronology.

Example:

```text
Old: deploy to AWS.
New: user replaced AWS with Cloudflare Workers.
```

The old observation may leave current context only when the replacement observation explicitly identifies it as superseded and preserves the transition. The older evidence remains recallable.

Initial implementation should not infer this relation from text. It needs explicit observer-produced supersession metadata or a separately validated lifecycle claim.

### 7.5 Relevance is not authorization

Low relevance does not make an observation safe to retire, and critical relevance does not make it permanently active. Relevance is a ranking signal for context projection, never a lifecycle command.

## 8. Preservation obligations

Every retirement creates a preservation obligation.

If observation `O1` retires because reflection `R1` preserves it, the current projection must contain `R1` or another validated successor responsible for `O1`.

### 8.1 Reflection supersession transfer rule

A reflection with preservation obligations cannot leave the current projection unless every obligation transfers to current evidence.

```text
R1 preserves retired O1 and O2
R2 supersedes R1
```

Valid transition requires:

```text
R2 explicitly preserves O1 and O2
or another current observation/reflection preserves each obligation
```

Otherwise R1 remains current even if R2 is added.

This rule prevents individually valid retirement and supersession operations from jointly erasing meaning.

### 8.2 No dangling support

A current reflection may cite retired observations because the evidence remains recallable. It must not cite unknown observation IDs.

A retired observation may cite missing raw Pi source entries; that degrades provenance preview but not the stored observation evidence. Missing source entries must remain explicit in recall.

## 9. Reflection lifecycle

### 9.1 Immutable revision rule

- Same content and same support: no change.
- Same content with additional support: create a new strengthened revision and supersede the old revision.
- Changed content: create a new revision.
- Correction: create a new revision with an explicit supersession edge.
- Old revisions remain recallable.

This uses more small reflection records than in-place mutation but avoids ambiguous historical content and supports deterministic replay.

### 9.2 Current-reflection consistency

The projector must reject:

- unknown superseded or successor IDs;
- self-supersession;
- cycles;
- two successors for one revision in one linear branch unless an explicit merge revision resolves them;
- supersession that drops preservation obligations;
- duplicate reflection IDs with different payloads.

### 9.3 Contradictions

The model may propose a new contradictory reflection. A new reflection is not automatically a correction.

Only explicit validated supersession can remove the older reflection from current context. Without it, the fold should fail or retain both with a diagnostic; silently preferring the newest is unsafe.

## 10. Transaction and concurrency model

### 10.1 Proposed transaction

```text
capture branch/session/input fence
→ build current projection
→ run reflection proposal
→ run deterministic retirement policy
→ validate complete lifecycle batch in memory
→ rebuild context summary from proposed projection
→ final fence + input fingerprint check
→ return summary and V5 lifecycle details
→ Pi atomically appends one CompactionEntry
→ session_compact acknowledges success
```

The extension persists no lifecycle custom entry before Pi's compaction write.

### 10.2 Failure semantics

- Provider failure: no lifecycle events.
- Invalid proposal: no lifecycle events.
- Unsafe retirement: no lifecycle events; retain pre-fold projection.
- Branch/session change: cancel.
- Pi append failure: no compaction/lifecycle entry.
- `session_compact_failed`: telemetry only; no recovery write.
- Process exit after append but before `session_compact`: replay on resume discovers the persisted compaction; acknowledgment is not required for correctness.

### 10.3 Idempotency

A repeated compaction over unchanged input must produce no duplicate lifecycle mutation.

Use:

- unique memory IDs;
- parent memory-compaction ID;
- deterministic input fingerprint;
- local no-op detection before returning V5 details.

Do not depend on timestamps for identity.

## 11. Disk-growth model

Let:

- `O` = total observation evidence bytes written once,
- `R` = total reflection revision bytes written once,
- `L` = total lifecycle event bytes written once,
- `S_i` = each model-visible compaction summary,
- `P` = Pi raw session entries.

Extension-related growth is approximately:

```text
O + R + L + ΣS_i
```

It is not:

```text
Σ(all active observations at compaction i)
+ Σ(all retired observations at compaction i)
```

This removes cumulative evidence duplication from compaction details.

The session file still grows because Pi is append-only and stores raw messages plus every compaction summary. The extension cannot guarantee constant disk usage without rewriting or externalizing Pi sessions. It can ensure its durable memory payload is approximately linear and each semantic record is written once.

### 11.1 Remaining repeated data

The compaction summary repeats current memory text because Pi needs a complete summary for context reconstruction. This is unavoidable under Pi's compaction contract.

The design should therefore bound and deterministically render the summary. Disk growth from repeated summaries becomes roughly:

```text
number of compactions × configured summary size
```

At a 16k-token ceiling, extremely frequent compaction can still produce material storage. Compaction frequency and actual summary-size telemetry must be measured. This is a host-contract cost, not a reason to duplicate evidence in details.

## 12. Main-model token and cache behavior

### 12.1 Context quality

The automatic memory block contains only:

- current reflection revisions;
- active observations selected under the semantic budget;
- current VCC structural state.

Retired observations and superseded reflections do not consume main-model context.

### 12.2 First request after compaction

The first request after compaction establishes a new prefix and may be cold. The architecture minimizes that cost by keeping the summary small and information-dense.

### 12.3 Later requests

Pi reuses the same compaction summary byte-for-byte until the next compaction. Deterministic ordering and rendering preserve provider prefix reuse.

### 12.4 Fold-model cache

The fold should receive the current projection, not historical retired evidence. As convergence improves, reflection input can remain bounded.

Do not optimize cache by withholding active evidence. Canonical stable-before-dynamic ordering is quality-neutral and should remain.

## 13. Recall contract

### 13.1 Observation recall

`hm_recall(observationId)` returns:

- full immutable observation evidence;
- current lifecycle state: active or retired;
- retirement reason and preserving IDs when retired;
- bounded available source previews;
- explicit missing source IDs.

### 13.2 Reflection recall

`hm_recall(reflectionId)` returns:

- the immutable revision;
- current or superseded status;
- predecessor/successor relationships;
- supporting observations;
- bounded available source previews;
- preservation obligations currently assigned to it.

### 13.3 Lookup scope

Current branch only. Sibling branches are intentionally excluded to prevent branch leakage and contradictory lifecycle state.

No automatic expiry is introduced.

## 14. Legacy compatibility policy

Compatibility is useful but must not control the target architecture.

Recommended policy:

- Continue reading V3/V4 details.
- Project their observations and reflections as active compatibility memory.
- Do not retire a V3/V4 inline observation unless the same complete observation ID exists in an active-branch custom observation entry.
- Do not automatically materialize or migrate missing evidence.
- New sessions naturally use the V5 journal model.
- If a heavily legacy session cannot satisfy retirement invariants, retaining memory or starting a new session is acceptable.

## 15. Phased implementation recommendation

### Phase A — V5 journal reader/writer, retirement disabled — Complete

- Strict V5 lifecycle schemas and projector support are implemented.
- New compactions write reflection revisions once and no full observation arrays.
- V3/V4 reading remains supported as a compatibility baseline.
- All observations remain active; retirement arrays are structurally required to be empty.
- Branch, fork, root-V5, replay, corruption, immutable-ID, and idempotency tests are implemented.
- Rejected persisted batches retain the prior valid projection and are surfaced through `/hm-status` and `/hm-memory`.

This phase reduces repeated compaction-details storage without introducing semantic deletion.

### Immediate reliability milestone — capacity-aware source segmentation

Before Phase B, correct near-boundary observer requests without changing memory semantics. The serializer/callers must derive the largest safe contiguous source segment from the complete fresh baseline and effective epoch capacity, preserve `sourceProgress`, and advance coverage only after successful observation and durable persistence. A baseline that cannot leave a minimum useful source delta still fails closed.

This mitigates small overruns such as 108,898 estimated tokens against a 108,800-token effective cap. It does not replace lifecycle convergence.

### Phase B — Deterministic exact-duplicate retirement

- Add narrow local duplicate equality.
- Emit explicit retirement events.
- Verify source union, chronology, recall, branch behavior, and no-op repeat folds.
- No LLM retirement tool.

### Phase C — Reflection supersession

- Add explicit immutable revision and supersession contract.
- Enforce preservation-obligation transfer.
- Add correction, contradiction, cycle, merge, and branch tests.

### Phase D — Semantic retirement experiment

- Build 300/600/900-observation quality fixtures first.
- Compare combined reflection claims, separate retirement call, and retention baseline.
- Enable `fully-absorbed` or semantic `superseded` only if deterministic required-fact assertions and measured false-retirement rates justify it.

### Phase E — Summary effectiveness and cache tuning

- Measure summary section sizes and projected post-compaction context.
- Confirm repeated folds converge.
- Measure first cold request separately from later warm requests.
- Tune stable prefix layout only after semantic behavior is green.

## 16. Token-efficient test strategy

Tests should operate on the lifecycle projector and fold seam, using compact fixtures with high semantic density.

### 16.1 Pure projector tests

Given branch records, assert current/retired/superseded state. No model or Pi runtime mock.

Use table-driven cases for:

- add reflection;
- retire duplicate;
- supersede reflection;
- branch before/after event;
- unknown IDs;
- duplicate IDs;
- cycles;
- dropped obligation;
- malformed batch atomic rejection;
- repeated replay idempotency.

### 16.2 Command tests

Given current projection and deterministic retirement command, assert emitted events. This follows event-sourced given/when/then testing and avoids large integration fixtures.

### 16.3 Boundary tests

Keep only a few integration tests for:

- compaction persists lifecycle details with summary;
- failed compaction persists nothing;
- final branch fence rejection;
- reload reconstructs the same projection;
- fork inherits exactly the selected path.

### 16.4 Quality fixtures

Use sanitized dense fixtures rather than enormous transcript mocks. Each observation should encode a tested risk: exact identifiers, corrections, chronology, constraints, rationale, unresolved work, and provenance.

For 300/600/900 scale tests, generate deterministic filler around a small fixed set of required facts. Assertions inspect lifecycle and rendered output rather than snapshotting megabytes of strings.

Run focused projector/command tests during implementation. Run the full suite and production build once per milestone.

## 17. Remaining decision gates

The branch-local journal, one-time V5 records, immutable reflection revisions, and current-branch recall scope are implemented in Phase A.

Before Phase B, approve:

1. Deterministic exact-duplicate retirement under the narrow equality rule.
2. The retirement event and recall presentation for duplicate representatives.
3. Semantic `fully-absorbed` and `superseded` retirement remain disabled until the quality harness supports them.

## 18. Final recommendation

Adopt the journal design progressively.

The first implementation should change storage and projection fundamentals without introducing semantic retirement:

```text
V5 one-time records
+ strict replay
+ immutable reflection revisions
+ no observation deletion
```

Then add locally provable exact-duplicate retirement. Only after real quality evaluation should an LLM be allowed to authorize broader context removal.

This order improves disk efficiency immediately, preserves rollback, and avoids combining schema migration, reflection lifecycle, semantic deletion, and cache tuning in one risky change.
