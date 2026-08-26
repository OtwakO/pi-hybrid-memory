# Observer Capacity and Source-Progress Roadmap

**Status:** Approved design direction; implementation not started  
**Scope:** Immediate observer-capacity reliability correction and closely related follow-up decisions  
**Primary goal:** Fit the largest useful contiguous source input inside the observer request without omitting active memory, weakening coverage guarantees, or duplicating capacity logic across callers.

## 1. Verified problem

Both observer paths currently calculate source capacity from:

```text
immutable memory baseline
+ OBSERVER_DELTA_INSTRUCTIONS
+ fixed output/tool/provider reserve
```

The final request is larger because `observerDeltaText()` also adds:

- the dynamic list of valid source-entry IDs;
- source-ID restriction instructions;
- source-ID omission instructions;
- separators and message framing;
- source block or segment headers.

The preliminary capacity calculation and final `ObserverEpochManager.prepare()` calculation therefore measure different representations. A candidate may consume the preliminary source budget and then fail final preparation near the epoch boundary.

The missing dynamic envelope is a verified accounting mismatch and the leading explanation for the recorded `108,898 > 108,800` failure. The repository does not contain the complete production baseline and source fixture, so it is not yet proven to be the sole contributor to the exact 98-token difference.

## 2. Required invariants

The correction must preserve all of these properties:

1. The complete active reflection and observation baseline remains present.
2. Source selection is oldest-first and contiguous.
3. Partial coverage addresses one source entry through additive `sourceProgress`.
4. `coversUpToId` names only the last fully observed source entry.
5. No source coverage advances before successful observation and durable persistence.
6. Failure, cancellation, invalid model output, or persistence failure leaves durable coverage unchanged.
7. Proactive observation and compaction catch-up use one capacity rule.
8. The returned source serialization and prepared epoch request describe exactly the same source content and IDs.
9. A fresh epoch fails closed when it cannot hold the baseline plus a minimum useful source segment.
10. Provider cache optimization must not omit active evidence or weaken chronology and provenance.

## 3. Recommended module seam

Add one observer-specific request-preparation operation. It should hide source fitting, complete delta construction, and epoch projection behind one small interface.

Conceptually:

```ts
prepareObserverSourceRequest(input):
  | {
      ok: true;
      serialized: SourceAddressedSerialization;
      prepared: PreparedObserverEpoch;
    }
  | {
      ok: false;
      reason: ObserverSourcePreparationFailure;
      capacity: ObserverSourceCapacity;
    }
```

The exact names and location should follow the existing observer module vocabulary. Do not introduce a generic packing framework, strategy hierarchy, provider adapter, configuration switch, or dependency.

### Interface guarantee

On success:

- `serialized.text` is the source text embedded in `prepared.prompts`;
- `serialized.sourceEntryIds` is the exact allowed ID set embedded in the prompt;
- `serialized.sourceProgress` describes the exact emitted segment;
- the complete locally projected request is within the effective epoch limit;
- callers cannot rebuild or substitute one half of the pair independently.

### Caller responsibilities

The shared operation does not own persistence or inference.

The proactive caller continues to own:

- observer task lifecycle and cancellation;
- model invocation;
- durable observation append;
- live epoch commit after successful persistence.

The catch-up caller continues to own:

- repeated gap processing;
- draft epoch lifecycle;
- branch/session fences;
- atomic durable catch-up coverage;
- compaction cancellation on failure.

## 4. Capacity accounting design

Use one authoritative conservative local projection for all extension-controlled observer input:

```text
complete baseline message
+ complete dynamic delta message
+ shared fixed output/tool/provider reserve
```

The dynamic delta must be constructed with the actual selected source-entry IDs before the candidate is accepted.

This is not an exact provider tokenizer. Provider translation and tool framing vary. The required guarantee is internal consistency: candidate fitting and final epoch preparation must use the same conservative projection plus the same fixed reserve.

### Minimum useful delta

Define `OBSERVER_MINIMUM_DELTA_TOKENS` against actual serialized source capacity after prompt-envelope costs are accounted for. Do not compare it with a nominal remainder that still includes source-ID instructions or other framing.

## 5. Source-selection algorithm

Use a deterministic oldest-first policy:

1. Add complete renderable source entries while the complete final request fits.
2. If the oldest eligible source alone does not fit, select its largest fitting contiguous segment.
3. If one or more complete entries fit but the next entry does not, stop with the complete prefix rather than partially appending the next entry.
4. Require the selected source payload to satisfy the minimum useful-delta rule.
5. Perform one final projection before returning success.
6. Call stateful `ObserverEpochManager.prepare()` only for the final selected candidate.

A binary search over the segment endpoint is appropriate because projected input size grows monotonically with the selected character range. Avoid arbitrary token shaving, retry constants, and repeated stateful `prepare()` probes.

## 6. Implementation milestones

### M1. Reproduce the accounting class

Before changing behavior, add a compact deterministic test showing:

- the old preliminary calculation accepts a candidate;
- the complete composed request exceeds the cap;
- a smaller contiguous candidate fits.

Use a small synthetic cap and generated strings. Do not commit a production-sized 108k-token fixture merely to reproduce the arithmetic scale.

**Completion:** The test fails against current behavior for the intended reason.

### M2. Centralize request fitting

Implement the shared request-preparation operation and one pure projection calculation used by fitting and final preparation.

**Completion:** Preliminary source selection and final preparation can no longer disagree about extension-controlled input.

### M3. Wire proactive observation

Replace local capacity, serialization, and preparation assembly with the shared operation. Preserve durable-write-before-epoch-commit ordering.

**Completion:** Existing proactive lifecycle tests remain green, including cancellation, branch/session navigation, and persistence failure.

### M4. Wire compaction catch-up

Use the same operation for every catch-up iteration. Preserve draft epoch behavior, exact progress, final durable marker semantics, and compaction fences.

**Completion:** Catch-up processes bounded segments with the same rules as proactive observation and still fails closed on any incomplete or invalid transaction.

### M5. Decide minimal source-progress hardening

The current durable progress record stores `sourceEntryId`, `nextOffset`, and `totalLength`, but resume does not compare `totalLength` with the newly rendered source length. Offsets address serializer-rendered text, which may change with serializer behavior or local-time timestamp formatting.

For the immediate milestone, decide explicitly between:

1. **Minimal hardening:** Reject the stored offset when current rendered length differs from `totalLength`, then restart that source from offset zero.
2. **Separate persisted-format milestone:** Add serializer identity and/or a rendered-content digest before trusting an offset.

Restarting from zero is safer than silently skipping content. A digest/version schema change must not be bundled casually because it changes durable compatibility behavior.

**Completion:** The chosen behavior is documented and covered by one focused integrity test.

### M6. Verify and checkpoint

Run focused tests first, then milestone-level verification once:

1. planner/capacity tests;
2. source-progress tests;
3. proactive and catch-up lifecycle tests;
4. TypeScript typecheck;
5. full test suite;
6. production build.

Commit this capacity correction separately from retirement, reflection supersession, and cache optimization.

## 7. Token-efficient test plan

Tests should maximize confidence per fixture, assertion, and runtime. Do not add separate tests when one stronger invariant covers the same risk.

### 7.1 One table-driven capacity test

Use one shared setup with cases for:

- near-boundary candidate shrinks and succeeds;
- exact-boundary candidate succeeds unchanged;
- baseline plus complete envelope leaves less than the minimum useful source capacity and fails.

Assert only the contract:

- success or typed failure;
- final projected size is within the cap;
- the near-boundary candidate was reduced;
- failure returns no prepared request.

### 7.2 One segmentation-conservation test

Repeatedly emit and resume segments for one generated oversized source. Concatenate emitted source payloads and assert exact equality with the canonical rendered source.

This single invariant covers:

- exact offset continuation;
- eventual completion;
- no skipped characters;
- no duplicated characters.

Consolidate existing overlapping first-segment assertions in `tests/serialize.test.ts` and `tests/source-progress.test.ts` instead of adding another duplicate case.

### 7.3 Reuse caller lifecycle tests

Do not copy every capacity edge case into both caller suites. Capacity rules belong to the shared operation's unit tests.

Use existing caller tests to verify their distinct responsibilities:

- proactive persistence precedes live epoch commit;
- aborted or stale proactive work persists nothing;
- catch-up loops over incomplete progress;
- catch-up never advances full coverage for a partial segment;
- catch-up cancellation and branch fencing remain intact.

Add only the smallest missing assertion needed to show each caller consumes the inseparable shared result.

### 7.4 One progress-integrity test, if hardening is included

Test the actual implemented invariant once. For example, a stored `totalLength` mismatch must not resume from the stored offset.

Do not separately test digest, serializer version, timezone, length, and every invalid offset unless those mechanisms are actually introduced.

### 7.5 Tests deliberately deferred

Do not add during this milestone:

- separate large-model and small-model tests when an effective numeric cap covers both;
- duplicate proactive and catch-up versions of every planner edge case;
- provider-specific token assertions the local estimator cannot guarantee;
- large prompt snapshots;
- 300/600/900-observation quality fixtures;
- semantic retirement or reflection-supersession tests.

## 8. Deferred optimization: warm-epoch fitting

Current callers size source against fresh-epoch capacity. A selected candidate may force a cold rollover even when a smaller useful candidate could fit the warm epoch and preserve the cached prefix.

This is a real provider-independent cache-efficiency opportunity, but it is not required for the immediate correctness fix.

Revisit only after telemetry measures:

- capacity-reset frequency;
- warm headroom at reset;
- estimated source that could have fit warmly;
- cold versus warm observer cache behavior.

If justified, the later policy should prefer the largest useful warm-fitting candidate and roll over only when warm headroom is below the useful minimum.

## 9. Relationship to the broader memory roadmap

This milestone relieves small boundary overruns but does not bound baseline growth. The broader sequence remains:

1. capacity-aware request preparation;
2. deterministic exact-duplicate retirement;
3. preservation-safe reflection supersession;
4. token-efficient 300/600/900 quality harness;
5. semantic retirement only if measured quality supports it;
6. disk, context-effectiveness, and cache refinement.

Exact-duplicate retirement does not require a new repeated-provenance aggregate. Original evidence and provenance remain immutable and recallable; a narrow retirement event links the duplicate to its preserving representative.

## 10. Out of scope

- Raising the 40% model-relative observer epoch cap without evidence.
- Omitting active observations or reflections.
- Semantic retirement.
- Reflection supersession.
- Sidecar storage.
- Physical session-file vacuuming.
- Provider-specific cache tricks.
- Persisted progress schema expansion without an explicit compatibility decision.
- Combining this correction with later lifecycle milestones.

## 11. Tracking checklist

- [ ] M1 accounting-class regression test added and red.
- [ ] M2 shared request-preparation operation implemented.
- [ ] M3 proactive caller migrated.
- [ ] M4 catch-up caller migrated.
- [ ] M5 progress-integrity behavior explicitly decided and verified.
- [ ] Focused capacity/progress tests pass.
- [ ] Existing proactive/catch-up lifecycle tests pass.
- [ ] TypeScript passes.
- [ ] Full suite passes once at milestone completion.
- [ ] Production build passes.
- [ ] `PLAN.md` and `DEVELOPMENT.md` updated if implementation decisions change.
- [ ] Capacity milestone committed separately.
- [ ] Review completed before Phase B retirement work begins.
