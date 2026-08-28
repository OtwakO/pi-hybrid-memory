# Incremental Reflection and Bounded Projection Roadmap

**Status:** Approved direction; Stage 1A bounded context planner evaluated

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

Remaining Stage 1 work: wire local handles into the small output contract, add one correction limit, per-candidate validation, and content-free stage/rejection telemetry.

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

Introduce the smallest schema and projector change needed for independent reflection events. Validate parent sequencing, frontier monotonicity, branch/fork/restart replay, stale append rejection, atomic malformed-event rejection, V3–V5 compatibility, and approximately linear journal growth.

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
