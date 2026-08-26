# Next Session Handoff — Memory Convergence and Observer Capacity

**Date:** 2026-08-27
**Starting commit:** `bbbe61f` (`feat: add branch memory journal`)
**Status:** Phase A complete, installed, and verified; begin the next session with measurement and a localized capacity fix

## Current verified state

Phase A of the branch-local memory journal is complete:

- New compactions persist strict V5 one-time reflection lifecycle records.
- Complete observation/reflection snapshots are no longer copied into every new compaction detail.
- V3/V4 remain readable as compatibility baselines.
- Conflicting immutable IDs and malformed/out-of-order V5 batches reject atomically and visibly.
- Observation retirement and reflection supersession remain structurally disabled.
- The full repository passed 236 tests, TypeScript, and production build verification.
- Installed bundle SHA-256: `346f7f9a123976cb568cba5151627412b82a8a30afc5c37204fa28b31d89ac8b`.

The current long session has reached observer baseline pressure:

```text
fresh baseline + source chunk: 108,898 estimated tokens
effective observer epoch cap: 108,800 tokens
```

The effective cap is:

```text
min(observerEpochMaxTokens, 40% of observer model contextWindow)
```

For the current 272,000-token observer model window, 40% is 108,800. Raising `observerEpochMaxTokens` above that does not increase effective capacity.

Phase A intentionally did not reduce the active observation baseline. It fixed persistence architecture and cumulative detail-record duplication without risking semantic deletion.

## Ultimate goal

Build the most token- and disk-efficient long-session memory system we can achieve **by design**, while simultaneously preserving the highest practical memory quality and provider-independent cache reuse.

These goals reinforce rather than replace one another:

- High-quality memory reduces corrective work, repeated investigation, and wasted main-model tokens.
- A compact, information-dense current projection improves attention and lowers uncached input cost.
- Stable deterministic prefixes improve cache reuse without hiding evidence from the model.
- Durable recall permits safely retired evidence to leave normal context without becoming lost.
- Correct lifecycle convergence prevents observation and reflection baselines from growing forever.
- One-time durable records and bounded projections prevent extension-owned session storage from accumulating repeated full memory snapshots.

Do not optimize one metric in isolation. A smaller prompt is not an improvement if it loses required facts. A higher cache-hit ratio is not an improvement if it depends on stale, incomplete, or branch-invalid memory. A smaller session file is not an improvement if unique evidence or rollback history is silently destroyed. Retaining every historical detail in active context or repeatedly copying it into persisted snapshots is not higher quality if context rot, attention dilution, and cumulative disk growth make long sessions impractical.

The target balance is:

```text
maximum practical memory fidelity
+ minimum necessary active context
+ maximum quality-neutral prefix stability
+ approximately linear extension-owned durable storage
+ durable exact recall outside normal context
```

## Non-negotiable product priorities

Use this order when trade-offs appear:

1. Memory fidelity.
2. Validated provenance and retention safety.
3. Correct branch/session lifecycle behavior.
4. Effective context and attention reduction.
5. Bounded, approximately linear extension-owned disk growth.
6. Operational reliability.
7. Provider-independent cache efficiency.
8. Raw extension-model monetary cost.

Do not remove chronology, corrections, identifiers, paths, versions, errors, decisions, rationale, constraints, unresolved work, or provenance merely to relieve token pressure.

Do not accelerate semantic retirement because one session reached the capacity ceiling.

## Architectural and coding standards

Every milestone must preserve these engineering constraints:

### Treat disk as a first-class resource

- Full observation evidence, reflection revisions, and lifecycle events should each be persisted once whenever Pi's branch journal can reconstruct current state from them.
- Do not copy complete active or retired memory archives into every compaction detail record.
- Keep the model-visible compaction summary bounded and deterministic; under Pi's append-only contract each summary is necessarily persisted again, so compaction frequency and actual summary bytes must be measured.
- Measure durable bytes by category: observation entries, reflection/lifecycle details, compaction summaries, telemetry/diagnostics, and compatibility records.
- Prefer reconstructible projections and indexes in memory rather than persisted duplicate snapshots.
- Do not add checkpoints, caches, or denormalized indexes on disk until replay performance is measured and requires them; any future checkpoint must be disposable and rebuildable.
- Automatic lifecycle retirement removes evidence from active context but does not physically reclaim existing JSONL bytes. Do not misreport retirement as disk reclamation.
- Physical session compaction or vacuuming must remain a later, explicit, branch-aware, backup-preserving, dry-run-first maintenance operation. It must not be hidden inside normal `/compact` behavior.
- Never delete unique information-bearing evidence automatically merely because it is old, low relevance, or consumes disk.

### Prefer Pi-native capabilities

- Target the active `@earendil-works` Pi SDK and public extension interfaces.
- Prefer Pi-owned model routing, authentication, provider translation, lifecycle events, context preparation, compaction inputs, token accounting, cancellation, and session/branch APIs whenever they satisfy the requirement.
- Do not recreate host functionality inside the extension merely for control or theoretical portability.
- Add an extension-owned abstraction only when Pi does not expose the required memory semantic or when at least two real implementations justify a seam.
- Keep compatibility adapters narrow and explicit; do not let legacy package behavior define new architecture.

### Keep modules deep and cohesive

- Each module owns one complete responsibility behind a small interface.
- Keep lifecycle replay, persistence codecs, fold policy, provider adaptation, context projection, and UI reporting separate where their reasons to change differ.
- Keep invariants in the module that owns the state transition instead of duplicating checks across callers.
- Dependencies flow in one direction; avoid circular imports and callers reaching into another module's internals.
- Reuse a shared abstraction only for an existing repeated pattern, not hypothetical future reuse.

### Prefer the simplest complete design

- Use the smallest reversible change that fully solves the observed problem.
- Prefer a function, explicit data shape, or local condition over a framework or named pattern when either is sufficient.
- Do not add factories, adapters, repositories, event systems, configuration switches, generic layers, or dependencies without a concrete second case or host seam that requires them.
- Do not stack a workaround on another workaround; trace and fix the producing cause when possible.
- If a simpler approach is easier to reason about, test, and reverse, prefer it over a more flexible but bug-prone design.
- Do not reinvent well-tested SDK, platform, language, or standard-library behavior.

### Optimize for maintainability

- Code must remain readable without reconstructing the entire repository context.
- Use names that describe domain meaning and preserve the vocabulary in `CONTEXT.md`.
- Use version suffixes only at persisted compatibility boundaries such as `MemoryLifecycleDetailsV5`; keep ordinary behavior interfaces version-neutral.
- Keep files focused and split them only when responsibilities genuinely differ, not to satisfy arbitrary line counts.
- Avoid dead code, compatibility remnants, duplicated constants, speculative TODOs, debug output, and silent fallbacks.
- Make inputs, outputs, side effects, failure modes, transaction ordering, and idempotency explicit.

### Test according to risk

- Reproduce each defect or capacity boundary with a focused failing test before changing behavior.
- Test pure lifecycle/projector logic through its public interface with compact deterministic fixtures.
- Use integration tests only for real Pi boundaries: persistence, branch/session fencing, compaction success/failure, reload, fork, and provider completion.
- Run focused tests during implementation; run the full suite, typecheck, production build, diagnostics, and byte-for-byte installation verification once per completed milestone.
- Do not weaken an assertion or change a fixture merely to make a new implementation pass; first determine whether the test or implementation violates the documented invariant.

### Keep milestones isolated

- One persisted-schema, lifecycle-policy, capacity, or cache concern per milestone and commit.
- Do not mix semantic retirement, reflection supersession, capacity handling, cache restructuring, and UI cleanup.
- Write the rollback point and compatibility impact before high-risk changes.
- Stop for review before enabling any new path that removes information from normal context or changes persisted lifecycle meaning.

## Carefully staged implementation order

### Milestone 1 — Capacity-aware observer source segmentation

This is a localized reliability correction, not a memory-policy change.

Investigate the exact 98-token overrun and implement the smallest safe behavior:

1. Serialize the complete fresh baseline using the same accounting used by the provider request.
2. Calculate remaining source capacity after protocol/output/tool reservations.
3. Select the largest contiguous source segment that safely fits.
4. Permit a smaller-than-preferred segment when it remains above a clearly justified minimum useful delta.
5. Preserve existing additive `sourceProgress` semantics and exact coverage boundaries.
6. Do not omit baseline observations/reflections.
7. Do not advance coverage for a segment that was not successfully observed and durably persisted.
8. Fail closed only when the baseline itself leaves insufficient capacity for a useful source segment.

Required tests:

- overrun by fewer than 100 estimated tokens fits through a smaller segment;
- exact-boundary fit;
- baseline-only exhaustion still fails without advancing coverage;
- proactive and compaction catch-up use identical capacity rules;
- segmented progress resumes at the exact offset after reload;
- no source characters are skipped or duplicated;
- existing large-model and small-model cases remain valid.

This milestone mitigates near-boundary failures but cannot solve a baseline that grows indefinitely.

### Milestone 2 — Phase B deterministic exact-duplicate retirement

Enable only locally provable exact duplicates.

Narrow equality rule:

- equal content after line-ending and surrounding-whitespace normalization;
- equal relevance;
- no fuzzy matching, embeddings, or model judgment;
- retain the earliest observation as the active representative;
- leave every original evidence record and provenance immutable;
- persist an explicit retirement event naming the preserving representative.

Required behavior:

- duplicate observations leave the normal projection;
- every original ID remains recallable with its own provenance;
- retirement is branch-local;
- repeated folds are no-ops;
- malformed retirement events reject atomically;
- V3/V4-only observations without canonical custom evidence are not retireable.

Measure actual active-token reduction before assuming this materially solves capacity pressure.

### Milestone 3 — Phase C reflection supersession

Implement immutable reflection revision relationships before broader observation retirement.

Required invariants:

- reflection content/support changes create a new revision ID;
- no self-supersession, cycles, unknown IDs, or conflicting successors;
- contradictory new reflections do not silently replace older ones;
- a reflection cannot leave the current projection while it is the sole current representation preserving a retired observation;
- every preservation obligation transfers explicitly to a current successor or other current evidence;
- superseded revisions remain recallable.

This milestone controls reflection growth and is a prerequisite for safe semantic convergence.

### Milestone 4 — 300/600/900-observation quality harness

Build the evaluation harness before semantic retirement.

Fixtures must preserve and assert:

- exact identifiers and paths;
- versions and configuration values;
- error text and diagnoses;
- user corrections and scope changes;
- decisions and rationale;
- chronology and supersession transitions;
- unresolved work and constraints;
- source provenance and missing-source disclosure.

Use deterministic generated filler around a small fixed set of required facts. Do not snapshot megabytes of output. LLM-as-judge may supplement but never replace deterministic required-fact assertions.

Compare:

1. retention-only baseline;
2. reflection-call preservation claims;
3. separate constrained retirement call, only if it offers measurable safety benefit.

Record false-retirement, false-retention, context reduction, output validity, and repeat-fold convergence.

### Milestone 5 — Phase D semantic retirement decision

Enable `fully-absorbed` or semantic `superseded` retirement only if the quality harness justifies it.

Requirements:

- explicit per-observation retirement proposals, never omission-sensitive keep lists;
- complete canonical evidence remains durable and recallable;
- local schema, ID, branch, fingerprint, and preservation-obligation validation;
- ambiguity retains the observation;
- invalid or truncated provider output retires nothing;
- the complete lifecycle batch applies atomically with successful compaction details;
- real-session trials show meaningful baseline convergence without required-fact loss.

This is the milestone expected to provide major long-term relief from observer baseline growth.

### Milestone 6 — Effectiveness, disk, and cache refinement

Only after lifecycle correctness and convergence are proven:

- add active/retired token accounting;
- add session growth accounting by durable record category and bytes per compaction;
- verify V5 details remain incremental rather than accumulating snapshots;
- measure repeated compaction-summary bytes separately from one-time evidence bytes;
- report observer baseline size and minimum fresh-delta headroom;
- report summary section contributions and projected post-compaction context;
- confirm protected overflow becomes exceptional;
- measure first cold post-compaction request separately from later cached requests;
- revisit reflector/pruner common-prefix cache optimization only if telemetry justifies it.

Do not improve cache metrics by withholding active evidence or weakening chronology, provenance, correction handling, or deduplication context.

## Expected relief by milestone

| Milestone | Near-boundary warning | Long-term baseline growth | Disk effect |
|---|---:|---:|---:|
| Capacity-aware segmentation | Strong mitigation for small overruns | None | Neutral |
| Exact-duplicate retirement | Possible modest relief | Modest, workload-dependent | Small future-summary reduction; no existing-byte reclamation |
| Reflection supersession | Limited direct relief | Bounds reflection revisions | Bounds future current-reflection projection; old revisions remain one-time records |
| Quality harness | No runtime relief | Establishes safe decision evidence | Test-only |
| Validated semantic retirement | Major expected relief | Primary convergence mechanism | Reduces future summary repetition; preserves one-time evidence |
| Effectiveness/disk/cache tuning | Operational refinement | No replacement for lifecycle convergence | Measures and bounds remaining repeated storage |

## First actions in the fresh session

1. Read `PLAN.md`, `CONTEXT.md`, this handoff, and `docs/MEMORY_LIFECYCLE_DESIGN_2026-08-26.md`.
2. Confirm `git status` is clean and `HEAD` includes `bbbe61f` plus this handoff commit.
3. Read the observer serializer, epoch-capacity calculation, segmented `sourceProgress`, proactive caller, and compaction catch-up caller only.
4. Reproduce the 108,898 versus 108,800 calculation in a focused test before changing code.
5. Implement Milestone 1 as an isolated, reversible change.
6. Run focused capacity/coverage tests first, then typecheck, full suite, build, and installation once the milestone is complete.
7. Stop for review before Phase B changes persisted retirement semantics.

## Rollback points

- Pre-lifecycle design checkpoint: `d506816`.
- Completed Phase A journal: `bbbe61f`.
- The capacity fix, exact-duplicate retirement, reflection supersession, and semantic retirement must each receive separate commits.

## Explicitly out of scope for the next immediate milestone

- Raising the 40% model-relative epoch cap without evidence.
- Omitting baseline memories to fit a request.
- Semantic observation retirement.
- Reflection supersession.
- Physical session-file vacuuming.
- Sidecar database migration.
- Provider-specific cache tricks.
- Combining multiple roadmap phases in one commit.
