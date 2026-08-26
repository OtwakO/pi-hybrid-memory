### [2026-06-27] Recall rejected generated memory IDs
- **Context**: `hm_recall` sometimes returned `invalid_id` for IDs displayed in hybrid-memory context, while users also saw unrelated 8-character Pi entry IDs in recalled source evidence.
- **Change**: Updated the shared memory-handle contract from 12 lowercase hexadecimal characters (`^[a-f0-9]{12}$`) to 12 lowercase alphanumeric/base-36 characters (`^[a-z0-9]{12}$`). The tool schema now reuses `MEMORY_ID_PATTERN.source`, and invalid 8-character hexadecimal input explains that it is a Pi source-entry ID rather than a recall handle.
- **Reason**: This project generates observation/reflection IDs with a base-36 timestamp suffix plus a base-36 counter, producing valid IDs such as `mr6pp8nr000a`. The port retained upstream's hex-only validator even though upstream generates deterministic SHA-256 hex IDs. Runtime generation and validation had diverged.
- **Verified**: Added tool-level regression tests for base-36 observation IDs, base-36 reflection IDs, upstream-compatible 12-character hex IDs, and rejection of 8-character Pi source IDs. TypeScript compiles clean; 52/52 tests pass; Bun bundle succeeds.
- **Watch out**: Do not make Pi's 8-character source-entry IDs recall handles implicitly; they are a separate namespace and may collide semantically. If source-entry recall is desired later, add an explicit mode or separate tool contract.

### [2026-08-08] Recall exposes bounded source logs
- **Context**: Recalled observations listed source IDs, roles, and timestamps but omitted the original session text, limiting provenance to metadata.
- **Change**: `hm_recall` now includes original textual source excerpts, capped at 2,000 characters per source and 16,000 characters overall. Every source retains metadata; omitted and truncated content is marked explicitly. The tool description and result add a concise hint that Sources can verify exact wording, paths, errors, and decisions.
- **Reason**: Source text makes compacted memories actionable while output bounds prevent a heavily sourced observation from flooding the model context.
- **Verified**: Tool-level tests cover user/assistant messages, custom messages, branch summaries, per-source truncation, total-budget omission, structured details, AI-facing guidance, and Pi's custom `renderResult` TUI path. A follow-up fixed that renderer after it was found to show metadata only while the LLM-facing result already contained excerpts. TypeScript compiles clean; Bun bundle succeeds.

### [2026-08-08] Recall supports direct source lookup and fair previews
- **Context**: Observation recall allocated its source-text budget chronologically, so early entries consumed the budget and later entries—potentially the relevant evidence—showed no content.
- **Change**: Twelve-character IDs continue to recall observations/reflections. Eight-character lowercase hex IDs now retrieve the corresponding source entry from the current branch. Memory recall previews are capped at 1,200 characters each and 8,000 characters total, allocated by fair share so every textual source receives a preview when the budget permits. Direct source lookup has a separate 20,000-character safety cap.
- **Reason**: Sources are chronological rather than relevance-ranked. Equal allocation avoids order bias, while direct lookup provides the exact entry behind any preview without filesystem searching.
- **Verified**: Tests cover both ID namespaces, source-not-available behavior, even early/late allocation, redistribution after short entries, preview and direct-lookup caps, tool schema/guidance, LLM output, and TUI rendering. TypeScript compiles clean; 61/61 tests pass; Bun bundle succeeds.

### [2026-08-08] Hybrid memory owns proactive compaction thresholds
- **Context**: `compactionThresholdTokens` existed in config but did not trigger compaction; Pi alone decided when `session_before_compact` fired.
- **Change**: After `agent_settled`, the extension uses Pi's `getContextUsage()` and `compact()` APIs to request compaction. `compactionThresholdPercentage` accepts a whole percentage from 1–99 and overrides the token threshold when valid. Otherwise, `compactionThresholdTokens` compares against current context tokens. Duplicate requests are suppressed until completion or error, and the trigger stays disabled when `overrideDefaultCompaction` is false.
- **Reason**: This provides model-relative thresholds while triggering only after the complete agent run, avoiding interruption between tool-call turns.
- **Verified**: Focused tests cover percentage validation and precedence, token fallback, exact boundary behavior, unavailable usage, disabled override, duplicate suppression, completion, and error recovery. TypeScript compiles clean; 71/71 tests pass; Bun bundle succeeds.
- **Watch out**: The active Pi runtime is 0.84.1, but the legacy `@mariozechner/pi-coding-agent` development package available to this project is 0.66.1 and lacks the newer `agent_settled` event type. The implementation isolates a typed compatibility interface in `auto-compaction.ts`; Pi 0.84+ is documented as required.

### [2026-08-13] Unified extension configuration
- **Context**: Extension-owned settings were split between `pi-hybrid-memory-config.json` and Pi's `settings.json`, making discovery and maintenance harder.
- **Change**: All extension settings now live in one flat `pi-hybrid-memory-config.json`. The global file is auto-scaffolded and expanded with missing defaults; optional project files remain sparse field-by-field overrides. Upstream reviews now live under `docs/upstream-reviews/` with an index.
- **Reason**: There are no existing users requiring settings migration, so a direct single-source config is simpler and avoids permanent fallback complexity.
- **Verified**: Config tests cover scaffolding, preservation of existing values, sparse project precedence, and percentage normalization.

### [2026-08-13] Percentage compaction enabled by default
- **Change**: `compactionThresholdPercentage` now defaults to `80`; setting it to `null` opts into the absolute `compactionThresholdTokens` fallback. README now documents both `hm_recall` ID modes, fair bounded previews, exact source lookup, safety caps, and source availability behavior.
- **Verified**: Config scaffolding test locks the 80% default; full typecheck, tests, and bundle build completed with the change.

### [2026-08-13] Adopted upstream VCC accuracy fixes
- **Context**: The 2026-08-13 upstream review identified three low-risk VCC gaps that did not require persisted-schema changes.
- **Change**: File activity now recognizes modern tool names case-insensitively and incorporates Pi's authoritative `preparation.fileOps`; VCC input now includes normal messages, custom messages, and branch summaries; `bashExecution` messages normalize into existing bash tool-call/result blocks.
- **Reason**: Prevent silent omission of touched files, injected context, branch history, and direct shell executions from structural summaries while preserving hybrid summary and memory contracts.
- **Verified**: Added focused regression tests for modern tools, authoritative file operations, entry conversion, structured custom content, and nonzero `bashExecution`. TypeScript compiles clean; 79/79 tests pass; Bun bundle succeeds.

### [2026-08-13] Adopted upstream observer reliability fixes
- **Context**: Upstream review found that observer streams can fail without throwing, empty spans can be retried repeatedly, and unbounded/oversized source backlogs can stall coverage.
- **Change**: The observer now detects terminal error/abort messages while preserving partial tool results; backs off deliberate-empty full-tail results until enough new context arrives; serializes oldest-first bounded chunks with marked oversized-entry excerpts; processes the full compaction gap chunk by chunk before proceeding; and accepts either usable API keys or non-empty auth headers.
- **Reason**: Improve reliability without changing memory entries, IDs, prompts, summary grammar, or coverage semantics.
- **Verified**: Added observer, serializer, config, and integration-focused regressions. TypeScript compiles clean; 95/95 tests pass before the final safety-floor check; Bun bundle succeeds.

### [2026-08-13] Hardened memory prompts without changing contracts
- **Context**: The upstream review recommended preserving authoritative assertions and exact technical details while preventing transient task logs from becoming durable reflections.
- **Change**: Strengthened observer and reflector instructions for fact granularity, supersession, completion tracking, detail fidelity, relevance restraint, durable-value gating, and honest support ids. Stable observer task instructions now precede changing memory/chunk data for better provider prompt-prefix reuse.
- **Reason**: Improve future memory quality while keeping every persisted schema, id, compaction boundary, pruning rule, and recall contract compatible.
- **Verified**: Prompt contract tests cover the new rules, stable-before-dynamic ordering, and unchanged response schemas.

### [2026-08-13] Failed observer streams no longer commit partial coverage
- **Context**: Terminal observer errors could occur after one or more observation tool calls, but those partial records did not prove that the rest of the bounded source chunk had been examined.
- **Change**: Any terminal `error` or `aborted` assistant event now makes the whole observer run fail, regardless of partial records. Proactive observation retries later and compaction catch-up remains fail-closed.
- **Reason**: Advancing the chunk boundary after an interrupted run could permanently skip unexamined source entries.
- **Verified**: Regression test records an observation and then emits a terminal error; `runObserver` must return failure. All observer tests and typecheck pass.

### [2026-08-13] Added session-local cache and cost telemetry
- **Context**: Hybrid memory's observer, reflector, and pruner usage was invisible, so cache-hit rates and cost optimizations could not be evaluated safely.
- **Change**: Added `/hm-cache-info` with whole-session per-operation aggregates and a 10-call recent window. It records response input/output/cache-read/cache-write tokens, outcomes, provider-reported costs, and separate estimates from Pi model pricing.
- **Reason**: Establish a measurable baseline before changing cache identities, timestamps, memory windows, or compaction policy.
- **Verified**: Collector, reset, formatting, observer integration, reflector integration, and failed-pruner integration have focused tests. No prompts, memory content, credentials, or telemetry files are stored.

### [2026-08-13] Added operation-scoped prompt-cache routing
- **Context**: Telemetry showed each observer run began cold while its immediate tool-call continuation reused 94–98% of input; cold first calls accounted for most observer cost.
- **Change**: Observer, reflector, and pruner calls now use stable cache identities scoped to the Pi session and operation, and request long retention. Direct OpenAI/Anthropic and Mistral can map these options to prompt-cache retention or affinity; unsupported providers ignore them.
- **Reason**: Maximize extension-controlled cross-run cache reuse without reducing prior-memory context or changing memory semantics.
- **Verified**: Focused tests assert identity isolation, long retention, and propagation through both `agentLoop` and `completeSimple`; `/hm-cache-info` remains the measurement surface.

### [2026-08-13] Prioritized durable memory over stale context under the summary ceiling
- **Context**: The old merge loop trimmed observations from low through critical while leaving stale VCC transcript untouched, and could still exceed `maxSummaryTokens`. Historical VCC briefs also accumulated across compactions.
- **Change**: Added structured priority budgeting that trims oldest transcript, low/medium observations, volatile VCC lines, and high observations before protected reflections, critical observations, the original session goal, or unfamiliar future structural sections. Protected-only overflow is reported explicitly. Historical briefs now use a fresh-favored rolling line window; `maxFiles` is a total budget honored across fresh and merged VCC state; later catch-up chunks see earlier accumulated observations.
- **Reason**: Improve information-per-token and attention quality without sacrificing load-bearing semantic memory merely to satisfy a numeric ceiling.
- **Verified**: Focused tests cover trim order, critical retention, protected overflow, rolling brief history, unknown-section preservation, file-budget continuity, and no-trim behavior.

### [2026-08-21] Replaced observer snapshots with bounded append-only epochs
- **Context**: Telemetry showed every new observer run was cold while only the immediate tool continuation reused 96–98% of the prefix. Reinjecting the full growing memory snapshot in one changed user message prevented provider-independent cross-run reuse.
- **Change**: Added a runtime-only `ObserverEpochManager` with an immutable deterministic baseline, append-only source/model/tool transcript, transactional prepare/commit, coverage and compatibility fences, model-relative capacity rollover, forked atomic compaction catch-up drafts, and cold/warm prefix telemetry. Durable Pi branch entries remain authoritative.
- **Reason**: Preserve full reflections, observations, chronology, provenance, and fail-closed coverage while making each committed observer request an exact structured-message prefix of the next request.
- **Verified**: Tests cover exact prefix reuse, abandoned and stale transactions, coverage/model resets, capacity rollover, explicit reset reasons, fork isolation, terminal failure rollback, and telemetry/config behavior.

### [2026-08-25] Made compaction catch-up branch-authoritative
- **Context**: Independent review found that catch-up could compare an active observer epoch's coverage ID with itself, allowing stale cross-branch context reuse.
- **Change**: Proactive observation and catch-up now share a durable `coversUpToId` branch anchor; catch-up fences session/leaf identity before persistence, invalidates the live epoch after writing durable catch-up observations, and yields fully to Pi when compaction override is disabled.
- **Reason**: Cache reuse is valid only when branch continuity is independently proven. A safe cold reset is preferable to reusing stale memory context.
- **Verified**: Focused branch, compaction-safety, and compaction-hook integration tests cover empty coverage markers, cross-branch cold reset, navigation cancellation, post-persistence assembly failure, and the override off-switch.

### [2026-08-25] Added whole-session observer continuity telemetry
- **Context**: The ten-call recent ring could not show whether cold resets or provider misses were recurring over a long session.
- **Change**: `/hm-cache-info` now aggregates proactive versus catch-up calls, cold/warm epochs, reset reasons, warm provider hits/misses, and minimum capacity headroom. Both observer paths share one conservative fixed-token reservation.
- **Reason**: Cache tuning needs provider-independent continuity evidence without storing prompts or memory content.
- **Verified**: Focused telemetry, observer, compaction telemetry, and catch-up safety tests pass with clean TypeScript.

### [2026-08-25] Made reflection and pruning outcomes observable
- **Context**: Empty reflections could mean below-threshold, deliberate-empty output, malformed output, provider failure, or rejected proposals, but persisted memory alone could not distinguish them.
- **Change**: Session-local telemetry now records reflector/pruner lifecycle outcomes and aggregate input/proposed/accepted counts while preserving existing memory returns and fallbacks.
- **Reason**: Reflection policy and compaction cache work should be tuned from evidence without retaining prompts or memory text.
- **Verified**: Focused cache telemetry, compaction telemetry, pipeline, and compaction safety tests pass with clean TypeScript.

### [2026-08-25] Added precise observation provenance
- **Context**: Every observation previously cited every source in its chunk, making recall evidence broad and sometimes unrelated.
- **Change**: The observer tool now accepts an optional validated non-empty subset of current source IDs per observation; omitted subsets retain the legacy all-chunk behavior. Prompt and tool compatibility versions were advanced.
- **Reason**: Better provenance improves recall and future reflection/pruning decisions without reducing source context or rejecting older sessions.
- **Verified**: Focused observer, prompt-contract, recall, and TypeScript checks pass, including subset deduplication and rejection of out-of-chunk sources.

### [2026-08-25] Replaced oversized head/tail coverage with durable segments
- **Context**: A single source larger than the observer budget was represented by head/tail text and then marked fully covered, so facts in the omitted middle could be missed.
- **Change**: Observation entries can now carry optional `sourceProgress`; oversized sources are observed as contiguous resumable segments and full `coversUpToId` advances only after the final segment.
- **Reason**: Preserve semantic coverage without reducing observer input quality or breaking existing session entries.
- **Verified**: Focused serializer, durable-resume, branch, observer, epoch compatibility, and compaction catch-up tests pass with clean TypeScript.

### [2026-08-25] Added explicit observer baseline-pressure measurement
- **Context**: A growing durable baseline can leave too little room for meaningful new source input and eventually block compaction catch-up.
- **Change**: Both observer paths measure fresh baseline occupancy against a 256-token minimum useful delta; proactive observation skips without advancing coverage, catch-up cancels fail-closed, and `/hm-cache-info` aggregates pressure events and minimum fresh-delta capacity.
- **Reason**: Gather evidence before introducing any reflection/pruning lifecycle change or reducing memory quality.
- **Verified**: Focused epoch, telemetry, observer, and catch-up safety tests pass with clean TypeScript.

### [2026-08-25] Made observer provenance correction recoverable
- **Context**: A cache-stable observer epoch can expose earlier source IDs to the model, which may cite one outside the current delta and trigger a provenance warning.
- **Change**: Every delta now lists its exact valid source IDs, the observer tool compatibility version was bumped, and a later valid tool call clears a prior invalid provenance attempt while an uncorrected final invalid attempt still fails closed.
- **Reason**: Preserve strict provenance without discarding a fully corrected observer run or repeatedly retrying an otherwise valid source chunk.
- **Verified**: Focused provenance, epoch-compatibility, compaction catch-up, and segmented-source tests pass with clean TypeScript.

### [2026-08-25] Reprioritized roadmap around fold correctness and compaction effectiveness
- **Context**: Production telemetry from a 253,316-token compaction showed healthy observer caching but invalid reflector/pruner outputs (40,990 and 68,229 output tokens), zero accepted reflections, and all 828 observations retained.
- **Change**: Added `docs/COMPACTION_QUALITY_ROADMAP_2026-08-25.md`, pausing cache-prefix experiments until constrained fold output, explicit safe retirement, durable recallable evidence, and main-context effectiveness are designed and verified.
- **Reason**: The current keep-list pruner can over-delete on a parseable incomplete result, reflection citation does not prove full absorption, and summary budgeting currently couples model-visible projection to durable memory retention.
- **Watch out**: Do not approve observation retirement or a new details schema without the roadmap's explicit decision gate. Until the immediate safety patch lands, avoid reflection-eligible manual compaction on valuable sessions.

### [2026-08-25] Verified fold-roadmap findings before implementation
- **Context**: The quality-first roadmap was challenged against repository HEAD, the active Pi 0.84.3 host contracts, and the captured NovelReader session before any fold-policy implementation.
- **Change**: Added a verdict table separating confirmed defects/gaps from unproven hypotheses and ordered Q0 by immediate memory-loss risk. Corrected the recall claim: the inspected 659 observations remain recoverable from custom entries, while compaction-only evidence and reflection-support traversal remain compatibility gaps.
- **Reason**: Ensure implementation work addresses reproduced or source-proven problems without turning hypotheses into mandatory architecture.
- **Verified**: Source traces confirm destructive keep-list/fallback behavior, unsupported reflection IDs, missing final fold fence, summary-budget state coupling, and split Pi/custom-entry persistence boundaries; active host docs confirm compaction acknowledgment and constrained-tool capabilities.

### [2026-08-26] Established a retention-first memory-fold seam
- **Context**: Q0 had to remove destructive omission-sensitive pruning without leaving scattered fallback guards in the compaction hook.
- **Change**: Added `foldMemory()` as the semantic fold interface, made reflector outcomes explicit, rejected truncation and unsupported provenance, removed the production pruner contract, added final branch/session fencing (including observer-wait transition validation), and separated visible summary trimming from durable `MemoryDetailsV4` observations.
- **Reason**: Reflection may enrich memory, but observation retirement must be owned by one future auditable contract. Until then, uncertainty or model failure retains the complete active observation set.
- **Verified**: Focused fold, reflector, cache telemetry, prompt, merge-budget, and compaction-safety tests plus TypeScript passed before the full checkpoint.
- **Watch out**: This safety milestone intentionally improves memory integrity before compaction effectiveness; protected durable observation pools can still remain large until Q1-Q4 introduce validated folding and retirement.

### [2026-08-26] Replaced free-form reflection output with a constrained fold adapter
- **Context**: The previous reflector accepted provider prose and heuristically extracted JSON, allowing huge invalid outputs and making contract completion ambiguous.
- **Change**: Split reflection folding into policy, provider adapter, capacity planner, and semantic validator modules. The adapter uses a bounded `submit_reflections` TypeBox tool with preferred JSON-schema constrained sampling, medium reasoning, and one in-loop correction opportunity; the planner fails before provider work when full evidence plus a useful contract cannot fit.
- **Reason**: Keep complete evidence and memory quality while making completion, provenance, truncation, and capacity failure explicit and testable behind one fold interface.
- **Verified**: Focused tests cover constrained tool options, missing tool calls, truncation, explicit empty output, infeasible requests, unsupported/duplicate provenance, strengthening, non-mutation, lifecycle telemetry, and hook integration.
- **Watch out**: Observation retirement remains intentionally disabled. The current proposal cap bounds only new reflection output from model/summary capacity; it does not discard input evidence.

### [2026-08-26] Migrated the development baseline to current Pi packages
- **Context**: The active Pi runtime was `@earendil-works/*` 0.84.3, while the repository still compiled against legacy `@mariozechner/*` 0.66.1 aliases. This hid current interfaces behind compatibility casts and let tests validate contracts different from production.
- **Change**: Source, tests, peer dependencies, dev dependencies, and build externals now use `@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`, and `pi-tui` 0.84.3 directly. Current tool generics, terminating results, and `shouldStopAfterTurn` types replace legacy `any` shims. Existing low-level observer and reflector behavior is preserved through the current package's explicit `@earendil-works/pi-ai/compat` stream entry point.
- **Reason**: Further fold architecture must be based on the same current contracts used by the installed host, not obsolete aliases. Keeping the compatibility stream imports explicit also identifies the exact seams to remove or reassess in later milestones.
- **Verified**: TypeScript compiles cleanly against exact 0.84.3 packages, all 21 test files pass, and the Bun production bundle succeeds with only current Pi package externals.
- **Watch out**: The reflection transport bug is intentionally not fixed in this migration. The next milestone should replace the reflector's low-level loop with `ctx.modelRegistry.complete()`; do not add another compatibility shim around it.

### [2026-08-26] Routed reflection through the session model runtime
- **Context**: The first constrained reflector still used a nested low-level `agentLoop`, which could hang without a visible provider request and did not reliably use Pi's session-owned request boundary.
- **Change**: Replaced that loop with one `ctx.modelRegistry.complete()` request behind a typed `openai-completions` adapter, required the named `submit_reflections` tool, selected high reasoning, disabled provider retries, added a five-minute caller deadline, and capped the total carried reflection set at 50% of `maxSummaryTokens`. Unsupported APIs fail before dispatch.
- **Reason**: Use current Pi routing, auth, hooks, monitoring, retry/timeout policy, and cancellation while keeping provider options type-safe and preventing transitional reflections from adding an unbounded protected summary section.
- **Verified**: Focused reflection budget, adapter, fold, compaction-hook, and telemetry suites pass together (39 tests); all 183 repository tests across 21 files pass, TypeScript is clean, and the 34-module production bundle builds successfully. Changed-scope diagnostics, cycles, dead code, and unused-export checks are clean. The installed bundle matches the build byte-for-byte at SHA-256 `492af28128a713c81489f44ac45ca908f356daff132ebb64a8226e350e63e327`.
- **Watch out**: A provider that ignores `AbortSignal` may continue remote work after the extension's deadline even though compaction stops waiting safely. Additional API support requires a separate typed and tested adapter; observation retirement remains disabled.

### [2026-08-26] Removed the reflection API-family adapter
- **Context**: The first ModelRegistry-based reflector still forced an OpenAI-native tool choice and reasoning option, unnecessarily restricting reflection to `openai-completions`.
- **Change**: Kept the canonical `ctx.modelRegistry.complete()` extension boundary but now supplies only Pi's provider-neutral tool schema and universal stream options. The prompt directs the model to call the sole `submit_reflections` tool; local validation rejects missing, extra, malformed, or unsupported results. The capacity planner's hidden-output allowance is named as a provider-output reserve rather than claiming control of reasoning.
- **Reason**: Pi should own provider selection, schema translation, authentication, routing, hooks, and inference behavior. Hybrid-memory should not duplicate or guess provider-specific tool-choice and reasoning mappings.
- **Verified**: TypeScript passes and 39 focused reflection/fold/compaction/telemetry tests pass together, including a non-OpenAI API model through the same completion seam. All 183 repository tests across 21 files pass, the 34-module production bundle builds successfully, and changed-scope diagnostics/cycles/dead-code/unused-export/duplication checks are clean. The installed bundle matches the build byte-for-byte at SHA-256 `95288ad4dd5d6d1a1baf4f66e591ef9c8e9863a96b24ae5cf0c5894533be8292`.
- **Watch out**: Tool use is prompt-directed rather than provider-forced. A model that returns prose instead is classified as `missing-tool-call`, and the complete pre-fold memory set is retained. Observation retirement remains disabled.

### [2026-08-26] Started staged Pi-native alignment
- **Context**: A current-Pi audit found one remaining compatibility inference seam plus smaller stale shims, unsafe config/token policies, and lifecycle gaps. Observation and reflection were also evaluated for whether they should share an agent-loop design.
- **Change**: Added `docs/PI_NATIVE_ALIGNMENT_ROADMAP_2026-08-26.md` and completed its low-risk first milestone: direct typed `agent_settled` registration, runtime defaults sourced from canonical config defaults, provider-portable `StringEnum` relevance values, schema-inferred recall parameters, and collision-free memory wrapping cache keys.
- **Reason**: Remove obsolete 0.66-era compatibility remnants before behavior-changing migrations. Observation remains an iterative bounded tool protocol; reflection remains a fixed-evidence `ModelRegistry.complete()` fold and should not use a general agent loop.
- **Verified**: Focused auto-compaction, observer, and recall tests pass; all 21 test files pass; TypeScript and whitespace checks are clean; the 34-module production bundle builds successfully.
- **Watch out**: Configuration trust/error handling, conservative token accounting, observer lifecycle fencing, observer transport migration, and VCC input policy are deliberately separate milestones. Do not combine them into cleanup commits.

### [2026-08-26] Made configuration loading trusted and non-destructive
- **Context**: The old loader treated missing, malformed, and unreadable JSON as the same empty config, then rewrote the global file with defaults. It also honored project-local overrides without Pi's trust gate and validated only a few settings.
- **Change**: Added one declarative TypeBox schema, field-local validation, explicit read outcomes, `CONFIG_DIR_NAME`, and required `ctx.isProjectTrusted()` decisions at every production config load. Only missing global config is scaffolded; malformed/unreadable files and files with invalid known fields are preserved, with rejected values falling back by precedence. Unknown fields remain untouched.
- **Reason**: Prevent silent configuration loss and untrusted repositories from changing provider cost or memory thresholds while keeping startup usable when one field is bad.
- **Verified**: Focused tests cover scaffolding, sparse merge, unknown-field preservation, trusted/untrusted project overrides, malformed and unreadable input, field-local fallback, and malformed project config. TypeScript and structural diagnostics are clean.
- **Watch out**: Runtime config is still loaded once per extension instance. Reload or session replacement is required after editing the file; lifecycle-state redesign belongs to the later observer milestone.

### [2026-08-26] Aligned memory token accounting with Pi
- **Context**: The inherited word-count estimator could classify a 100,000-character unbroken source as roughly two tokens, allowing minified code, JSON, paths, stack traces, base64, and CJK text to bypass observer chunk and capacity limits.
- **Change**: Real Pi messages now use Pi's exported `estimateTokens()` function; extension strings and custom entry bodies use the same conservative `ceil(chars / 4)` rule. Added regressions for 100,000 unbroken characters, CJK, and resumable segmentation of whitespace-poor oversized sources.
- **Reason**: Keep observer thresholds, source segmentation, epoch capacity, reflection feasibility, summary budgeting, and telemetry aligned with the host and fail safely under pathological text shapes.
- **Verified**: 188/188 tests pass; TypeScript and whitespace checks pass; structural analysis reports no dead code, unused exports, cycles, or duplicates.
- **Watch out**: Code-heavy or whitespace-poor sessions may reach thresholds earlier than before. Existing persisted tokenCount metadata remains readable but reflects the estimator used when it was written; new work uses the conservative estimator.

### [2026-08-26] Made proactive observation session and branch safe
- **Context**: Proactive observation launched detached from `turn_end` without composing `ctx.signal`, shutdown cancellation, or a final branch/session fence. A provider call could finish after session replacement or navigation and attempt stale persistence.
- **Change**: Added a deep `ObserverTaskCoordinator` module that owns exclusivity, composed cancellation, typed outcomes, originating session/branch ancestry checks, and a synchronous `commitSync` seam. Pi switch/fork/tree/shutdown events cancel work and invalidate the disposable epoch. Proactive persistence now performs final cancellation/ancestry validation, epoch transcript validation, durable append, and epoch commit without an intervening `await`. Runtime's old observer flags/promise launcher were removed.
- **Reason**: Concentrate lifecycle policy at one testable seam while allowing legitimate same-branch descendant growth and keeping observer transport independently replaceable.
- **Verified**: Focused lifecycle and compaction tests cover same-branch growth, branch navigation, session replacement, active-turn abort, lifecycle cancellation, racing starts, persistence failure, and exact epoch-prefix validation. The full suite passes 201/201; TypeScript and whitespace checks pass; structural analysis reports no dead code, unused exports, cycles, or duplicates.
- **Watch out**: Cancellation cannot force an underlying provider adapter to stop unless it honors the supplied signal, but stale results are still rejected before persistence. Milestone E must preserve this coordinator interface while replacing the observer's compatibility transport.

### [2026-08-26] Routed observation through Pi's native model runtime
- **Context**: Observation still used low-level `agentLoop(..., streamSimple)` from `pi-ai/compat`, forcing manual API-key/header resolution and bypassing Pi's session-owned provider runtime even after reflection had migrated.
- **Change**: Replaced the compatibility loop with a bounded native observation protocol inside `runObserver`. Every turn calls an injected `ctx.modelRegistry.complete()` adapter, executes `record_observations` locally, appends exact Pi-shaped assistant/tool-result messages, permits a later valid correction of rejected provenance, and returns the validated transcript suffix to the existing epoch transaction. Added one global deadline, an eight-turn cap, strict tool/schema/provenance checks, per-turn telemetry, and fail-closed handling for abort, timeout, truncation, provider failure, unsupported tools, and malformed termination. Runtime now selects models only; manual credential/auth-header resolution was removed.
- **Reason**: Let Pi own provider routing, OAuth refresh, hooks, monitoring, retries/timeouts, and translation while preserving the extension's domain-specific multi-turn observation behavior and append-only cache prefix.
- **Verified**: Native observer, proactive lifecycle, and compaction catch-up integration tests pass, including exact transcript continuity, correction semantics, provider failure modes, global bounds, cache options, and ModelRegistry reflection coexistence. The full suite passes 201/201; TypeScript and structural analysis are clean with no dead code, unused exports, cycles, or duplicates.
- **Watch out**: `OBSERVER_TOOL_VERSION` is now `record-observations-v4-native`; the first post-upgrade observer call is intentionally cold. This resets only disposable epoch warmth, not persisted observations, coverage, reflections, or recall data.

### [2026-08-26] Aligned VCC with Pi's compaction cut point
- **Context**: Hybrid compaction rebuilt VCC from branch entries since the prior compaction, using hand-written conversion for custom and branch-summary entries. This could reprocess retained messages, duplicate the live tail inside the new summary, and drift from Pi's split-turn and cut-point semantics.
- **Change**: Added `prepareVccCompactionInput()` as the sole VCC compaction-input seam. It converts Pi's `messagesToSummarize` plus `turnPrefixMessages` through `convertToLlm()`, extracts the prior VCC body through the exact structural-summary header, and exposes Pi's authoritative `fileOps` to the existing extractor. Removed whole-branch VCC reconstruction, the custom entry converter, the live-tail finder, and ad hoc prior-summary parsing from the compaction hook.
- **Reason**: The compacted structural state should be a deterministic fold of prior VCC state plus newly removed history. Pi already keeps the retained tail verbatim, so copying it into VCC wastes summary tokens, duplicates active context, and destabilizes the post-compaction cache prefix without improving memory quality.
- **Verified**: Focused module and hook tests prove removed-only input, split-turn inclusion, canonical custom/branch-summary conversion, authoritative file operations, exact prior-state extraction, and retained-tail exclusion. The full suite passes 206/206; TypeScript, production build, and structural diagnostics are clean.
- **Watch out**: Volatile outstanding context is derived from the newly removed delta. Active blockers in the retained tail remain directly visible to the main model and should not be duplicated into the structural summary.

### [2026-08-26] Audited the full memory and cache architecture
- **Context**: After Pi-native observer inference and cut-point-aligned VCC, the engine was reviewed for memory fidelity, context reduction, cache stability, patch layering, dead/remnant code, and module ownership before further optimization.
- **Findings**: Recent observer epoch, lifecycle fence, native inference, retention-safe fold, and VCC changes are sound foundations. Immediate defects remain in the stale observer JSON-vs-tool prompt contract, missing durable coverage for deliberate-empty compaction catch-up, process-wide rather than cwd/trust-scoped config caching, and a forward-unsafe `version >= 3` memory-details cast. The strategic blocker is safe convergence: observations cannot retire, reflections cannot supersede stale anchors, recall and live state use different readers, and compaction effectiveness is not measured end to end.
- **Reason**: Cache optimization before fixing semantic convergence would optimize repeated processing of an ever-growing memory set. The ordered roadmap now fixes protocol/scope correctness, unifies the branch memory read model, then designs additive retired evidence and reflection lifecycle before safe retirement and cache experiments.
- **Verified**: Audit baseline remained clean with 206/206 tests, TypeScript success, byte-identical installed/build bundles, no production dead code, no unused exports, and no import cycles. The attempted independent reviewer returned only a provider usage-limit error and made no changes; all accepted findings were verified directly against source.
- **Watch out**: Do not introduce a new memory-details version, reflection supersession, or observation retirement without the documented decision gate. Do not treat relevance or reflection citation alone as absorption proof.

### [2026-08-26] Closed immediate protocol and runtime-scope correctness gaps
- **Context**: The engine audit found four localized foundation defects that had to be repaired before a unified memory index or new persistence semantics.
- **Change**: Replaced the observer's stale JSON-only prompt with one authoritative `record_observations` tool contract, required at least one accepted submission per successful run, removed obsolete free-form prompt/schema exports, and bumped the prompt compatibility key. Compaction catch-up now writes one consolidated coverage entry even for a deliberate-empty gap. Runtime configuration is cached per canonical cwd/trust scope rather than per process, and session-local recovery/backoff state resets with session identity. Added `readMemoryDetails()` to validate and normalize only known V3/V4 details while rejecting malformed or future versions; persistence remains V4. Removed stale model casts and manual-auth test remnants.
- **Reason**: These were patch-layer remnants or ownership gaps that could silently lose observation quality, repeat catch-up work, apply the wrong project's settings, or misread future persisted schemas.
- **Verified**: Focused protocol, lifecycle, configuration, compaction, and compatibility tests pass; the full suite passes 214/214. TypeScript, production build, whitespace checks, and structural analysis are clean, with no dead production code, unused exports, or import cycles.
- **Watch out**: The prompt version bump intentionally cold-resets the disposable observer epoch once after reload. Existing observations, coverage, compaction details, and recall IDs are unchanged.

### [2026-08-26] Unified branch memory reads behind one index
- **Context**: Live memory, `/hm-memory`, status metrics, and `hm_recall` independently scanned custom observation entries and compaction details, producing inconsistent current-versus-historical semantics and incomplete reflection evidence traversal.
- **Change**: Added the pure `buildBranchMemoryIndex()` module. Its small interface exposes current committed/pending memory, compactions, memory-ID lookup, exact branch-entry lookup, observation provenance, and reflection-to-observation-to-source evidence traversal. Observer, compaction, status, metrics, `/hm-memory`, and recall now use the index; the old `getMemoryState()` and recall-specific scanners were removed. Historical compaction parsing remains lazy while current state is resolved eagerly.
- **Reason**: One authoritative read projection prevents future retired-evidence support from being interpreted differently by each caller and keeps recall history separate from the current compaction pool without introducing a repository layer or process cache.
- **Verified**: 47 focused index/recall tests and 69 caller-boundary tests pass, including compaction-only observation recall, reflection evidence traversal, latest-valid-memory snapshot anchoring, boundary recovery, exact source lookup, preview budgets, observer triggering, compaction safety, and telemetry. The full suite passes 224/224; TypeScript, production build, whitespace checks, and structural analysis are clean after removing the obsolete `SupportedMemoryDetails` alias.
- **Watch out**: `/hm-memory` now deliberately shows the canonical current pool rather than every historical custom observation entry. Historical evidence remains addressable through `hm_recall`. Persistence remains V4 and observation retirement remains disabled.

### [2026-08-26] Rejected repeated snapshots for a branch-local lifecycle journal
- **Context**: G3 needed a persisted active/retired and current/superseded model that improves context convergence without causing session JSONL files to accumulate repeated full memory archives.
- **Change**: Deep review against Pi 0.84.3 persistence, branch, fork, compaction, and context behavior replaced the earlier snapshot proposal with a branch-local journal design. Observation evidence remains in one-time custom entries; successful V5 compactions add only new immutable reflection revisions and lifecycle events; `buildBranchMemoryIndex()` replays the active branch into the current projection. Full active and retired observation arrays are not copied into V5 details. The design also introduces preservation obligations: a reflection cannot be superseded out of current context while it is the only current representation protecting retired observations.
- **Reason**: Pi already supplies an append-only branch event path and atomic compaction-details write. Repeating memory snapshots would waste disk, while a sidecar database or pre-compaction lifecycle ledger adds transaction and portability complexity. The journal makes extension-owned evidence storage approximately linear and keeps retired evidence out of provider context.
- **Verified**: Source review confirmed custom entries do not enter context, compaction details persist with the summary, failed compactions persist no lifecycle batch, branches exclude later events naturally, and forks copy the selected path. Retirement analysis confirmed citation is not absorption; deterministic exact duplicates are the only immediately locally provable retirement class. Full design and tests are specified in `docs/MEMORY_LIFECYCLE_DESIGN_2026-08-26.md`.
- **Watch out**: Pi still appends every compaction summary, so total session storage cannot be constant-sized. The extension can prevent cumulative evidence duplication and bound summary size, but cannot eliminate append-only raw history or repeated summary storage without a different host contract.

### [2026-08-27] Added retention-safe V5 memory journal foundation
- **Context**: Repeated V4 memory snapshots copied every observation and reflection into each compaction detail record, increasing disk growth and coupling projection assembly to persistence. The approved G3 Phase A required a journal reader/writer without enabling any observation retirement.
- **Change**: New compactions now persist strict V5 details containing only newly added immutable reflection revisions, an input fingerprint, and empty retirement/supersession arrays. `buildBranchMemoryIndex()` replays V3/V4 compatibility baselines, canonical custom observation evidence, and parent-linked V5 additions. Conflicting observation IDs, malformed V5 records, wrong-parent batches, duplicate reflection IDs, and unknown support IDs reject atomically while retaining the prior valid projection; `/hm-status` and `/hm-memory` surface the issues. Merge projection no longer owns persisted memory details, and existing reflection revisions are no longer mutated for support strengthening.
- **Reason**: Full snapshots caused cumulative durable-memory duplication. One-time journal records keep extension-owned evidence growth approximately linear while preserving branch/fork semantics and retention-safe failure behavior. Reflection strengthening is deferred until supersession can transfer preservation obligations safely.
- **Verified**: Focused schema, projector, fold, summary, compaction, telemetry, observer, and recall tests passed before the full milestone run. Independent safety review found and prompted fixes for pending observations across native compactions, immutable-ID conflicts, invisible malformed batches, incomplete fingerprints, and conflicting first V4 baselines.
- **Watch out**: Phase A intentionally does not reduce the active observation baseline; it improves persistence architecture and disk duplication only. Exact-duplicate retirement remains a separate decision gate, and the temporary 97,000-token observer epoch setting is still only a capacity workaround.

### [2026-08-27] Deferred semantic retirement after observer epoch saturation
- **Context**: In the long implementation session, proactive observation reached 108,898 estimated tokens against an effective 108,800-token epoch cap. The cap is `min(observerEpochMaxTokens, 40% of model contextWindow)`; with the 272,000-token observer model, increasing the config above 108,800 cannot create more capacity.
- **Change**: No runtime or memory-policy code was changed. The next-session order was frozen in `docs/NEXT_SESSION_HANDOFF_2026-08-27.md`: first capacity-aware contiguous source segmentation, then deterministic exact-duplicate retirement, preservation-safe reflection supersession, the 300/600/900 quality harness, validated semantic retirement only if justified, and finally effectiveness/cache refinement.
- **Reason**: Near-boundary segmentation can safely mitigate tiny overruns, but only validated semantic retirement can provide major long-term baseline convergence. Rushing semantic deletion because the current session is full would risk the memory fidelity and provenance guarantees established by the journal foundation.
- **Watch out**: Phase A improves disk duplication, not active baseline size. Do not raise the 40% cap, omit baseline evidence, or combine multiple lifecycle phases merely to keep this legacy session running.

### [2026-08-27] Made quality, token, cache, and simplicity goals explicit
- **Context**: The next-session roadmap spans capacity handling, persisted lifecycle, semantic retirement, context projection, and later cache tuning; optimizing any one dimension in isolation could undermine the others or produce an unnecessarily complex codebase.
- **Change**: The handoff now defines the ultimate target as maximum practical memory fidelity, minimum necessary active context, maximum quality-neutral prefix stability, and durable exact recall. It also makes Pi-native SDK use, deep cohesive modules, low coupling, high cohesion, simple reversible designs, no speculative abstraction, maintainability, risk-matched testing, and isolated milestones mandatory architectural constraints.
- **Reason**: Good memory quality reduces corrective token use; bounded information-dense context improves attention; deterministic prefixes improve cache reuse; and simple Pi-native implementations reduce defects and maintenance cost. These must be optimized together rather than traded away for a single metric.
