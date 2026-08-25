# Pi-Native Alignment Roadmap

Date: 2026-08-26
Status: Active
Target host: `@earendil-works/pi-*` 0.84.3

## Objective

Align pi-hybrid-memory with Pi's current public extension APIs wherever Pi already owns the behavior, while preserving the extension-owned memory semantics that Pi does not provide.

The work must improve correctness and maintainability without weakening:

- durable observation evidence;
- observation provenance and branch-authoritative coverage;
- retention-safe folding;
- chronology, corrections, decisions, rationale, identifiers, paths, and error text;
- bounded observer epochs and their exact transcript-prefix cache behavior;
- fail-closed compaction catch-up;
- recall contracts and existing session compatibility.

Reflection quality and memory integrity remain higher priority than cache metrics or raw provider cost.

## Reflection and Observation Inference Shapes

Observation and reflection intentionally use different control flows.

### Observation

Observation is iterative over an append-only source epoch. The model may need multiple `record_observations` submissions while working through a chunk, and the exact assistant/tool transcript suffix becomes part of the next cacheable observer prefix.

The observer therefore needs a bounded multi-turn tool protocol. The current transport is not acceptable long-term because it calls low-level `agentLoop(..., streamSimple)` through `@earendil-works/pi-ai/compat`. The replacement should keep the bounded loop semantics while routing each model turn through Pi's session-owned model runtime.

### Reflection

Reflection is a bounded fold over one fixed, complete evidence set. It does **not** need a general agent loop.

The intended protocol is:

1. One `ctx.modelRegistry.complete()` request through Pi's native extension boundary.
2. Local validation of the sole `submit_reflections` result.
3. At most one explicit corrective request if a future policy approves it.
4. Exact retention of the pre-fold memory set on timeout, truncation, malformed output, missing tool use, invalid provenance, or retry failure.

An open-ended reflection loop would add termination, hanging, cost, and mutable-transcript complexity without matching the domain problem. If one request proves insufficient, extend the bounded protocol rather than introducing a general-purpose agent loop.

## Confirmed Findings

### P0 — Correctness and trust boundaries

1. **Observer transport bypasses Pi's session model runtime.**
   - Current path: low-level `agentLoop` plus `@earendil-works/pi-ai/compat::streamSimple` and manually resolved credentials.
   - Risk: drift from Pi-owned routing, provider composition, OAuth refresh, hooks, monitoring, timeout/retry behavior, and future provider changes.

2. **Proactive observer work is insufficiently lifecycle-bound.**
   - Detached work does not consistently use `ctx.signal`, a pre-run branch/session fence, or `session_shutdown` cancellation.
   - Risk: stale work may continue across navigation, reload, or shutdown and attempt to mutate runtime state or persist against the wrong branch.

3. **Project-local config is read without `ctx.isProjectTrusted()`.**
   - Risk: an untrusted repository can select an expensive model or aggressive thresholds and budgets.

4. **Malformed or unreadable global config can be silently overwritten.**
   - `readJson()` collapses missing, malformed, and unreadable files to `null`; loading then writes defaults over the file.
   - Risk: destructive loss of user configuration and diagnostic evidence.

5. **Word-count token estimation is unsafe for unbroken text.**
   - Minified code, JSON, stack traces, paths, base64, and CJK can be underestimated by orders of magnitude.
   - Risk: oversized observer chunks bypass segmentation and reflection/summary capacity decisions become inaccurate.

### P1 — Current-Pi cleanup

6. Remove the obsolete local `agent_settled` compatibility interface and register the typed Pi 0.84.3 event directly.
7. Derive `Runtime` defaults from the canonical config defaults rather than duplicating every value.
8. Use Pi's provider-portable `StringEnum` helper for observer relevance values.
9. Remove unnecessary `any` casts where current Pi types already describe the interface, including `hm_recall` parameters.
10. Fix `/hm-memory` wrapped-line caching: its key currently uses only text length and width, so different same-length strings can reuse incorrect rendered lines.

### P2 — Design before migration

11. **VCC compaction input duplicates part of Pi's cut-point and message conversion logic.**
    - Pi already provides `messagesToSummarize`, `turnPrefixMessages`, `previousSummary`, and `fileOps`.
    - Current raw-branch reconstruction may intentionally include retained current state, so it must not be replaced mechanically.

12. **The percentage auto-compaction trigger supplements Pi's built-in policy.**
    - It is an intentional product policy and uses canonical APIs.
    - Keep it unless production evidence supports removing it; document that it adds an earlier trigger rather than disabling Pi's safety trigger.

13. **The memory overlay directly manages terminal mouse mode.**
    - The overlay itself is Pi-native.
    - Defer broader UI replacement; remove raw terminal control only when keyboard-only behavior is acceptable or Pi exposes a public mouse-capture abstraction.

## Extension-Owned Behavior to Preserve

The following have no equivalent Pi host capability and remain justified:

- custom observation and coverage entries via `pi.appendEntry()`;
- branch-authoritative memory reconstruction and stale-work fences;
- segmented oversized-source progress;
- observer epochs and transactional transcript commits;
- provenance validation;
- retention-safe reflection folding;
- summary projection and durable-memory separation;
- VCC domain extraction and structural summary grammar;
- source-addressed recall and bounded previews;
- session-local memory lifecycle and cache telemetry;
- operation-scoped cache identities.

## Implementation Milestones

### Milestone A — Low-risk native alignment — Completed

Scope:

- typed `agent_settled` registration;
- single source of runtime defaults;
- `StringEnum` relevance schema;
- schema-inferred `hm_recall` parameters;
- correct memory wrap-cache identity.

Done when:

- focused auto-compaction, observer, recall, and memory tests pass;
- TypeScript passes without introducing casts;
- production behavior and persistence formats are unchanged;
- changes are committed separately from prior reflection work.

### Milestone B — Configuration safety — Completed

Scope:

- one declarative TypeBox schema for all settings;
- distinguish missing, malformed, and unreadable config files;
- never overwrite malformed or unreadable input;
- validate every setting and report actionable diagnostics;
- honor project config only when `ctx.isProjectTrusted()` is true;
- preserve sparse project-over-global merging for trusted projects.

Done when regressions cover missing-file scaffolding, malformed JSON preservation, unreadable-file fallback, invalid fields, trusted overrides, and ignored untrusted overrides.

### Milestone C — Conservative token accounting — Next

Scope:

- use Pi's exported token estimator for Pi messages;
- use Pi-aligned conservative character accounting for extension strings;
- re-baseline observer threshold, chunking, segmentation, epoch capacity, reflection capacity, summary budgeting, and telemetry.

Required cases:

- ordinary prose;
- minified code;
- large JSON;
- CJK;
- long paths and stack traces;
- one very long unbroken string.

Done when no configured source budget can be bypassed through whitespace-poor input and old persistence remains readable.

### Milestone D — Observer lifecycle safety

Scope:

- propagate the active `AbortSignal`;
- capture and validate branch/session identity around detached work;
- cancel session-owned observation on `session_shutdown`;
- ensure abort, navigation, reload, and persistence failure leave durable coverage and epoch state unchanged.

This milestone may be combined with Milestone E only if separating them would duplicate transaction work.

### Milestone E — Pi-native observer inference

Scope:

- remove `@earendil-works/pi-ai/compat` from observer inference;
- retain a bounded extension-owned multi-turn observation protocol;
- route every model turn through the session `ModelRegistry`/`ModelRuntime` boundary;
- execute `record_observations` locally;
- preserve exact validated assistant/tool transcript suffixes for observer epochs;
- define explicit turn, deadline, abort, malformed-output, and provider-failure outcomes.

Done when focused integration tests prove:

- multi-tool continuation;
- corrected provenance behavior;
- exact cache-prefix continuity;
- OAuth/header-only auth through Pi;
- provider hooks and monitoring remain active;
- timeout and cancellation terminate cleanly;
- failure never advances durable coverage or epoch state.

### Milestone F — VCC input policy

Before editing code, decide explicitly which inputs own:

- removed historical conversation;
- retained current working state;
- prior structural summary;
- authoritative file operations.

Prefer Pi-prepared messages for Pi-owned cut-point semantics and an explicit bounded retained-tail input for current-state enrichment. Do not silently change summary meaning.

### Deferred

- broader `/hm-memory` UI rewrite;
- removal of the percentage auto-compaction policy;
- packaging/build-tool changes;
- further cache-prefix optimization;
- observation retirement.

## Verification and Commit Discipline

Each milestone is an isolated commit and rollback point.

For every milestone:

1. Add focused regression tests first when behavior changes.
2. Run affected tests before wider verification.
3. Run `tsc --noEmit` and `git diff --check`.
4. Run the full suite and production build only at milestone completion or when shared boundaries changed.
5. Inspect the final diff for unrelated cleanup, dead code, stale comments, and remaining compatibility remnants.
6. Update `PLAN.md` when the current milestone or architectural state changes.
7. Add `DEVELOPMENT.md` entries only for non-obvious decisions or failure modes worth retaining.
