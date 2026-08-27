# Exact-Duplicate Observation Retirement Roadmap

**Status:** Approved Phase B design; implementation not started

## Objective

Remove locally provable exact duplicate observations from the normal active projection while preserving every immutable observation, source reference, branch-local lifecycle event, and exact recall path.

This phase does not authorize semantic retirement, fuzzy matching, embeddings, model judgment, reflection supersession, or physical evidence deletion.

## Durable event

V5 lifecycle details gain:

```ts
interface ObservationRetirement {
  observationId: string;
  reason: "exact-duplicate";
  preservedByObservationIds: [string];
  preservedByReflectionIds: [];
}
```

The preserving observation is the first active equal observation in authoritative projection order. The retired observation remains immutable and addressable by its original ID.

## Equality and eligibility

Two observations are exact duplicates only when:

- content is equal after normalizing CRLF/CR to LF and trimming surrounding whitespace;
- relevance is equal.

Timestamp, ID, and source provenance are deliberately not part of equality. They remain immutable evidence on each original record.

Retirement policy:

1. Traverse current active observations in projection order.
2. Keep the first observation for each normalized-content-and-relevance key.
3. Retire a later duplicate only when that later observation has canonical custom-entry evidence on the current branch.
4. A V3/V4-only observation may be the preserving representative but cannot be retired.
5. Never merge or rewrite source IDs, timestamps, IDs, content, or relevance.

Projection order, rather than timestamp parsing or lexical ID order, defines chronology. This keeps behavior deterministic for legacy and imported records.

## Transaction ordering

```text
build current branch projection
→ run reflection fold when eligible
→ on successful/below-threshold fold only, run deterministic duplicate policy
→ validate proposed lifecycle details in memory
→ build summary from active post-retirement observations
→ final branch/session fence
→ return summary plus one V5 lifecycle batch
→ Pi atomically persists the compaction entry
```

Provider failure or invalid reflection output retires nothing and retains the complete pre-fold projection.

The compaction input fingerprint continues to describe the complete pre-fold active observations and prior reflections. Retirement events are explicit; missing observations are never interpreted as retirement.

## Replay validation

A complete V5 batch is rejected atomically when any retirement:

- is structurally malformed;
- uses an unsupported reason or preservation shape;
- names an unknown or already-retired observation;
- attempts to retire a V3/V4-only observation without canonical custom evidence;
- preserves itself;
- names an unknown, retired, later, or non-equal preserving observation;
- duplicates another retirement for the same observation in the batch.

Reflection additions and retirement events in the same invalid batch are all rejected. The prior valid projection remains current and the existing lifecycle diagnostic path reports the rejected compaction.

A valid event removes only the retired ID from active committed/pending projection arrays. Historical lookup and source traversal continue to use immutable observation history.

A later V3/V4 compatibility baseline resets lifecycle retirement state because that snapshot has no retirement journal semantics. New writes remain V5.

## Recall contract

`hm_recall(retiredId)` continues to return:

- the original observation content, timestamp, relevance, and ID;
- its own original source provenance and missing-source disclosure;
- lifecycle state `retired`;
- reason `exact-duplicate`;
- the preserving observation ID.

Recall of the representative remains active and unchanged. No provenance aggregation or evidence rewriting is introduced.

## Module ownership

- `src/om/observation-retirement.ts`: pure equality and deterministic retirement policy.
- `src/types.ts`: persisted event schema and strict reader validation.
- `src/om/branch-memory-index.ts`: atomic lifecycle replay, active/retired projection, and lifecycle lookup.
- `src/om/memory-fold.ts`: invokes deterministic policy only after a successful or below-threshold fold and returns explicit events.
- `src/om/memory-lifecycle.ts`: writes explicit validated events; never derives retirement from omission.
- `src/tools/recall.ts`: renders lifecycle state for an exact observation lookup.

Do not add a repository layer, event framework, database, generic policy interface, configuration flag, or provider call.

## Token-efficient test plan

Use compact fixtures and public seams.

1. **Pure policy table:** one test covers normalized equality, relevance mismatch, first-representative stability, and legacy-only non-retirement.
2. **Projector transaction test:** one valid event leaves the original recallable but removes it from current projection; one malformed mixed batch proves atomic rejection.
3. **Fold test:** below-threshold folding emits deterministic retirements without an LLM call; reflection failure emits none.
4. **Lifecycle writer test:** explicit events persist and unchanged post-retirement input produces no additional event.
5. **Recall test:** retired ID returns original provenance plus lifecycle state and preserving ID.
6. Reuse existing branch/fork replay tests by adding the smallest retirement assertion; do not duplicate the entire projector matrix.

Run focused policy/projector/fold/recall tests during implementation. Run typecheck, the full suite, and build once at milestone completion.

## Completion criteria

- [ ] Strict retirement event type and reader implemented.
- [ ] Pure exact-duplicate policy implemented.
- [ ] V5 replay validates and applies retirement batches atomically.
- [ ] Active summaries exclude retired duplicates.
- [ ] Every original ID and source provenance remain recallable.
- [ ] V3/V4-only observations are not retireable.
- [ ] Repeated folds emit no duplicate lifecycle event.
- [ ] Branches before and after retirement project independently.
- [ ] Focused tests pass.
- [ ] TypeScript, full suite, and production build pass.
- [ ] Phase B committed separately from Phase C.
- [ ] Review completed before reflection supersession begins.
