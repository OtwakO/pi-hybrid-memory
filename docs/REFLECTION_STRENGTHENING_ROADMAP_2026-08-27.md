# Deterministic Reflection Strengthening Roadmap

**Status:** Deterministic Phase C strengthening implemented and verified; pending review before the quality harness

## Objective

Bound duplicate same-content reflection growth through immutable revision supersession while preserving complete support provenance and avoiding semantic replacement authority.

This phase implements only locally provable strengthening. Changed-content reflections remain concurrently active. No model-proposed correction, semantic supersession, separate decision call, or observation retirement by reflection is enabled.

## Strengthening rule

A proposal strengthens an existing reflection only when:

- both are ID-bearing reflection records;
- content is equal after trimming and collapsing whitespace;
- every proposed support ID names known immutable observation evidence;
- the union of existing and proposed support is a strict superset of existing support.

The successor revision receives:

```text
existing support ∪ proposed support
```

The model is not required to repeat old support IDs. This is important because the reflector prompt renders existing reflection content but does not expose all historical supporting observation text, and some support may already be retired from normal context.

If proposed support adds nothing, the proposal is a no-op. Multiple same-content proposals in one fold are consolidated into at most one successor revision.

## Durable records

V5 lifecycle details gain:

```ts
interface ReflectionSupersession {
  reflectionId: string;
  supersededByReflectionId: string;
  reason: "strengthened";
}
```

A strengthening fold writes both:

- one immutable successor in `reflectionsAdded`;
- one edge in `reflectionsSuperseded`.

The predecessor remains immutable and recallable.

## Replay validation

A V5 lifecycle batch is rejected atomically when a supersession:

- is structurally malformed;
- names an unknown or non-current predecessor;
- names an unknown successor or a successor not added by the same batch;
- supersedes itself;
- gives one predecessor multiple successors;
- uses one successor for multiple predecessors;
- changes normalized content;
- fails to retain every predecessor support ID;
- adds no support beyond the predecessor;
- depends on an invalid reflection addition or observation retirement in the same batch.

Restricting successors to additions in the same batch keeps the first implementation simple and prevents detached or replay-order-dependent edges.

A later V3/V4 compatibility baseline resets V5 supersession state just as it resets observation retirement state.

## Current projection and recall

A valid supersession removes only the predecessor from the current reflection projection and adds the successor. Both revisions remain in immutable reflection history.

`hm_recall(predecessorId)` returns:

- original reflection content and support;
- lifecycle state `superseded`;
- successor ID and reason.

`hm_recall(successorId)` returns the current revision and its complete unioned support.

Legacy string reflections have no ID and cannot be superseded. ID-bearing legacy reflection records may be strengthened when they satisfy the same local rules.

## Preservation obligations

Phase B exact-duplicate retirement preserves observations through another observation, not through reflections. Therefore no persisted reflection-backed retirement obligation exists yet.

Nevertheless, deterministic strengthening preserves every predecessor support ID in the successor. This establishes the transfer invariant needed by future semantic retirement without adding a generic obligation framework prematurely.

## Module ownership

- `src/om/reflection-validation.ts`: consolidate same-content proposals, create immutable successor revisions, and return explicit supersession edges.
- `src/types.ts`: strict persisted supersession event schema.
- `src/om/branch-memory-index.ts`: atomic replay, current/superseded projection, lifecycle lookup.
- `src/om/memory-fold.ts`: return validated supersession events.
- `src/om/memory-lifecycle.ts`: persist explicit events; never infer supersession from omission.
- `src/tools/recall.ts`: render superseded lifecycle state.

Do not add model schema fields, another provider call, graph library, generic revision framework, repository layer, or configuration switch.

## Token-efficient test plan

1. **Validation seam:** one test proves same-content added support creates one immutable successor with unioned support; unchanged/subset support remains a no-op.
2. **Projector seam:** one valid event replaces the current revision but preserves exact lookup; one invalid mixed batch proves atomic rejection.
3. **Fold/writer seam:** add the smallest assertions that validated supersessions flow into V5 details.
4. **Recall seam:** superseded predecessor returns its successor link while successor evidence includes the full support union.
5. Reuse existing branch and malformed-batch coverage rather than duplicating cycle and fork matrices. The same-batch-successor restriction makes cycles structurally impossible in this phase.

Run focused validation, projector, fold/writer, and recall tests during implementation. Run typecheck, the full suite, and build once at milestone completion.

## Completion criteria

- [x] Strict strengthening supersession type and reader implemented.
- [x] Same-content strict-support-superset validation implemented.
- [x] At most one successor is created per existing reflection per fold.
- [x] V5 replay applies supersession atomically.
- [x] Current projection excludes superseded predecessors.
- [x] Old and new revisions remain exactly recallable.
- [x] Changed-content reflections never supersede in Phase C.
- [x] Focused tests pass.
- [x] TypeScript, full suite, and production build pass.
- [ ] Phase C committed separately from the quality harness.
- [ ] Review completed before the 300/600/900 harness begins.
