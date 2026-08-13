# Memory and Context Review — 2026-08-13

This review covers correctness, information retention, context cost, recall usefulness, and provider prompt-cache behavior after the VCC accuracy, observer reliability, and prompt-hardening batches.

No numerical cache-hit rate is claimed: the extension currently discards provider cache-read/cache-write usage for its own observer, reflector, and pruner calls.

## Priority findings

### 1. Partial observer results can advance coverage past unexamined content

- **Status**: Fixed on 2026-08-13
- **Files**: `src/om/observer.ts`, `src/observer-trigger.ts`, `src/compaction-hook.ts`
- **Issue**: A terminal `error` or `aborted` event is currently treated as success when the observer recorded at least one observation. Callers then mark the entire bounded chunk as covered, although the failure may have occurred before the model examined later source entries.
- **Risk**: Later entries may not be retried and can eventually be compacted without semantic observation coverage.
- **Correction**: Every terminal failure is now treated as failed coverage, regardless of partial records. Proactive observation retries later; compaction catch-up cancels. Partial records are not persisted because no verified source boundary proves how far the failed run read.
- **Verified**: A regression reproduces a successful observation tool call followed by a terminal stream error and requires `runObserver` to return failure.

### 2. Summary budgeting can remove critical observations and is not a hard cap

- **Status**: Fixed on 2026-08-13
- **Files**: `src/merge/budget.ts`, `src/merge/pipeline.ts`, `tests/pipeline.test.ts`
- **Correction**: Structured budgeting re-renders after each priority removal, trims stale transcript and lower-priority units first, protects reflections, critical observations, the original session goal, and unfamiliar future structural sections, and reports protected-only overflow explicitly.

### 3. Catch-up chunks do not see observations produced by earlier chunks

- **Status**: Fixed on 2026-08-13
- **File**: `src/compaction-hook.ts`
- **Correction**: Every later catch-up chunk now receives observations accumulated from earlier chunks in the same catch-up pass.

### 4. VCC history grows while observations absorb budget pressure

- **Status**: Fixed on 2026-08-13
- **Files**: `src/vcc/merger.ts`, `src/merge/budget.ts`
- **Correction**: Historical brief content fills only the remainder of a configured rolling line window after fresh brief lines, and the priority budget removes transcript before semantic memory.

## Smaller practical improvements

### Narrow observation provenance

Every observation currently receives every source id from its whole chunk. This makes `hm_recall` previews broad and expensive. A future additive protocol could require each generated observation to cite its smallest validated source-id subset. This improves evidence quality but requires changing the observer tool-call contract, so it should be isolated and evaluated carefully.

### Reflection recall provenance

The README describes reflection-to-observation/source provenance, but reflection recall currently returns only reflection content and supporting observation ids. Following those ids into bounded observation/source previews would make the most compressed memories auditable. This is a small–medium, compatibility-safe improvement.

### Apply `maxFiles`

Fixed on 2026-08-13. `maxFiles` is now a total Modified → Created → Read budget for both fresh extraction and later VCC merge cycles.

## Prompt-cache audit

### What is already cache-friendly

- System prompts and tool schemas are stable.
- New conversation turns append at the tail, preserving the prior main-session prefix between compactions.
- `hm_recall` results appear at the conversation tail and do not invalidate earlier prefix content.
- Observer instructions now precede changing reflections, observations, and source chunks.

### Main cache limitations

1. Every compaction replaces the first session summary, inherently invalidating the prior main-session prefix. Between compactions the prefix remains stable; avoiding unnecessary marginal compactions and keeping summaries deterministic/compact matters more than cosmetic section rearrangement.
2. Observation timestamps and ids enlarge volatile prompt regions. IDs are necessary for provenance; timestamps remain because chronology helps supersession reasoning and current telemetry does not justify weakening that evidence.

### Cache work status

Implemented on 2026-08-13:

- `/hm-cache-info` captures session-local observer/reflector/pruner response usage and outcomes.
- It shows whole-session aggregates plus a bounded 10-call recent list.
- Provider-reported costs and independent model-price estimates are displayed separately.
- Missing usage or pricing remains `unknown`; prompts, memory content, credentials, and telemetry files are not stored.

Implemented after the first telemetry baseline:

- Observer, reflector, and pruner calls receive stable identities scoped by Pi session and operation.
- Calls request long cache retention. Providers map this to their supported mechanism: prompt-cache keys/retention, cache control, affinity routing, or no-op when unsupported.
- The three operations use separate identities to avoid mixing structurally different prompt streams.

Next measurement step:

1. Compare `/hm-cache-info` before and after the routing/retention change.
2. Continue preserving timestamps and full prior-memory context unless measured savings and behavioral evaluation justify a change.

Suggested metrics per operation and model/provider:

- Input tokens
- Output tokens
- Cache-read tokens
- Cache-write tokens
- Cache-read ratio, only when supported and with a documented denominator
- Call count and estimated cost

Telemetry should be debug/status data only and must not alter or reject memory output.

## Remaining recommended order

1. Correct reflection recall provenance.
2. Consider narrow per-observation source ids only after evaluating the observer tool-contract change.
3. Consider eliminating the observer confirmation turn only after measuring its residual cost under the new cache routing.
