# Incremental Reflection and Bounded Projection Roadmap

**Status:** Stage 1 complete and isolated-live validated; incremental persistence not started

**Scope:** Reflection request design, reflection lifecycle persistence, compaction orchestration, and the main-session memory projection.

**Goal:** Preserve immutable evidence and exact provenance while making steady-state `/compact` local-only, keeping extension model requests bounded and cache-compatible, and enforcing a real main-summary token ceiling.

## 1. Production evidence

A real long session reached 1,223 active observations (~86,310 observation tokens) with no reflections. One reflector completion used 88,892 input tokens and 23,448 output tokens, proposed 13 reflections, and persisted none because at least one proposal contained invalid provenance. The complete proposal was rejected atomically. The compaction took several minutes and the next eligible compaction could repeat the same work.

The same session assembled a ~53,269-token summary despite `maxSummaryTokens: 16,000` because the current budget preserves every remaining critical observation and reports protected overflow instead of enforcing the configured ceiling.

Local measurement rules out replay and prompt construction as meaningful latency sources: replaying a comparable 1,229-observation branch took ~82 ms, rendering its ~380K-character reflector prompt took ~5 ms, and planning the request took <1 ms. The dominant work is the unbounded completion and output contract.

## 2. Required outcome

The completed design has four derived views over one branch-local journal:

```text
immutable branch journal
        │
        ▼
authoritative BranchMemoryIndex
        │
        ├── bounded observer processor
        ├── bounded incremental reflector processor
        ├── bounded main-session projection
        └── exact hm_recall
```

Steady-state `/compact` performs no extension-owned model calls. It verifies observation coverage, replays durable memory, applies deterministic lifecycle work, builds a bounded memory projection and structural VCC summary, and persists the compaction.

The product guarantee is **lossless durable evidence with bounded high-quality projection and exact recall**. A fixed prompt cannot keep an unbounded history simultaneously visible.

## 3. Non-negotiable invariants

- Observation evidence remains immutable, branch-local, and exactly recallable.
- No semantic observation retirement is introduced. Exact-duplicate retirement remains the only automatic retirement.
- A reflection is persisted only with locally verified canonical observation IDs.
- Request-local evidence handles are never persisted and unknown handles are never guessed.
- Invalid candidates are rejected completely; valid independent candidates may be committed together in one atomic lifecycle entry.
- Reflection failure, backlog, timeout, or abort never prevents local compaction.
- Branch/session fences are checked immediately before every append.
- `buildBranchMemoryIndex()` remains the sole semantic projector.
- Journal state, not cache or in-memory cursors, is the lifecycle authority.
- Main-session projection stays at or below its configured hard ceiling. Omitted evidence remains active and recallable.
- Cache state changes cost and latency only, never correctness or durable progress.

## 4. Minimal module design

### 4.1 Bounded reflection plan

A pure planner accepts current branch memory, unconsidered observation entries, and an explicit token budget. It returns one deterministic working set containing:

1. a bounded new-evidence window;
2. bounded critical/high corrections, directives, constraints, active decisions, and blockers;
3. current reflection heads needed for strengthening;
4. bounded related evidence selected by deterministic lexical identifiers, paths, versions, hashes, errors, numbers, and support links.

No embeddings, persistent index, new runtime configuration, or general retrieval framework are added initially.

Selected evidence is rendered in authoritative order with request-local handles such as `E001`. The handle map is held only for local response validation.

### 4.2 Small reflection transaction

One valid or deliberate-empty submission completes a reflection window. Invalid structural output receives at most one bounded correction opportunity.

The initial evaluated contract should allow no more than four concise reflections and a few thousand output tokens. Exact limits are fixture inputs until Stage 1 evaluation establishes practical values.

Each candidate is validated independently. Unknown handles, empty support, duplicate handles, malformed content, or invalid strengthening reject that candidate. All accepted candidates are mapped to canonical IDs and persisted in one atomic event.

### 4.3 One lifecycle sequence

Incremental reflection persistence must not create a side database or independent reflection ledger. The minimum durable schema change is one generalized branch-local lifecycle sequence whose accepted events point to the prior accepted lifecycle event.

A lifecycle event may contain:

- parent lifecycle entry ID;
- deterministic input fingerprint and compatibility version;
- reflection consideration frontier;
- reflections added;
- deterministic strengthening edges;
- exact-duplicate retirements when produced by compaction.

The consideration frontier means evidence through that observation boundary was processed by the compatible reflection policy; it does not claim that every fact was reflected. Failed or poisoned windows remain eligible for later consolidation without blocking newer windows.

V3–V5 remain readable compatibility input. No automatic migration is required.

### 4.4 Incremental orchestration

Reuse the observer's proven shape rather than build a general scheduler:

- at most one reflector task;
- plan from a fresh branch projection;
- perform inference outside the commit section;
- validate and map handles locally;
- enter a short synchronized commit;
- verify the session/branch fence;
- append one lifecycle event.

Reflection is triggered after durable observation progress or later turn activity when backlog is eligible. Transient failures do not advance progress. An unchanged deterministic failure receives a content-free fingerprint/cooldown so it cannot rerun on every event or compaction, while later windows may continue.

Compaction never starts or drains reflection work. It uses the latest durable reflection state. If a reflection result is already in its short commit section, append serialization may briefly complete before replay; compaction does not wait for a multi-minute inference.

### 4.5 Bounded main-session projection

The projection planner receives active observations, current reflections, VCC state, and a hard token budget. It prioritizes:

1. current high-value reflections;
2. correction and revision heads;
3. critical directives and constraints;
4. unresolved blockers and active decisions;
5. recent continuity;
6. bounded task-relevant working observations;
7. compact structural VCC state;
8. explicit recall guidance.

A validated reflection may replace supporting observations in the projection only when it preserves their required meaning. Supporting evidence remains durable. Reflections and their support observations are not rendered redundantly unless an observation contains current operational detail absent from the reflection.

Protected overflow becomes a selection diagnostic, not permission to exceed the configured ceiling.

## 5. Cache design

Observer and reflector requests already use isolated operation-specific session identities. No new cache namespace is needed.

The reflector request layout is:

```text
stable prefix:
  system and tool contract
  bounded current reflection heads
  bounded protected memory

dynamic suffix:
  request-local handle legend
  new evidence window
  related supporting evidence
```

Selection and ordering are deterministic. Prefix reuse is an optimization only.

The compacted main-session summary uses stable section order, no timestamps or telemetry, no redundant evidence, and a hard ceiling. Compaction necessarily replaces the main context, so a cache discontinuity cannot be eliminated; smaller deterministic summaries reduce post-compaction prefill and attention cost.

## 6. Stages

### Stage 1 — Prove the bounded reflection contract without schema changes

Keep the existing `foldMemory()` production seam and compaction-attached persistence temporarily.

Stage 1A result: a pure, runtime-disconnected planner now distinguishes a bounded **focus window** (the evidence this transaction must consider) from bounded protected/recent historical context. This correction was required after a real-session measurement showed that treating all high/critical history as one protected pool would omit hundreds of candidates and obscure transaction progress. The planner assigns deterministic local handles only after final authoritative ordering and reports focus/protected overflow explicitly. On a current 1,290-observation projection, a synthetic latest-12 focus window fit completely with ~12,072 total planned tokens and ~209 ms planning time; historical omissions remained durable by design.

Stage 1B result: request-local handles resolve candidate-by-candidate into canonical observation IDs. A malformed candidate is rejected completely without discarding unrelated valid candidates; accepted canonical candidates still pass through the existing atomic merge/strengthening validator, so there remains one final semantic merge authority.

Stage 1C runtime result: the existing `foldMemory()` seam now reflects only the current pending compaction delta as focus, with bounded protected/recent history and request-local handles. The focus allowance reuses the existing `maxSummaryTokens` memory-quality budget; historical allowances remain fixed evaluation policy, not new configuration. The model contract permits at most four 1,024-character reflections, derives a smaller exact output bound (1,536 tokens on the measured branch), and gives structurally invalid output one correction opportunity. Valid handle candidates survive unrelated invalid candidates; an all-invalid proposal still reports `invalid-provenance` while compaction retains complete memory. User abort returns from compaction before discarded VCC assembly.

Read-only measurement on the current 1,351-observation branch (1,215 committed, 136 pending) selected the complete pending focus plus bounded history into an estimated 24,667-token request with a 1,536-token output bound, versus the observed prior 88,892-input/23,448-output request. Stage 1 remains compaction-attached compatibility work; it does not claim durable historical backlog progress.

Stage 1D telemetry result: the existing `/hm-cache-info` seam reports the latest bounded reflection input estimate, output limit, selected/omitted focus and historical evidence counts, overflow flags, planning duration, and whether completion is running or settled with elapsed time. It stores no prompt text, handles, observation IDs, reflection content, or persistent analytics.

Stage 1 validation result: the 36-file/283-test suite, typecheck, 45-module build, and deterministic real Pi gate pass for repository bundle `3614d7ac21beee7c2407a71c488b6da67b747f362736d33f808179e194fd0f24`. The model-assisted real Pi gate accepted the request-local handle schema, persisted canonical observation support and reflection `mtci68fd0001`, replayed after restart, and completed exact recall for marker `HM-LIVE-MODEL-7Q9X`, path `/srv/hybrid-memory/live-gate/config.json`, and value `41729`. The installed bundle remained `1f41a970d82bc5c8896a403b6015fe6563ac8474c2630a2bcc6026b67dc8b01f` throughout.

Stage 1 is stable in the repository but remains a compatibility step: reflection still runs in `/compact`, has no durable consideration frontier, and the main-session projection can still exceed its configured ceiling. Stage 3 lifecycle design must not begin until the Stage 1 rollout decision is explicit.

Completion gate:

- real long-session read-only plan is bounded;
- invalid canonical-ID copying is eliminated by construction;
- mixed valid/invalid candidate tests accept only valid candidates;
- deterministic plans and handle mappings converge;
- request input/output remain bounded at 300/600/900 observations;
- current lifecycle and recall behavior are unchanged.

### Stage 2 — Evaluate memory quality and practical budgets

Use the existing deterministic quality fixtures plus the real long-session projection. Measure required-fact availability, provenance validity, cross-window strengthening, input/output tokens, deterministic convergence, and redundant projection content. Provider-backed evaluation is used only after deterministic gates pass.

### Stage 3 — Add the generalized lifecycle event

Stage 3A reader-first result: `MemoryLifecycleEventV6` is one minimal shape usable as either compaction details or `hybrid-memory.lifecycle` custom-entry data. It contains only a parent lifecycle entry ID, deterministic input fingerprint, optional reflection progress (canonical observation-entry boundary plus compatibility version), reflection additions/supersessions, and exact-duplicate retirements. `buildBranchMemoryIndex()` remains the sole projector and now replays one total V6 sequence across both entry kinds, exposes only the latest lifecycle entry and reflection frontier, rejects stale parents and unknown/backward same-policy frontiers atomically, derives fork state from the selected branch, and rejects V4/V5 lifecycle authority after V6 has begun. V3–V5 input remains readable before that transition. No runtime writer, trigger, coordinator, or installed schema change is included in Stage 3A.

Stage 3B writer result: successful compactions now emit the same V6 event and parent it to the projector's latest lifecycle entry. Compaction carries forward an already accepted reflection frontier but does not invent or advance one; only the future incremental processor may claim new consideration progress. The deterministic real Pi gate passed two V6 compactions, restart/replay, idempotent exact-duplicate retirement, and old installed-bundle inspection for repository bundle `10f6b387c896d2f2412f2cab05e6953cb7ddae430437f0d2573802106bc3cd3b`. The old installed bundle emitted no warning because it does not understand V6 details, but it left the session byte-identical and therefore safely displayed only its older compatible projection.

Stage 3C append result: `appendIncrementalLifecycle()` is one synchronous append seam around the canonical projector. It captures session, exact origin leaf, and parent lifecycle head before asynchronous work; at commit it rejects session changes, any leaf movement, lifecycle-head advancement, or a candidate that the projector would not accept, then appends exactly one `hybrid-memory.lifecycle` V6 entry. It contains no model, threshold, telemetry, cooldown, trigger, or scheduler logic. The exact-leaf rule deliberately discards work if another turn arrives rather than risk cross-branch persistence.

Next Stage 3 step: add a pure deterministic processor plan that selects the next observation-entry window after the compatible frontier and returns either no work or one bounded fold input plus its target frontier. Only after that seam is green should one runtime trigger invoke the model and call the append seam.

### Stage 4 — Run reflection incrementally

Add one reflector coordinator and trigger using existing observer orchestration patterns where they fit. Add reflection backlog, plan, candidate rejection, timing, and cache-prefix telemetry. Do not add a generalized queue or scheduler.

### Stage 5 — Remove reflection inference from compaction

Compaction uses the latest durable reflection projection and performs no reflector completion. Abort returns immediately. Reflection backlog is reported but does not block compaction.

### Stage 6 — Enforce the bounded main-session projection

Replace overflow-permitted rendering with a deterministic hard-ceiling planner. Verify required facts, correction/chronology preservation, no redundant reflection/support rendering, bounded 300/600/900 growth, and exact recall for omitted evidence.

### Stage 7 — Controlled rollout

Run deterministic and model-assisted isolated gates, then back up and install. Verify restart replay, fork behavior, exact recall, bounded reflection calls, zero-call covered compaction, hard summary ceiling, cache telemetry, and rollback behavior.

## 7. Explicitly rejected scope

- semantic retirement or model-authorized observation deletion;
- vector search, embeddings, or a persisted retrieval index;
- a separate reflection database or cursor file;
- a generalized background job framework;
- provider-specific routing changes;
- blocking compaction until reflection backlog drains;
- hardcoding one model's context window as a default;
- treating all high/critical observations as permanently prompt-resident;
- weakening provenance validation by guessing or dropping unsupported evidence;
- adding configuration before a measured user need exists.

## 8. Rollback

Each stage is independently reversible. Stage 1 changes no durable schema. Stage 3 must remain fail-closed under the previously installed bundle: unknown custom lifecycle entries are ignored rather than mutating observation evidence, while the new bundle continues to replay V3–V5. Before controlled rollout, back up the installed bundle and target session JSONL. Rolling back may show an older reflection projection but must not remove immutable observations or source provenance.

## 9. Definition of done

- Covered `/compact` makes zero extension model calls and completes with local-work latency.
- Reflection input and output stay bounded independently of total active observations.
- Invalid candidates cannot discard unrelated valid candidates.
- Persisted reflection provenance uses only canonical known observation IDs.
- Reflection failure and backlog never block compaction.
- Main summary never exceeds `maxSummaryTokens`.
- Required critical, correction, decision, constraint, chronology, and unresolved-work fixtures remain available in projection or through explicit exact recall.
- Replay is deterministic across restart and branch forks.
- Journal growth remains approximately linear without memory snapshots or side storage.
- Cache prefixes are deterministic and cache misses do not affect correctness.
