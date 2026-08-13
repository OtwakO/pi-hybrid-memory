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

- **Status**: Confirmed policy/implementation mismatch
- **Files**: `src/merge/pipeline.ts`, `PLAN.md`, `tests/pipeline.test.ts`
- **Issue**: The current trimming loop may eventually remove critical observations, while VCC/reflections/headers are untrimmed. Consequently it can both violate critical-retention guidance and still return a summary above `maxSummaryTokens`.
- **Recommended correction**: Budget typed units by retention priority, trim stale transcript/VCC before durable semantic memory, protect critical observations and reflections, and define explicit overflow behavior when protected content alone exceeds the cap.
- **Cost/risk**: Medium implementation, low schema compatibility risk; summary-content behavior changes and needs careful tests.

### 3. Catch-up chunks do not see observations produced by earlier chunks

- **Status**: Confirmed duplication risk
- **File**: `src/compaction-hook.ts`
- **Issue**: `priorObservationLines` is computed once before the catch-up loop. Repeated facts crossing adjacent chunks can therefore be emitted more than once.
- **Recommended correction**: Add accumulated records to the prior-observation list for each later chunk; optionally deduplicate normalized exact content before persistence.
- **Cost/risk**: Low cost and low compatibility risk.

### 4. VCC history grows while observations absorb budget pressure

- **Status**: Confirmed growth behavior; retention policy decision
- **Files**: `src/vcc/merger.ts`, `src/merge/pipeline.ts`
- **Issue**: Previous and fresh VCC briefs are concatenated, while the global budget primarily drops observations. Stale transcript history can crowd out higher-value semantic memory.
- **Recommended correction**: Prioritize the fresh brief and fit old brief content only into a bounded remainder; combine this with the summary-budget redesign rather than patching independently.
- **Cost/risk**: Medium cost and medium behavioral risk.

## Smaller practical improvements

### Narrow observation provenance

Every observation currently receives every source id from its whole chunk. This makes `hm_recall` previews broad and expensive. A future additive protocol could require each generated observation to cite its smallest validated source-id subset. This improves evidence quality but requires changing the observer tool-call contract, so it should be isolated and evaluated carefully.

### Reflection recall provenance

The README describes reflection-to-observation/source provenance, but reflection recall currently returns only reflection content and supporting observation ids. Following those ids into bounded observation/source previews would make the most compressed memories auditable. This is a small–medium, compatibility-safe improvement.

### Apply `maxFiles`

`maxFiles` is documented/configured but current compaction formatting hard-codes file-list limits. Apply the setting with an explicit total or per-category policy and regression tests.

## Prompt-cache audit

### What is already cache-friendly

- System prompts and tool schemas are stable.
- New conversation turns append at the tail, preserving the prior main-session prefix between compactions.
- `hm_recall` results appear at the conversation tail and do not invalidate earlier prefix content.
- Observer instructions now precede changing reflections, observations, and source chunks.

### Main cache limitations

1. Extension-owned observer/reflector/pruner calls do not pass a stable operation-scoped session/cache identity even though the underlying APIs support it. This can reduce routing or explicit prompt-cache reuse for providers such as OpenAI or Mistral. Use distinct keys for observer, reflector, and pruner rather than sharing one structurally different stream.
2. Provider usage fields (`input`, `output`, `cacheRead`, `cacheWrite`) are discarded. `ctx.getContextUsage()` measures context occupancy, not cache effectiveness.
3. Every compaction replaces the first session summary, inherently invalidating the prior main-session prefix. Between compactions the prefix remains stable; avoiding unnecessary marginal compactions and keeping summaries deterministic/compact matters more than cosmetic section rearrangement.
4. Observation timestamps and ids enlarge volatile prompt regions. IDs are necessary for provenance; timestamps may be removable from reflector/pruner inputs only after confirming recency is not semantically needed.

### Cache work status

Implemented on 2026-08-13:

- `/hm-cache-info` captures session-local observer/reflector/pruner response usage and outcomes.
- It shows whole-session aggregates plus a bounded 10-call recent list.
- Provider-reported costs and independent model-price estimates are displayed separately.
- Missing usage or pricing remains `unknown`; prompts, memory content, credentials, and telemetry files are not stored.

Recommended next step after collecting a baseline:

1. Pass stable, operation-scoped session/cache identities to extension-owned LLM calls after verifying the exact Pi API/provider semantics.
2. Compare `/hm-cache-info` before and after the change.
3. Use measured results before removing timestamps or changing compaction frequency.

Suggested metrics per operation and model/provider:

- Input tokens
- Output tokens
- Cache-read tokens
- Cache-write tokens
- Cache-read ratio, only when supported and with a documented denominator
- Call count and estimated cost

Telemetry should be debug/status data only and must not alter or reject memory output.

## Recommended order

1. Add accumulated catch-up observations to later chunk prompts.
3. Apply `maxFiles` and correct reflection recall provenance.
4. Design and test priority-based summary budgeting together with bounded VCC history.
5. Add cache telemetry, then operation-scoped cache identities.
6. Consider narrow per-observation source ids only after the higher-confidence correctness fixes.
