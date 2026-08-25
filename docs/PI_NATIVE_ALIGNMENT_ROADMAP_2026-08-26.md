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

### Milestone C — Conservative token accounting — Completed

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

### Milestone D — Observer lifecycle safety — Completed

Scope:

- propagate the active `AbortSignal`;
- capture and validate branch/session identity around detached work;
- cancel session-owned observation on `session_shutdown`;
- ensure abort, navigation, reload, and persistence failure leave durable coverage and epoch state unchanged.

Implemented independently from Milestone E through a deep `ObserverTaskCoordinator` module. Its small interface owns task exclusivity, turn/session cancellation, failure classification, originating session/branch ancestry fencing, and the final synchronous persistence-and-epoch commit seam. Same-branch descendant growth remains valid; navigation away from the originating branch path, session replacement, active-turn abort, shutdown, or persistence failure cannot advance durable coverage or epoch state.

The synchronous bootstrap boundary write remains outside the coordinator because it performs no `await`; Pi cannot interleave branch navigation between its branch read and append in the same JavaScript turn.

### Milestone E — Pi-native observer inference — Completed

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

Implemented as a bounded observation-protocol module behind the existing `runObserver` interface. Every turn now calls the active session's `ctx.modelRegistry.complete()` adapter; Pi owns model routing, credentials and OAuth refresh, provider hooks, request monitoring, timeout/retry plumbing, and provider translation. The module owns strict `record_observations` validation, current-chunk provenance, exact Pi-shaped assistant/tool-result transcript construction, correction of rejected submissions, global turn/deadline bounds, per-turn telemetry, and fail-closed outcomes.

Manual API-key/header resolution and the `pi-ai/compat`/`agentLoop` transport were removed. Runtime now selects only the configured or active model. The observer protocol compatibility key was bumped so the first post-upgrade observer run cold-resets rather than mixing legacy agent-loop and native-completion transcripts in one epoch.

### Milestone F — VCC input policy — Completed

Before editing code, decide explicitly which inputs own:

- removed historical conversation;
- retained current working state;
- prior structural summary;
- authoritative file operations.

Implemented through the pure `prepareVccCompactionInput()` module. Removed historical conversation comes only from Pi's `messagesToSummarize` plus split-turn `turnPrefixMessages`, converted through Pi's canonical `convertToLlm()`. Prior structural state is parsed from the exact hybrid VCC header, and Pi's `fileOps` seeds authoritative cumulative file activity while transcript tool calls enrich it.

The retained tail is intentionally excluded from VCC input because Pi keeps it verbatim after the compaction summary. Copying it into VCC would duplicate active context, consume summary tokens, and destabilize the post-compaction prefix without adding information. Volatile outstanding context therefore reflects the newly removed delta; active blockers in the retained tail remain directly visible. Whole-branch reconstruction, hand-written custom-message conversion, and ad hoc prior-summary parsing were removed from the compaction hook.

### Milestone G — Review remaining alignment scope — Completed

The source audit found the recent Pi-native routing, observer epoch transaction, branch fencing, retention-safe fold, and VCC cut-point work to be sound foundations rather than patch stacks. No production dead code, unused exports, or import cycles remain. The main remaining risks are semantic convergence and a small set of cross-session/protocol correctness gaps—not missing cache knobs.

#### Immediate correctness findings

1. **Observer prompt/transport contract drift — major.** `OBSERVER_SYSTEM` still instructs free-form JSON-only output, while `runObserver()` accepts only `record_observations` tool calls and treats a normal response with no tool call as successful termination. This is a remnant from the pre-native observer and can silently produce an empty verdict despite useful source content. Remove the obsolete JSON contract, make the tool protocol authoritative, and bump the observer prompt compatibility version.
2. **Empty compaction catch-up has no durable coverage marker — major.** Catch-up persists an observation entry only when `accumulatedRecords.length > 0`; a fully examined deliberate-empty gap proceeds to compaction without advancing branch-authoritative coverage. Persist one empty consolidated coverage entry after complete successful catch-up, under the same final branch fence, before compaction assembly.
3. **Runtime config is cached across project/session changes — major.** `Runtime.ensureConfig()` loads only once per extension process. Switching cwd or project trust can leave the prior project's model and thresholds active. Key loaded config by canonical cwd plus trust state, reload at session/project scope changes, and reset config-derived notices with that scope.
4. **Memory-details version guard is forward-unsafe — major before schema evolution.** `isSupportedMemoryDetails()` accepts any observational-memory version `>= 3` and casts it to V4 without shape validation. Replace it with explicit version readers/normalizers before introducing retired evidence or a new details version.

#### Strategic memory-quality findings

5. **Retention is safe but cannot converge — expected high-priority gap.** `foldMemory()` structurally returns `retiredObservationIds: []`; all observations remain in durable details. This prevents data loss but guarantees monotonic growth and recurring protected overflow. Continue Q2–Q6 of the compaction-quality roadmap: additive retired-evidence persistence, explicit absorption proof, reflection lifecycle, deterministic conservative retirement, and 300/600/900-item evaluation.
6. **Reflections accumulate without supersession lifecycle — major for long sessions.** Validation can add or strengthen exact-content duplicates but cannot replace or mark stale/conflicting reflections. Existing reflections consume the 50% reflection allocation first, so stale anchors can eventually block useful new synthesis. Define strengthening/supersession/current-projection semantics before claiming convergence.
7. **Recall has split state readers and incomplete evidence traversal — major before retirement.** Live memory reads committed observations from the latest compaction details, but `hm_recall` searches observations only in custom observation entries and reflections across all compactions without dedup/current-state semantics. It also does not traverse a reflection's supporting observation evidence. Introduce one branch memory index used by live state, UI, metrics, and recall before retiring any observation.
8. **Compaction effectiveness is not measured end to end — major observability gap.** Telemetry records extension LLM calls but not summary contribution, retained-tail estimate, protected-overflow composition, or post-compaction reduction. Add content-free compaction lifecycle metrics before tuning summary/cache behavior further.

#### Lower-priority cleanup

9. Share the duplicated abort/deadline race helper between observer and reflector only when touching those modules; it is real policy duplication but not urgent.
10. Remove test-only obsolete observer free-form prompt/schema exports with the prompt-contract fix.
11. Reset `boundaryRecoveryNotified` per session rather than per extension process.
12. Replace the two obsolete `resolved.model as any` casts after the current Pi model types are confirmed sufficient.
13. Keep the large `/hm-memory` TUI stable unless changed for the unified branch memory index; size alone is not a reason to rewrite it.

### Ordered next work

1. **G1 — Protocol and scope correctness — Completed.** The observer stable prompt now defines only the native `record_observations` tool protocol; stopping before an accepted submission fails closed, deliberate empty requires an explicit empty tool call, obsolete free-form prompt/schema exports were removed, and the compatibility key was bumped. Successful compaction catch-up always writes one consolidated coverage entry, including deliberate-empty gaps. Runtime configuration reloads when canonical cwd or trust scope changes, session-local recovery/backoff state resets with session identity, obsolete model casts were removed, and known V3/V4 memory details are shape-validated through an explicit reader while unknown future versions are rejected. Writes remain V4.
2. **G2 — Canonical branch memory index:** one read model for current observations, reflections, provenance, compaction details, UI, metrics, and recall. Preserve V4 compatibility and make future retired evidence discoverable.
3. **G3 — Additive retired-evidence persistence and reflection lifecycle design:** pause for approval on the new details version, supersession semantics, and recall scope.
4. **G4 — Safe convergence implementation:** validated absorption proof plus deterministic conservative retirement; no omission-sensitive keep-list model.
5. **G5 — Long-session quality/effectiveness evaluation:** required-fact, contradiction, chronology, recall, summary-size, retained-tail, and deterministic-rendering fixtures at 300/600/900 observations.
6. **G6 — Cache optimization after convergence:** measure reflection-prefix reuse and first-main-request cold transition; optimize only quality-neutral stable prefixes. Do not restructure evidence solely for cache percentage.

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
