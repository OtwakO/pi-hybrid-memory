# Magic Context cache architecture: source review and comparison

## Scope and reviewed revisions

This report is intentionally limited to the parts of Magic Context that affect long-session memory quality and prompt-prefix caching.

- **Magic Context:** [`cortexkit/magic-context`](https://github.com/cortexkit/magic-context), commit [`f99ddc17be7dc8388e7dd5ac7bf932c908d7445b`](https://github.com/cortexkit/magic-context/tree/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b), committed **2026-08-20**, subject `dashboard: bump version to 0.13.1`.
- **pi-hybrid-memory comparison:** commit [`50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66`](https://github.com/OtwakO/pi-hybrid-memory/tree/50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66), committed **2026-08-13**, subject `feat: optimize cache and context retention`.
- Sources used: current repository code, repository tests, `ARCHITECTURE.md`, `CONFIGURATION.md`, and the official docs shipped in `packages/docs`.

Labels used below:

- **Confirmed** — directly implemented in source or asserted by a focused test.
- **Documented** — stated by official repository documentation but not necessarily enforced exactly as written.
- **Interpretation** — architectural conclusion drawn from the confirmed mechanisms.

## Executive summary

Magic Context does **not** keep one ever-changing summary at the front of the prompt. It creates a segmented prefix:

```text
stable system instructions
→ m[0]: frozen cumulative baseline
→ m[1]: cached volatile delta
→ live raw conversation tail
```

The central rule is: **do not first-apply a mutation on a normal cache-hit pass**. New compartments, memories, profile additions, queued drops, and cleanup work wait for a pass that is already allowed to change bytes. Most turns replay both `m[0]` and `m[1]` byte-for-byte; a smaller class of turns refreshes only `m[1]`; rare “hard” folds rebuild `m[0]`, re-run deterministic decay, and reset `m[1]` to a stable placeholder. This is implemented in both OpenCode and Pi adapters and covered by byte-prefix stability tests ([pass taxonomy](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/ARCHITECTURE.md#L34-L67), [OpenCode test](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/e2e-tests/tests/cache-stability.test.ts#L6-L27), [Pi test](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/e2e-tests/tests/pi-cache-stability.test.ts#L183-L266)).

Memory quality is maintained on separate planes:

1. the historian appends multi-tier chronological compartments;
2. durable facts are promoted into project memory;
3. deterministic decay controls how much old history renders;
4. scheduled dreamer jobs map, verify, curate, and classify memories;
5. search and expansion recover information omitted from the automatic prompt.

The important qualification is that “unbounded” means **the rendered prompt remains bounded while durable storage and the session timeline can continue growing**. It does not mean the database, transcript, or every recovery representation is literally unbounded.

## 1. Durable model: append logs plus materialized snapshots

### 1.1 Raw history remains the source of truth

**Confirmed.** In the default TypeScript path, the historian reads raw host session history and appends compartment rows; ordinary historian publication does not delete the original raw messages. Compartments retain start/end ordinals and message IDs, title, four paraphrase tiers, importance, episode type, and creation time ([schema](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/storage-db.ts#L866-L888), [type](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/compartment-storage.ts#L32-L55)). Incremental publication uses append semantics; recomp/upgrade paths are the explicit replacement paths ([append](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/compartment-storage.ts#L311-L326), [replace/recomp](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/compartment-storage.ts#L564-L630)).

**Confirmed.** The optional Rust/module path additionally stores compressed historian transcripts and, in current schema, compressed original CK message arrays for durable `ctx_expand` recovery ([store migration](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/crates/mc-store/src/lib.rs#L2395-L2402), [stored transcript shape](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/crates/mc-store/src/lib.rs#L4142-L4152)). Condensed transcripts have per-row and per-session bounds; when raw messages exist, eviction clears the optional condensed transcript before deleting the raw recovery payload ([limits](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/crates/mc-store/src/lib.rs#L400-L410), [eviction](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/crates/mc-store/src/lib.rs#L15946-L15990)).

### 1.2 Compartments are append-oriented, but rendered context is a snapshot

**Confirmed.** Normal historian output appends compartments and publishes facts/marker state transactionally. Structural operations—recomp, merge/delete, revert, upgrade—replace or truncate the compartment set and invalidate/fence cached state. The Rust store has an explicit `revert_epoch` so an in-flight historian cannot publish against a recut history ([revert test](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/crates/mc-store/src/lib.rs#L22891-L22937)).

By contrast, `m[0]` and `m[1]` are **materialized snapshots** stored as BLOBs with their watermarks and identity markers in `session_meta` ([schema](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/storage-db.ts#L1400-L1495), [atomic persist](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/storage-meta-shared.ts#L506-L553)). Thus the durable history is mostly append-oriented, while the provider-visible prefix is snapshot-and-delta.

### 1.3 Memory rows are mutable; cache reconciliation is append-only

**Confirmed.** Project memories are mutable rows containing status, importance, source session/type, seen/retrieval counts, expiry, verification state, supersession, merge metadata, and optional embeddings ([schema](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/storage-db.ts#L1037-L1078)). Exact duplicate promotion is idempotent and increments `seen_count` rather than creating another row ([promotion](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/memory/promotion.ts#L34-L84)).

Non-additive changes also append a `memory_mutation_log` record. That log is what lets a changed or removed baseline memory appear as a correction in `m[1]` without immediately rebuilding `m[0]` ([log schema](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/storage-db.ts#L1169-L1184), [rendered correction block](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L2440-L2517)). This deliberately permits a temporarily stale baseline plus an explicit “trust these changes” delta until the next hard fold.

## 2. The cache-preserving prefix

### 2.1 Injection order

**Confirmed.** Stable Magic Context guidance remains in the system prompt. Data-bearing blocks are moved into two synthetic user messages before the raw tail ([Pi system-prompt contract](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/pi-plugin/src/system-prompt.ts#L1-L9), [OpenCode prepend](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L2905-L2945), [Pi prepend](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/pi-plugin/src/inject-compartments-pi.ts#L2328-L2359)).

`m[0]` renders, in order:

1. project docs;
2. baseline user profile;
3. `<session-history>` with decay-rendered compartments;
4. `<project-memory>`;
5. optional memory mural marker/image.

([implementation](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L1984-L2031))

`m[1]` renders, in order:

1. `<memory-updates>` corrections/removals;
2. new compartments at P1/full fidelity;
3. newly added memories;
4. new user-profile content.

When empty, it still renders a fixed placeholder, partly to keep the synthetic-message/cache-breakpoint shape stable ([implementation](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L2526-L2653), [placeholder](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L917-L919)).

### 2.2 Three pass classes

**Confirmed.** The code and architecture document implement three cache classes:

| Class | What changes | Reusable prefix |
|---|---|---|
| **SOFT+ / defer** | Neither `m[0]` nor `m[1]`; only the newly appended tail advances | `system + m[0] + m[1]` |
| **SOFT** | `m[1]` is recomputed; `m[0]` is replayed | `system + m[0]` |
| **HARD** | `m[1]` folds into a rebuilt `m[0]`; decay re-runs; `m[1]` resets | normally system only |

([architecture](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/ARCHITECTURE.md#L47-L67), [materialization decision](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L1494-L1508))

The crucial invariant is stronger than “mutations are deterministic”: **a deferred pass replays already-frozen decisions and bytes; it does not discover and first-apply a new mutation**. Pending drops, strips, cleanup, and historian publications wait for an execute/materialization pass. A due hard fold only opens mutation gates when the fold actually materialized, not when it was merely advisory ([executed-fold gate](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/fold-execution-gate.ts#L1-L3), [Pi parity note](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/pi-plugin/PARITY.md#L947-L953)).

### 2.3 What causes a hard fold

**Confirmed implementation:** first render, missing/invalid cached `m[1]`, renderer/config epoch changes, model change, system-prompt hash change, a consumed idle-TTL event, project identity/workspace or external memory epoch change, structural compartment mutation, and upgrade-state change ([OpenCode decision](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L1523-L1649), [Pi decision](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/pi-plugin/src/inject-compartments-pi.ts#L958-L1146)).

Deliberately **not** hard-fold triggers: a newly appended compartment, an additive memory, an additive profile update, or a project-doc edit. These ride `m[1]` or wait for the next natural fold. In-session updates/archive/merge also use the mutation delta instead of bumping the project epoch.

A pressure backstop prevents the delta from growing indefinitely. On a cache-busting pass, it refolds when any of these holds:

- more than 40 rendered memory mutations;
- `m[1]` exceeds 15% of `m[0]`, once `m[0]` is at least 500 tokens;
- `m[1]` exceeds 20% of the history budget.

([OpenCode implementation](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L3225-L3283), [Pi implementation](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/pi-plugin/src/inject-compartments-pi.ts#L2517-L2565))

### 2.4 TTL is a scheduling assumption, not provider control

**Confirmed.** `cache_ttl` tells Magic Context when it may assume the provider prefix has expired and therefore when a rebuild is likely “free.” It neither configures nor extends the provider cache. The special value `never` disables the elapsed-time heuristic; it does not make the provider cache permanent ([configuration](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/CONFIGURATION.md#L118-L153), [scheduler](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/scheduler.ts#L55-L119)).

**Interpretation.** Magic Context is cache-aware rather than cache-authoritative. Actual provider breakpoints (`cache_control`, automatic provider caching, subscription-specific TTL) remain host/provider behavior. Magic Context controls when *its own* mutations land.

## 3. Compaction, folding, and long-session bounds

### 3.1 Historian production is bounded and asynchronous

**Confirmed.** The historian fires from pressure, commit clusters, or accumulated narratable tail. Trigger budget is 5% of the main model's usable pre-execute window, clamped to 5k–50k tokens; the historian chunk is 25% of the historian model's context, clamped to 8k–50k ([budget derivation](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/derive-budgets.ts#L22-L32), [functions](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/derive-budgets.ts#L36-L74)).

The prompt is bounded to rotating seed examples, the last six session compartments, project memory for deduplication, and the new chunk—not the complete accumulated state ([runner](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/compartment-runner-incremental.ts#L412-L435)). Publication appends compartments and facts atomically, queues covered-tail drops, and defers marker movement/history refresh so publication itself does not force a cache bust ([publish path](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/compartment-runner-incremental.ts#L621-L759)).

### 3.2 Protected live tail

**Confirmed.** The historian only consumes history before a protected tail. The tail target is bounded by 40% of usable context and an absolute 96k cap. Tool call/result arcs are kept atomic; recent open arcs protect in-flight work, while stale open arcs cannot freeze the historian forever ([constants and target](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/protected-tail-boundary.ts#L147-L219), [resolver](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/protected-tail-boundary.ts#L499-L603)).

### 3.3 Deterministic decay, only at a hard fold

Each compartment carries P1–P4 plus importance. A pure curve selects a tier from age, importance, and budget pressure; P5 means omitted. Importance 50 has a nominal 24-compartment half-life, and each 25 importance points doubles/halves it ([curve](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/decay-curve.ts#L26-L70)). The renderer then demotes oldest-first if exact tokenization still exceeds budget ([renderer](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/decay-render.ts#L182-L261)).

Decay tiers are frozen between hard folds. This sacrifices continuously perfect age-based fidelity in exchange for byte stability. New compartments remain full-fidelity in `m[1]`; older baseline compartments re-tier only when `m[0]` is already rebuilding.

### 3.4 Prompt bounds versus storage bounds

Normal configuration reserves 15% of `context_limit × execute_threshold` for rendered session history, uses a 4k configured memory injection budget, and a 4k user-profile budget ([history setting](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/config/schema/magic-context.ts#L775-L782), [memory setting](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/config/schema/magic-context.ts#L972-L997), [profile fallback](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L908-L919)). Auto-search hints are capped around 200 tokens ([hint builder](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/auto-search-hint.ts#L25-L27)). `ctx_expand` is capped around 15k tokens per response ([constant](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/tools/ctx-expand/constants.ts#L1-L13)).

**Interpretation.** These mechanisms bound the **wire**, not total durable state. Compartments, raw host history, search indexes, memories, and mutation logs can continue growing until curation, session deletion, revert/recomp, or operational storage limits intervene.

## 4. Memory injection, quality, retrieval, and provenance

### 4.1 Automatic injection

**Confirmed.** Active and permanent memories are selected under the token budget. Current V2 selection is permanent first, then importance descending, then ID; final render order is category priority and ID. Importance is intentionally absent from the rendered line so reclassification can change future selection without changing bytes already on the wire ([selection/render order](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L1015-L1040), [budget selection](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L1657-L1684), [wire line](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L1915-L1942)).

Memory expiry uses the `m[0]` materialization timestamp as a frozen cutoff during `m[1]` replay, preventing a wall-clock expiry from silently changing a defer-pass prefix ([query contract](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/memory/storage-memory.ts#L679-L698)).

### 4.2 Quality maintenance

**Confirmed.** The dreamer is not one monolithic agent. Separate scheduled tasks map memories to source files, verify changed/broad pools against current code, curate duplicates and low-value entries, and classify importance/scope/shareability ([official task list](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/docs/src/content/docs/concepts/dreamer.md#L26-L45)).

The stronger implementation details are:

- mapping/verify manifests must cover exactly the supplied batch;
- file normalization occurs outside the transaction;
- updates and archives route through the `m[1]` mutation log rather than bumping the project epoch;
- verification writes are lease-guarded;
- classification is host-applied and forces sensitive text private even if the model says shareable.

([mapping apply](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/dreamer/map-memories.ts#L302-L415), [verify apply](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/dreamer/verify.ts#L340-L496), [classification](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/dreamer/classify.ts#L593-L629)).

### 4.3 Unified retrieval

**Confirmed.** `ctx_search` combines memories, raw-message FTS, compartment embeddings, optional git commits, primers, and notes. Memory semantic/FTS scores are weighted 0.7/0.3; source-specific boosts then influence the unified sort ([weights](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/search.ts#L37-L54), [memory merge](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/search.ts#L589-L653), [unified dispatch](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/search.ts#L1593-L1822)).

Search hard-filters memories already injected and raw messages newer than the last compartment boundary, because both are already visible in the prompt ([tool boundary/filter](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/tools/ctx-search/tools.ts#L205-L220)). Auto-search only first-applies a hint to the newly arrived tail user message, persists the exact decision/text, and replays it on later passes ([runner](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/auto-search-runner.ts#L241-L409)).

### 4.4 Provenance limits

**Confirmed.** A promoted project-memory row records `source_session_id` and `source_type`, but ordinary historian fact promotion does not attach the exact source message IDs or compartment range to that memory row ([memory shape](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/memory/types.ts#L43-L69), [promotion](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/memory/promotion.ts#L70-L80)). The source range survives on the compartment, and `ctx_search`/`ctx_expand` can recover history by ordinal, but the memory-to-exact-message edge is indirect.

**Interpretation.** Magic Context optimizes for broad automatic recall plus retrievable session history, not audit-grade per-memory evidence chains. Its primer and user-memory candidate tables carry stronger explicit source ranges than ordinary project memories.

## 5. Epochs, reset, and marker mechanics

Magic Context uses several independent version fences rather than one global epoch:

- **Project memory epoch:** external/dashboard/migration changes that cannot otherwise signal a live session; in-session changes use `m[1]` watermarks/logs ([architecture](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/ARCHITECTURE.md#L83-L90)).
- **Compartment render epoch / upgrade identity:** one-time hard fold when renderer semantics change ([decision](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L1532-L1547)).
- **System hash and sticky date:** date drift is frozen on cache-stable turns and advances only on a turn already busting the prompt ([Pi implementation](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/pi-plugin/src/system-prompt.ts#L106-L221)).
- **Model/provider identity and TTL:** fold when the old provider cache is assumed unusable.
- **Structural mutation watermark:** compartment delete/merge/recomp changes the baseline.
- **Rust `revert_epoch`:** fences historian publication across destructive recuts.

**Confirmed.** OpenCode session deletion clears session-scoped rows. Pi has no equivalent deletion event; switching sessions clears process-local caches but deliberately retains durable `m[0]`, compartments, tags, and other state so switching back can reuse the prefix ([session table list](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/storage-session-tables.ts#L9-L43), [Pi switch behavior](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/pi-plugin/src/index.ts#L2337-L2368)).

**Confirmed.** Both adapters own the visible compaction boundary rather than allowing native compaction to race them. Pi cancels native compaction, stages a marker, and trims the model-visible wire independently so a delayed marker cannot duplicate compacted history ([Pi parity](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/pi-plugin/PARITY.md#L93-L103)).

## 6. Provider and adapter assumptions

1. **The host must expose a per-request message transform.** The whole design depends on rebuilding the outgoing message array and replaying persisted mutations deterministically.
2. **Magic Context must be the sole context manager.** Official setup disables native compaction and conflicting context plugins to avoid double compression and cache thrash ([README](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/README.md#L99-L102), [conflict policy](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/README.md#L142-L154)).
3. **Context limits are adapter-specific.** OpenCode trusts its resolved SDK provider config; Pi trusts `getContextUsage().contextWindow`/the active model, with detected overflow as a lower empirical override ([Pi/OpenCode parity](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/pi-plugin/PARITY.md#L465-L494)).
4. **Output reservation is provider-shape-dependent.** The repository distinguishes shared input/output windows from separate quotas rather than trusting catalog output fields blindly ([geometry spec](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/docs/specs/context-window-geometry.md#L13-L31)).
5. **The default implementation is TypeScript.** Rust mode is experimental and activates only with trusted user-level `subc` configuration; compaction-off forces TypeScript ([resolver](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/config/transform-mode.ts#L15-L34)).

## 7. Official documentation claims versus current implementation

| Claim | Finding |
|---|---|
| “Background work never invalidates the cached prefix” / “cache survives the whole session.” | **Directionally true, literally overstated.** Background publication itself is deferred, and most passes are byte-identical. `m[1]` soft refreshes and pressure hard folds are intentional invalidations. The official cache page's “honest framing” acknowledges this ([docs](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/docs/src/content/docs/concepts/cache-architecture.md#L57-L66)). |
| Project-doc hash changes trigger a hard fold. | **Documentation drift.** The public cache page lists project-doc hash under content-change triggers ([docs](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/docs/src/content/docs/concepts/cache-architecture.md#L34-L41)); current code and protected `ARCHITECTURE.md` explicitly say docs edits wait for the next natural hard fold ([code](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L1639-L1642)). |
| Memories are ordered by category, then recency within category. | **Not current V2 behavior.** Selection is permanent/importance/ID; wire order is category/ID ([docs claim](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/docs/src/content/docs/concepts/memory.md#L44-L50), [implementation](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/hooks/magic-context/inject-compartments.ts#L1015-L1040)). |
| `retrieval_count_promotion_threshold` promotes memories to permanent. | **Configuration/documentation exists, but no promotion implementation was found at the reviewed commit.** Explicit searches find the key only in schema/config/tests; explicit search increments `retrieval_count` but does not change status ([counter update](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/memory/storage-memory.ts#L415-L424), [search update](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/packages/plugin/src/features/magic-context/search.ts#L1795-L1819)). |
| Original messages are never deleted and can always be recovered with `ctx_expand`. | **True for ordinary historian operation, not an absolute lifecycle guarantee.** Session deletion, revert/recomp recuts, pre-transcript legacy history, and bounded/failed transcript capture can make material unavailable. The module facade explicitly reports “no longer recoverable” in those cases ([implementation](https://github.com/cortexkit/magic-context/blob/f99ddc17be7dc8388e7dd5ac7bf932c908d7445b/crates/mc-module/src/lib.rs#L10669-L10697)). |

## 8. Direct comparison with pi-hybrid-memory

### 8.1 Main architectural difference

`pi-hybrid-memory` is a **snapshot compactor with append-only observation entries**. Magic Context is a **continuous context owner with a cached baseline/delta projection**.

In `pi-hybrid-memory`, the observer appends `hybrid-memory.observation` entries as new chunks cross a threshold ([trigger](https://github.com/OtwakO/pi-hybrid-memory/blob/50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66/src/observer-trigger.ts#L19-L56), [append](https://github.com/OtwakO/pi-hybrid-memory/blob/50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66/src/observer-trigger.ts#L139-L150)). At Pi compaction, the extension loads the previous compaction's memory snapshot, adds covered observations, optionally reflects/prunes, merges the old and new VCC state, and returns one replacement summary plus one new `details` snapshot ([pipeline](https://github.com/OtwakO/pi-hybrid-memory/blob/50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66/src/compaction-hook.ts#L199-L341)).

There is no equivalent of persisted `m[0]`/`m[1]`, no defer/soft/hard taxonomy, no cached boundary watermark, and no deterministic replay of main-conversation mutations. Every native compaction rewrites the summary message as a unit.

### 8.2 File-by-file comparison

| pi-hybrid-memory file | Current behavior | Difference from Magic Context |
|---|---|---|
| [`src/om/observer.ts`](https://github.com/OtwakO/pi-hybrid-memory/blob/50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66/src/om/observer.ts#L90-L172) | One observer call receives all current reflections, observations, then a bounded new chunk; records observations through a tool. Every emitted observation gets the chunk's complete `allowedSourceEntryIds` list. | Stronger direct evidence link than an ordinary Magic Context project-memory row, but coarser than per-fact source selection. The prompt's prior-memory section grows/changes each run, so stable operation identity does not make the full prompt prefix stable. |
| [`src/observer-trigger.ts`](https://github.com/OtwakO/pi-hybrid-memory/blob/50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66/src/observer-trigger.ts#L19-L154) | Runs after turns when raw tokens since the last observation boundary exceed a fixed threshold; appends observation records. | No provider-prefix mutation occurs on the main conversation until native compaction, but there is also no background compartment projection or model-relative protected-tail geometry. |
| [`src/compaction-hook.ts`](https://github.com/OtwakO/pi-hybrid-memory/blob/50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66/src/compaction-hook.ts#L50-L347) | Catch-up observer is fail-closed; reflection/pruning runs at an observation-token threshold; VCC is regenerated and merged with `previousSummary`; Pi writes one compacted summary. | Magic Context separates historian publication from prompt materialization. `pi-hybrid-memory` couples memory folding, structural summary folding, and native context replacement into one cache-busting event. |
| [`src/merge/budget.ts`](https://github.com/OtwakO/pi-hybrid-memory/blob/50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66/src/merge/budget.ts#L152-L195) | Fixed `maxSummaryTokens`; trims transcript, low/medium observations, volatile VCC lines, then high observations; reflections and critical observations can force protected overflow. | Good quality-first policy, but unlike Magic Context it has no model-relative history allocation, multi-tier decay, or bounded delta backstop. A single summary must represent all retained history at one fidelity. |
| [`src/cache-options.ts`](https://github.com/OtwakO/pi-hybrid-memory/blob/50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66/src/cache-options.ts#L3-L16) | Stable `pi-hybrid-memory:<session>:<operation>` identity and `cacheRetention: "long"` for observer/reflector/pruner calls. | This is **extension-subcall routing/retention**, not main-session prefix architecture. It may improve provider affinity where supported, but cannot compensate for changed prompt bytes. |
| [`src/cache-telemetry.ts`](https://github.com/OtwakO/pi-hybrid-memory/blob/50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66/src/cache-telemetry.ts#L173-L209) | Reports extension-owned LLM cache reads/writes and cost; explicitly excludes the main Pi conversation. | It cannot currently measure the cache behavior that Magic Context optimizes: byte stability and cache hits of the main conversation prefix. |

### 8.3 Snapshot and provenance behavior

`pi-hybrid-memory`'s compaction `details` is a V4 snapshot of retained observations and reflections ([merge output](https://github.com/OtwakO/pi-hybrid-memory/blob/50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66/src/merge/pipeline.ts#L35-L57)). Observation custom entries are append-only between compactions, while the next compaction snapshot may prune observations. VCC state is likewise folded from the previous summary into a new one.

Its evidence model is stronger than Magic Context's ordinary project-memory provenance:

- observation → `sourceEntryIds`;
- reflection → `supportingObservationIds`;
- source lookup → exact current-branch entry.

However, exact source recovery is branch-local and can fail after Pi has pruned an entry ([recall implementation](https://github.com/OtwakO/pi-hybrid-memory/blob/50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66/src/tools/recall.ts#L296-L366)). Also, the README says reflection lookup follows supporting observations, but the current reflection branch returns only the reflection text and does not traverse `supportingObservationIds` ([README claim](https://github.com/OtwakO/pi-hybrid-memory/blob/50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66/README.md#L154-L163), [implementation](https://github.com/OtwakO/pi-hybrid-memory/blob/50191ba6c7ad3cbaea6c4864668bbbd43e9ffc66/src/tools/recall.ts#L369-L385)).

## 9. Transferable lessons

1. **Treat byte identity as a state-machine invariant, not a formatting preference.** Persist first-application decisions and replay them; do not recompute “equivalent” text on cache-hit turns.
2. **Separate durable append from provider-visible materialization.** Background work should publish durable state without immediately rewriting the prompt.
3. **Use a frozen baseline plus a bounded correction delta.** Additive changes and corrections can surface quickly without rewriting the largest stable block.
4. **Re-tier only when the baseline is already rebuilding.** Deterministic decay preserves memory quality without creating a new cache miss every turn.
5. **Keep an explicit protected live tail and atomic tool arcs.** Context reduction must not split current intent from its tool execution.
6. **Budget different data planes separately.** History, durable memory, user profile, and recall output have different value and growth patterns.
7. **Make correction provenance explicit.** A stale baseline is tolerable only if the delta clearly supersedes/removes old facts.
8. **Test serialized prefixes directly.** Provider telemetry alone cannot reveal a one-byte mutation early in the prompt.

## 10. Non-transferable assumptions

1. Magic Context can rebuild every outgoing request through host transform hooks and can disable native compaction. `pi-hybrid-memory` currently delegates final context replacement to Pi's compaction contract.
2. The two-slot layout assumes providers reward long prefix reuse and tolerate synthetic user messages in the relevant position.
3. The design carries substantial SQLite state, cross-process transactions, mutation logs, marker ownership, and adapter-specific replay machinery. That complexity is not justified merely to improve observer-call cache hits.
4. Magic Context's cross-session project memory, embeddings, dreamer scheduler, and shared OpenCode/Pi database are product-level assumptions beyond `pi-hybrid-memory`'s current session-local scope.
5. Rust/module `revert_epoch`, raw-message transcript copies, and incremental native attachment caches are specific to Magic Context's optional sidecar architecture.

## 11. Ranked compatibility-safe recommendations for pi-hybrid-memory

### 1. Add main-conversation prefix observability and byte-stability tests

**Highest value, lowest risk.** Extend telemetry with hashes/byte counts for the main Pi system prompt, compaction summary, and retained prefix across adjacent requests if Pi exposes the request boundary. Add a regression analogous to Magic Context's cache-stability tests. Keep `/hm-cache-info`'s existing extension-call metrics, but clearly separate:

- extension subcall cache;
- main conversation prefix stability;
- compaction-caused full-prefix resets.

Do this before changing storage or compaction semantics.

### 2. Fix reflection provenance retrieval

When `hm_recall` receives a reflection ID, traverse `supportingObservationIds`, then each observation's `sourceEntryIds`, using the existing bounded/fair preview allocator. This matches the README, improves memory verification, and requires no persisted-schema change.

### 3. Add explicit compaction-generation metadata

Add a backward-compatible optional generation/snapshot identifier and prior-boundary identifier to `MemoryDetailsV4` (or a V5 reader that continues accepting V4). This would make snapshot replacement, branch recovery, and cache telemetry auditable without changing the rendered summary grammar.

### 4. Offer model-relative summary budgeting as an opt-in layer

Keep `maxSummaryTokens` as the compatibility ceiling, but optionally derive a lower/upper target from Pi's live context window. This transfers Magic Context's “budget against usable geometry” lesson without adopting its context owner. Preserve the existing trim priority and protected-overflow behavior.

### 5. Split stable and dynamic text in observer/reflector/pruner prompts

Keep stable instructions in a separate leading message and put prior memory plus the new chunk in following messages. This only increases the reusable subcall prefix; it does not alter memory data or main-session compaction. Measure before and after with the existing cache telemetry.

### 6. Prototype `m[0]`/`m[1]` only as a separate opt-in context-owner mode

Do **not** retrofit two-slot folding into the existing native-compaction path. If main-prompt telemetry shows enough cost to justify it, prototype a new mode that:

- explicitly disables/cancels native Pi compaction;
- persists frozen baseline and delta bytes;
- has byte-prefix differential tests;
- retains the current compaction implementation as the rollback path.

This is the closest architectural transfer, but it is last because it changes ownership of the session context and imports most of Magic Context's complexity.
