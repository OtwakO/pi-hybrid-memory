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
