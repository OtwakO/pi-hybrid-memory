# pi-hybrid-memory: Project Specification

## Overview

Build a single Pi coding agent extension called `pi-hybrid-memory` that merges the memory strategies of two existing extensions into one unified compaction hook:

- **pi-observational-memory** (`elpapi42/pi-observational-memory`) — semantic memory layer: LLM-powered observer that builds durable Reflections and timestamped, relevance-tiered Observations
- **pi-vcc** (`sting8k/pi-vcc`) — structural memory layer: algorithmic, zero-LLM extraction of session goal, file changes, commits, outstanding context, user preferences, and a brief rolling transcript

Neither extension can coexist because both register a `session_before_compact` hook and Pi only accepts one compaction summary. This project produces a single extension that runs both pipelines and merges their outputs into one richer summary under a single hook.

**Clone and analyze, build deep understanding of both repos before starting:**
```
clone to ./reference
https://github.com/elpapi42/pi-observational-memory
https://github.com/sting8k/pi-vcc
```

---

## Goals

1. Zero behavioral regression — everything either extension did individually must still work
2. Single `session_before_compact` hook — no hook races, no duplicate summaries
3. Additive value — the merged summary must be more useful than either alone, not just larger
4. Cost discipline — short sessions must remain zero LLM cost (same gate behavior as pi-observational-memory)
5. Controlled growth — the merged summary may be larger than either extension alone, but long-session compaction must materially reduce the main-model context. Durable evidence and the model-visible projection must not remain coupled: evidence may stay recallable without forcing every retired detail into the normal summary. See `docs/COMPACTION_QUALITY_ROADMAP_2026-08-25.md` for the staged design and decision gates.
6. `vcc_recall` lossless history recall must work unchanged — it reads raw JSONL and is hook-independent
7. All extension-owned config lives in one flat `pi-hybrid-memory-config.json` with global defaults and optional sparse project overrides
8. TypeScript throughout, compiled and tested against the active `@earendil-works` Pi 0.84.3 ecosystem rather than legacy package aliases
9. Prefer Pi's current public extension boundaries for provider inference, lifecycle, trust, token accounting, and prepared compaction inputs; keep only memory semantics Pi does not provide. Track the staged migration in `docs/PI_NATIVE_ALIGNMENT_ROADMAP_2026-08-26.md`.

---

## Repository Structure

```
pi-hybrid-memory/
├── src/
│   ├── index.ts                  # Extension entry point, hook registration
│   ├── config.ts                 # Unified config loading and defaults
│   ├── types.ts                  # Shared types across both pipelines
│   │
│   ├── vcc/                      # Ported from pi-vcc
│   │   ├── compaction-input.ts   # Pi-prepared removed delta, prior VCC, authoritative file ops
│   │   ├── summary.ts            # Exact structural-summary rendering/extraction contract
│   │   ├── normalizer.ts         # Raw Pi messages → uniform blocks
│   │   ├── extractor.ts          # Section extractors: goal, files, commits, preferences, blockers
│   │   ├── transcript.ts         # Brief transcript builder (rolling window, tool call collapsing)
│   │   ├── formatter.ts          # Render sections + transcript into bracketed format
│   │   ├── merger.ts             # Merge policy: sticky vs volatile vs union sections
│   │   └── recall.ts             # vcc_recall tool: raw JSONL search, expand, browse
│   │
│   ├── om/                       # Ported from pi-observational-memory
│   │   ├── observer.ts           # Async observer: chunk → LLM tag → relevance-tiered observations
│   │   ├── reflector.ts          # Crystallizes durable Reflections from observation pool
│   │   ├── pruner.ts             # Drops low-relevance observations when pool exceeds gate
│   │   ├── store.ts              # Pi tree storage: persist observations + reflections between turns
│   │   └── assembler.ts          # Mechanically concatenate reflections + observations into OM block
│   │
│   └── merge/
│       ├── pipeline.ts           # Orchestrates both pipelines, flushes pending state, merges outputs
│       ├── budget.ts             # Shared token budget: counts, enforces cap, trims by priority
│       └── format.ts             # Final merged summary formatter with section ordering
│
├── tests/
│   ├── vcc/                      # Unit tests for VCC pipeline (port from pi-vcc/tests)
│   ├── om/                       # Unit tests for OM pipeline
│   └── merge/                    # Integration tests for merged output, budget enforcement
│
├── package.json
├── tsconfig.json
└── README.md
```

---

## Pipeline Architecture

### Pi Runtime Baseline

The extension targets `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` 0.84.3. Source, tests, peer dependencies, and the production build use the current namespace directly. Reflection uses Pi's canonical extension inference boundary, `ctx.modelRegistry.complete()`, with a provider-neutral tool schema and universal request options; Pi owns provider translation, authentication, routing, hooks, and inference behavior.

The observer still retains its bounded append-only low-level loop through the explicit Pi compatibility stream. This is now a tracked migration seam rather than the target architecture: observation needs a bounded multi-turn protocol, but each provider turn should ultimately route through Pi's session-owned model runtime. Reflection remains a bounded fixed-evidence fold and must not be expanded into a general agent loop. See `docs/PI_NATIVE_ALIGNMENT_ROADMAP_2026-08-26.md`.

### Compaction Flow (Single Hook)

```
session_before_compact fires
        │
        ▼
[1] Flush pending OM observations
    (observer may have in-flight async work from last turn)
    Derive catch-up continuity from the current branch's durable
    coversUpToId anchor; cancel if session/leaf changes before persistence.
        │
        ▼
[2] Run VCC pipeline (synchronous, no LLM)
    normalizer → extractor → transcript → formatter
    Produces: VCC block (sections + transcript)
        │
        ▼
[3] Check OM gate: is observation pool ≥ reflectionThresholdTokens?
    YES → call the session-owned ModelRegistry completion boundary with the sole
           provider-neutral submit_reflections tool, prompt-directed tool use,
           no retries, a five-minute caller deadline, and pre-call capacity validation
    NO  → skip, use existing reflections as-is (zero LLM cost)
    The total carried reflection set may occupy at most 50% of maxSummaryTokens.
    Missing tool completion, infeasible capacity, failed/aborted/truncated/
    invalid-provenance output → retain the exact pre-fold memory set.
    Observation retirement remains disabled until an auditable retirement contract is approved.
        │
        ▼
[4] Assemble OM block
    mechanically concatenate: current reflections + current observations
        │
        ▼
[5] Merge VCC block + OM block
    apply trim priority only if merged summary exceeds growth ceiling
        │
        ▼
[6] Register merged summary as compactionSummary
    single hook, single output
```

### Observer Flow (Per-Turn, Async)

```
Turn completes
      │
      ▼
Has raw token delta since last observation ≥ observationThresholdTokens?
      NO → skip
      YES ↓
      │
      ▼
Prepare bounded observer-epoch transaction
  immutable baseline: active reflections + observations
  append-only delta: new source-addressed conversation chunk
      │
      ▼
LLM/tool loop returns observations with validated per-observation source subsets + exact transcript suffix
      │
      ▼
Append durable observation/coverage entry to Pi tree store
      │
      ▼
Commit transcript suffix to runtime epoch
```

The Pi branch is authoritative; epoch state is disposable. Failure, abort, invalid output, or persistence failure leaves coverage and epoch unchanged. Both proactive observation and compaction catch-up derive continuity from the same durable coverage anchor, including empty coverage entries. `coversUpToId` always names the last fully covered source; optional additive `sourceProgress` metadata resumes one oversized immediately-following source from a contiguous character offset and is cleared only when its final segment completes. Catch-up revalidates the starting session and leaf before persistence; if it writes durable observations outside the live epoch, the live epoch is invalidated immediately even if later compaction assembly fails. Epochs reset on session/model/prompt/serializer changes, coverage discontinuity, catch-up persistence, compaction, capacity, or restart. The effective epoch cap is `min(observerEpochMaxTokens, 40% of observer model contextWindow)` with fixed output/tool safety reservation.

---

## Merged Summary Format

This is the canonical output format. Section order is fixed. Do not deviate.

```
## Reflections
<plain prose lines, one per durable insight>
User works at Acme Corp building Acme Dashboard on Next.js 15 with Supabase auth.
Hard constraint: ship by January 22nd 2026.
Public API uses GraphQL — switched from REST to reduce mobile over-fetching.

## Observations
<timestamped, relevance-tagged lines, newest first>
2026-01-15 15:10 [critical] Rate limiting required on all public endpoints; token bucket at 100 req/min per API key.
2026-01-15 14:30 [high] Switched from REST to GraphQL; motivation: reduce over-fetching on mobile clients.
2026-01-15 14:35 [medium] Agent scaffolded GraphQL schema in src/schema.ts.

[Session Goal]
- Fix the authentication bug in login flow
- [Scope change] Also update session token refresh logic

[Files And Changes]
- Modified: src/auth/session.ts
- Modified: src/schema.ts
- Created: tests/auth-refresh.test.ts

[Commits]
- a1b2c3d: fix(auth): refresh token after password reset
- b4e5f6a: feat: add GraphQL schema

[Outstanding Context]
- lint check still failing on line 42
- rate limiting implementation not yet started

[User Preferences]
- Prefer Vietnamese responses
- Always run tests before committing

[user]
Fix the auth bug, users can't log in after password reset.

[assistant]
Root cause is a missing token refresh after password reset...
* bash "bun test tests/auth.test.ts" (#12)
* edit "src/auth/session.ts" (#14)
...(28 earlier lines omitted)
```

**Section ordering rationale:** Reflections and Observations come first because they are durable and agent-identity-bearing. The agent reads top-down; the most persistent context must be front-loaded. VCC structural sections follow because they are session-scoped facts. The brief transcript comes last because it is most ephemeral.

**Section omission rules (same as pi-vcc):** A section is omitted entirely if it has no content. A session with no git commits omits `[Commits]`. A session below the OM observation gate with no prior reflections omits both `## Reflections` and `## Observations`.

---

## Token Budget and Trim Priority

The merged summary will be larger than either source extension produced individually — that is expected and acceptable. The dual-layer output (semantic memory + structural memory) is more valuable than either alone, and the token cost of carrying both is the explicit tradeoff this extension makes.

The budget system exists for one reason only: **to prevent unbounded growth across many compaction cycles**. Without a ceiling, each compaction merges the previous merged summary with new material, and the observation pool + transcript can grow without limit over a multi-hour session. The `maxSummaryTokens` ceiling (default: 16000 tokens — roughly double what either source extension typically produces) is a long-term growth cap, not a per-compaction minimization target.

**When trim activates:** Only when the assembled merged summary exceeds `maxSummaryTokens`. Most compactions will not trigger any trimming. Trim is a safety valve, not routine behavior.

**Trim priority (drop in this order, only when over ceiling):**

1. Brief transcript oldest lines (roll the window back — this is the largest and most expendable section)
2. `low` relevance observations (oldest first)
3. `medium` relevance observations (oldest first)
4. VCC `[Outstanding Context]` lines (oldest first)
5. VCC `[Files And Changes]` lines (oldest first, keep most recent N)
6. `high` relevance observations (oldest first)
7. VCC `[Session Goal]` scope change lines (keep original goal always)
8. `[Commits]` oldest entries
9. `[User Preferences]` lines (oldest first)
10. **Never trim:** `critical` observations, `## Reflections` lines, original `[Session Goal]` first line

**Implementation:** `merge/budget.ts` parses observations and VCC sections into trimmable projection units, re-renders after each priority removal, and stops under the ceiling whenever trimmable content is sufficient. Projection trimming does not mutate `MemoryDetailsV4.observations`; durable observation retirement is owned exclusively by the fold policy. If protected visible content alone exceeds the ceiling, compaction preserves it and reports a protected-overflow warning rather than silently dropping critical observations, reflections, the original session goal, or unfamiliar future structural sections. Section-size reporting in `/hm-status` remains future work.

---

## Config Schema

The extension uses one flat configuration file:

- Global: `~/.pi/agent/pi-hybrid-memory-config.json`
- Optional project overrides: `.pi/pi-hybrid-memory-config.json`

The global file is auto-scaffolded and expanded with any newly introduced defaults while preserving existing values. Project files are sparse field-by-field overrides. The extension does not read hybrid-memory configuration from Pi's `settings.json`.

```jsonc
{
  "overrideDefaultCompaction": true,      // false delegates compaction to Pi
  "debug": false,

  // OM pipeline
  "observationThresholdTokens": 1000,
  "observerChunkMaxTokens": 60000,       // per-call observer input cap; backlog drains oldest-first
  "observerEpochMaxTokens": 96000,        // retained append-only observer context; also capped at 40% of model window
  "compactionThresholdTokens": 50000,
  "compactionThresholdPercentage": 80,   // whole percentage (1–99); null falls back to tokens
  "reflectionThresholdTokens": 30000,
  "compactionModel": null,               // optional { provider, id }; null uses session model

  // VCC pipeline
  "transcriptLines": 120,
  "maxFiles": 40,                 // total Modified → Created → Read slots across fresh and merged VCC state
  "maxCommits": 8,

  // Shared merged-summary growth ceiling
  "maxSummaryTokens": 16000
}
```

**Critical:** The `session_before_compact` hook must check `overrideDefaultCompaction` before running either pipeline. If `false`, return nothing from the hook so Pi's default LLM compaction runs as if the extension were disabled.

---

## What to Port vs. What to Rewrite

### Port directly from pi-vcc (minimize changes)
- `normalizer.ts` — message normalization is stable and well-tested; port verbatim
- `extractor.ts` — regex extraction for goal, files, commits, preferences, blockers; port verbatim
- `transcript.ts` — rolling window and tool call collapsing; port verbatim, expose `maxLines` as param
- `merger.ts` — merge policy per section; port verbatim
- `recall.ts` — `vcc_recall` tool and `/pi-vcc-recall` slash command; port verbatim, rename command to `/hm-recall`

### Port directly from pi-observational-memory (minimize changes)
- `observer.ts` — chunking + LLM tagging; port verbatim, expose model as param from config
- `reflector.ts` — LLM crystallization of reflections; port verbatim
- `pruner.ts` — relevance-based drop logic; port verbatim
- `store.ts` — Pi tree storage read/write; port verbatim

### Write fresh
- `src/index.ts` — new entry point, single hook registration
- `src/merge/pipeline.ts` — orchestration of both pipelines with flush coordination
- `src/merge/budget.ts` — shared token budget and trim priority logic
- `src/merge/format.ts` — final merged summary formatter
- `src/config.ts` — unified flat config: scaffold the global `pi-hybrid-memory-config.json`, expand it with new defaults without replacing user values, and merge optional sparse project overrides.
- `src/types.ts` — unified type definitions (reconcile any naming conflicts between the two repos)

---

## Critical Problems to Solve

### 1. Flush-Before-Compaction Race

The observer runs async after each turn. When compaction fires, there may be observations in-flight (LLM call pending) or buffered but not yet committed to the tree store. If you don't flush these before assembling the summary, the last N turns' observations are lost.

**Solution:** In `pipeline.ts`, before running either pipeline, await any in-flight observer promise. The observer must expose a `flush(): Promise<void>` method that the pipeline calls. If the observer is idle, flush is a no-op. If it's mid-LLM-call, flush awaits its completion and commits the result.

### 2. State Isolation Between Pipelines

Both pipelines read from Pi's tree store. pi-vcc uses it for the previous VCC summary (merge policy). pi-observational-memory uses it for the observation pool and reflections. They must use distinct key namespaces to avoid collisions.

**Solution:**
- OM keys: `hybrid-memory/om/observations`, `hybrid-memory/om/reflections`, `hybrid-memory/om/pendingObservations`
- VCC keys: `hybrid-memory/vcc/lastSummary`
- Never read or write the other pipeline's keys from either pipeline's own modules

### 3. First-Run Bootstrap

On first install, both tree store namespaces are empty. The OM pipeline has no prior reflections or observations. The VCC pipeline has no prior summary to merge against.

**Solution:** Both pipelines must handle empty state gracefully and produce a valid (possibly shorter) summary. First-run produces only what the current session contains — no reflections block if none exist yet, no VCC merge if no prior summary. This is already how both source extensions handle it; preserve that behavior.

### 4. Token Budget Accuracy

Trim only activates when the merged summary exceeds `maxSummaryTokens`. But when it does activate, you need per-section token counts before assembly — you can't count after joining because you've already lost the per-unit granularity needed to trim surgically.

**Solution:** In `budget.ts`, always represent the pre-assembly summary as an array of `{ priority: number, label: string, tokens: number, content: string }` units. Check total against ceiling. If under, join in canonical section order and return immediately — no trimming. If over, drop from lowest priority upward until under ceiling, then join survivors in canonical section order. Never reorder sections based on priority — priority only governs what gets dropped, not what appears first. Log a warning when trim activates so users know the ceiling was hit and can adjust `maxSummaryTokens` if they want a larger cap.

### 5. OM Gate Behavior Preservation

pi-observational-memory only calls the reflector + pruner when the observation pool exceeds `reflectionThresholdTokens`. Below this gate, compaction costs zero LLM calls. This is a key selling point and must be preserved exactly.

**Solution:** In `pipeline.ts`, after flushing pending observations, check pool token count against `reflectionThresholdTokens`. If below, skip reflector and pruner entirely. The OM assembler still runs (it just concatenates whatever reflections and observations currently exist), but no new LLM calls are made.

### 6. Slash Command Naming Conflicts

pi-vcc registers `/pi-vcc` and `/pi-vcc-recall`. pi-observational-memory registers `/om-status` and `/om-view`. If a user has either extension installed alongside this one, there will be command conflicts.

**Solution:** Register new command names:
- `/hm-recall` — replaces `/pi-vcc-recall`
- `/hm-status` — replaces `/om-status`, also shows VCC section sizes and budget usage
- `/hm-view` — replaces `/om-view`, shows full OM state
- `/hm-compact` — replaces `/pi-vcc` manual compaction trigger
- Document that users should uninstall both source extensions before installing `pi-hybrid-memory`

### 7. Model Config for Observer

The observer, reflector, and pruner all make LLM calls. pi-observational-memory allows pointing these at a cheap model via `compactionModel`. This must be preserved.

**Solution:** In `config.ts`, read `hybrid-memory.compactionModel`. If set, pass it to the observer, reflector, and pruner as their model override. If null, use the session's default model. The VCC pipeline never makes LLM calls and ignores this setting.

### 8. Config File Scaffolding

The extension config file must be created automatically on first load if absent — users should never have to create it manually or know it exists unless they want to change a value.

**Solution:** In `config.ts`, on `session_start`, check if `~/.pi/agent/pi-hybrid-memory-config.json` exists. If not, write it with safe defaults:

```json
{
  "overrideDefaultCompaction": true,
  "debug": false
}
```

In `pipeline.ts`, the very first thing `session_before_compact` does is read `overrideDefaultCompaction`. If `false`, return `undefined` immediately — Pi's default compaction runs, neither pipeline executes, zero cost. This makes disabling the extension a one-line config edit rather than an uninstall.

---

## Startup Validation

Add this to the `src/config.ts` responsibilities, run on every `session_start`:

1. **Scaffold config file** if `pi-hybrid-memory-config.json` does not exist — write it with safe defaults silently.

2. **Check `overrideDefaultCompaction`** — if `false`, log a one-time info: `"pi-hybrid-memory: override is disabled. Pi's default compaction will run. Set overrideDefaultCompaction: true in pi-hybrid-memory-config.json to enable."` Do not log this every compaction — only at session start.

3. If `overrideDefaultCompaction` is `true` and `compactionModel` is null, log a one-time advisory pointing to `compactionModel` in `pi-hybrid-memory-config.json`.

4. If `overrideDefaultCompaction` is `true` and `compaction.keepRecentTokens` is below 15000, log a one-time warning: `"pi-hybrid-memory: compaction.keepRecentTokens is low. Recommend 20000 in settings.json."`

Advisories 3 and 4 only fire when `overrideDefaultCompaction` is `true` — no point warning about tuning a disabled extension.

---

## Commands to Register

| Command | Description |
|---|---|
| `/hm-compact` | Manually trigger compaction immediately |
| `/hm-status` | Show: OM observation pool size, % to reflection gate, in-flight flags, VCC section token counts, current merged summary size vs. growth ceiling |
| `/hm-cache-info` | Show session-local observer/reflector/pruner token usage, cache reads/writes, outcomes, provider-reported cost, separate model-price estimates, and observer-epoch cold/warm prefix diagnostics; no prompt content is persisted |
| `/hm-view` | Full dump: every reflection, every committed observation (with id, timestamp, relevance), pending observation count, last VCC sections |
| `/hm-recall <query> [page:N]` | Search raw JSONL history (regex supported, OR-ranked multi-word); shows collapsible results and feeds to agent |

---

## Tests to Write

### Unit Tests

**VCC pipeline (port from pi-vcc/tests):**
- Normalizer handles all Pi message types (user, assistant, tool_call, tool_result, thinking, system)
- Goal extractor captures initial goal and scope changes
- File extractor deduplicates paths and trims to common root
- Commit extractor captures last N commits
- Preferences extractor regex matches `always`, `never`, `prefer` patterns
- Blocker extractor captures unresolved errors and pending questions
- Transcript rolling window drops oldest lines when over `maxLines`
- Tool call collapsing produces `* toolname "arg" (#N)` format
- Merge policy: sticky sections merge, volatile sections replace, union sections accumulate

**OM pipeline:**
- Observer correctly chunks at `observationThresholdTokens` boundary
- Relevance tiers (`low`, `medium`, `high`, `critical`) are parsed correctly from LLM response
- Pruner drops `low` before `medium` before `high`, never drops `critical`
- Reflector output is plain prose (no timestamps, no tiers)
- Store read/write round-trips observations correctly
- Flush awaits in-flight observer before returning

**Budget:**
- Under-ceiling summary passes through with zero trimming
- Over-ceiling summary trims in correct priority order
- `critical` observations and Reflections are never trimmed regardless of ceiling
- Original `[Session Goal]` first line is never trimmed
- Warning is emitted when trim activates

### Integration Tests
- Full pipeline on a fixture session JSONL produces valid merged summary
- Merged summary on a short session is larger than either source extension alone (expected and correct)
- Merged summary on a very long session (many compaction cycles) stays under `maxSummaryTokens` ceiling
- Empty state (first run) produces valid summary without errors
- `pi-hybrid-memory-config.json` is auto-created with correct defaults when absent
- Setting `overrideDefaultCompaction: false` causes the hook to return nothing and Pi's default compaction runs
- Session below reflection gate produces zero LLM calls
- `/hm-recall` returns results from raw JSONL correctly after compaction

---

## README Requirements

The README must include:

1. What this is and why (the hook conflict problem, the complementary strategies)
2. Install: `pi install npm:pi-hybrid-memory` and GitHub fallback
3. **Uninstall both source extensions first** — prominent warning
4. Two-part config reference:
   - `pi-hybrid-memory-config.json`: `overrideDefaultCompaction` and `debug`, noting it is auto-created and users rarely need to touch it except to disable the extension
   - `pi-hybrid-memory-config.json`: all keys, defaults, global/project precedence, and what each controls
5. How to disable without uninstalling: set `overrideDefaultCompaction: false`
6. Merged summary format example (copy from this spec)
7. Commands table
8. Cost model: when LLM calls happen vs. when they don't
9. Migration guide from pi-observational-memory and from pi-vcc separately
10. Token growth ceiling explanation: what `maxSummaryTokens` is (a long-term cap, not a minimization target), when trim activates, and the trim priority table

---

## Current State

- Retention-safe reflection folding is implemented through Pi's native `ctx.modelRegistry.complete()` boundary; observation retirement remains disabled.
- Pi-native alignment **Milestones A–G plus G1** are complete: cleanup, trusted schema-validated configuration, conservative token accounting, observer lifecycle fencing, Pi-native observer inference, cut-point-aligned VCC input, full engine audit, and immediate protocol/scope correctness repairs.
- Observer inference now has one authoritative tool-only contract; deliberate-empty catch-up advances durable coverage; runtime config is keyed by canonical cwd and trust scope; session-local recovery state resets per session; known V3/V4 details are explicitly validated and normalized for compatibility while new lifecycle writes use V5.
- **G2 — canonical branch memory index is complete.** Current memory, compaction history, observation/reflection lookup, exact branch-entry lookup, observation provenance, and reflection evidence traversal now share one pure read projection. Historical maps are lazy so routine observer/status paths do not repeatedly parse all prior compactions.
- **G3 Phase A is implemented.** New compactions persist strict V5 one-time reflection lifecycle records instead of copying complete observation/reflection snapshots. The canonical branch index replays V3/V4 compatibility baselines, custom observation evidence, and valid V5 additions; conflicting immutable IDs or malformed/out-of-order V5 batches are rejected atomically with visible diagnostics. Observation retirement remains structurally disabled. See `docs/MEMORY_LIFECYCLE_DESIGN_2026-08-26.md`.
- The capacity-aware observer correction is implemented. Proactive and catch-up observation now share one request-preparation operation that fits contiguous source against the complete dynamic delta envelope before creating the epoch transaction. A complete short source may finish below the preferred 256-token segment floor; an incomplete segment below that floor fails closed. Persisted partial progress whose rendered length no longer matches restarts that source from offset zero rather than trusting a stale offset. See `docs/OBSERVER_CAPACITY_ROADMAP_2026-08-27.md`.
- **Phase B deterministic exact-duplicate retirement is implemented.** Narrow line-ending/outer-whitespace normalized content plus equal relevance identifies duplicates in active projection order. Only canonical custom-entry observations retire; V3/V4-only evidence may preserve but cannot be retired. Explicit V5 events replay atomically, retired IDs remain exactly recallable with original provenance and lifecycle links, and summaries render only active observations. See `docs/EXACT_DUPLICATE_RETIREMENT_ROADMAP_2026-08-27.md`.
- **Deterministic Phase C reflection strengthening is implemented.** Same normalized content plus new valid support creates one immutable successor with the union of predecessor and proposed support, and an explicit V5 `strengthened` edge. Replay applies additions and supersessions atomically; current projection excludes predecessors while exact recall preserves both revisions and their lifecycle link. Changed-content reflections remain concurrently active and model-proposed correction/supersession remains deferred. See `docs/REFLECTION_STRENGTHENING_ROADMAP_2026-08-27.md`.
- **The test-only deterministic 300/600/900-observation quality harness is implemented.** Compact generated fixtures exercise exact identifiers, paths, versions, errors, diagnoses, corrections, decisions, rationale, chronology, unresolved constraints, and provenance. The evaluator reports required-fact failures, false retirement/retention, structural invalidity, active-context reduction, missing provenance, and deterministic projection fingerprints without runtime code or provider calls. See `docs/MEMORY_QUALITY_HARNESS_ROADMAP_2026-08-27.md`.
- **Phase D semantic-retirement evaluation is complete and no protocol is approved.** The separate protocol retired all 12 deterministic required facts in its first 300-observation run. Combined runs were unstable: one produced zero false retirement with 84.61% reduction, while an identical repeat produced 9 required-fact failures/false retirements with only 0.70% reduction. The same model, fixture, and protocol therefore failed the safety and convergence gate. Semantic `fully-absorbed` and observation `superseded` retirement remain structurally disabled; 600/900 provider runs were intentionally skipped. See `docs/SEMANTIC_RETIREMENT_EXPERIMENT_ROADMAP_2026-08-27.md`.
- **Controlled live validation is complete and the validated repository bundle has been rolled out successfully.** The deterministic gate passed Pi 0.84.3 extension loading, two RPC compactions, V5 persistence, restart replay, exact provenance, idempotency, and Phase A fail-closed rollback inspection. The model-assisted gate passed catch-up observation, reflection persistence, restart replay, and an actual `hm_recall` tool invocation. After backed-up installation, the real session also passed status, memory, manual compaction, restart replay, and exact observation/source recall checks. Semantic retirement remains disabled. See `docs/CONTROLLED_LIVE_VALIDATION_ROADMAP_2026-08-27.md`.
- **The bounded observer-pipeline redesign is implemented, validated, and installed.** A valid or deliberate-empty observer result now completes in one extension-owned model completion; invalid output receives at most one correction opportunity. Both observer paths share a deterministic bounded context planner with a stable reflections/protected/recent prefix and source-related history in the dynamic delta, while immutable omitted evidence remains recallable. Context budgets derive from the effective observer limit with no new configuration or persisted index. Manual compaction processes at most one durable catch-up segment and cancels behind remaining backlog instead of draining an unbounded loop. `/hm-cache-info` reports content-free bounded-context tokens/counts and protected overflow. The full 33-file suite, typecheck, 43-module build, deterministic Pi RPC gate, and model-assisted observer/reflection/restart/recall gate pass for bundle `1f41a970d82bc5c8896a403b6015fe6563ac8474c2630a2bcc6026b67dc8b01f`; that exact bundle is now installed with the prior `0a03dd3d…6103` bundle backed up. A real long-session trial processed a ~67,855-token uncovered gap in one bounded observer call, durably reduced it to ~10,611 tokens, and cancelled promptly for a later compaction attempt as designed. Journal/lifecycle/recall schemas remain unchanged by that milestone; semantic retirement, embeddings, persistent indexes, generalized queues, and provider changes remain out of scope. See `docs/BOUNDED_OBSERVER_PIPELINE_ROADMAP_2026-08-28.md`.
- **Incremental reflection and a hard-bounded main-session projection are the current structural milestone; Stage 1 bounded reflection is isolated-live validated but not installed.** Production evidence showed the prior reflector could consume ~88,892 input/~23,448 output tokens, propose 13 reflections, and persist zero after atomic invalid-provenance rejection; the same branch assembled a ~53,269-token summary despite a 16,000-token setting. Stage 1 keeps the current compaction persistence seam but bounds reflection to the pending compaction delta plus bounded historical context, assigns deterministic request-local evidence handles, permits at most four concise proposals with one structural correction, validates handles per candidate before the existing canonical merge, exits immediately on abort, and reports content-free plan/completion timing through `/hm-cache-info`. A read-only measurement on the current 1,351-observation branch selected all 136 pending focus observations into an estimated 24,667-token request with a 1,536-token output bound. The 36-file/283-test suite, typecheck, 45-module build, deterministic Pi gate, and model-assisted local-handle/reflection/restart/recall gate pass for repository bundle `3614d7ac21beee7c2407a71c488b6da67b747f362736d33f808179e194fd0f24`; the installed bundle remains `1f41a970…b01f`. Next: decide Stage 1 rollout, then design the minimum generalized lifecycle event for incremental persistence, remove reflector inference from `/compact`, and enforce a real projection ceiling. Immutable observations, exact recall, no semantic retirement, one authoritative projector, no side database/index, and no generalized scheduler remain fixed constraints. See `docs/INCREMENTAL_REFLECTION_AND_PROJECTION_ROADMAP_2026-08-28.md`.
- The observer and reflector route provider requests through `ctx.modelRegistry.complete()` with intentionally different bounded domain protocols. VCC is zero-LLM and folds only Pi's removed delta plus prior structural state and authoritative file activity; the retained live tail remains verbatim and is not duplicated into the summary.
- Do not introduce a reflection agent loop. The incremental reflector is one bounded journal transaction, not an autonomous conversational agent.

---

## Definition of Done

- [ ] Single `session_before_compact` hook registered, no other compaction hooks
- [ ] `pi-hybrid-memory-config.json` auto-scaffolded with correct defaults on first load when absent
- [ ] `overrideDefaultCompaction: false` causes hook to return nothing — Pi's default runs, no pipelines execute
- [ ] `overrideDefaultCompaction: true` (default) causes full merged pipeline to run
- [ ] VCC pipeline produces correct sections from fixture sessions
- [ ] OM pipeline observer runs async without blocking turns
- [ ] Flush-before-compaction awaits in-flight observer correctly
- [ ] Merged summary on short sessions is correctly larger than either source extension (not artificially capped)
- [ ] Merged summary on long multi-compaction sessions never exceeds `maxSummaryTokens`; omitted active evidence remains exactly recallable
- [ ] Retired evidence remains recallable without remaining in the normal main-model summary
- [ ] No observation is retired without a locally validated preservation reason and durable audit trail
- [ ] Representative long-session compactions materially reduce `summary + retained tail` relative to `tokensBefore`
- [ ] Trim warning is emitted when ceiling is hit; trim priority order is enforced
- [ ] Covered steady-state compaction makes zero extension-owned LLM calls regardless of reflection backlog
- [ ] `vcc_recall` / `/hm-recall` returns correct results after compaction
- [ ] All four slash commands registered and functional
- [ ] All extension-owned config is loaded only from `pi-hybrid-memory-config.json`
- [ ] All unit tests pass
- [ ] All integration tests pass on at least 3 fixture session JSONLs
- [ ] `npm run build` produces clean output with no TypeScript errors
- [ ] README complete per requirements above

---

## Out of Scope

- Do not build a UI or web dashboard
- Do not add cross-session memory (memory that persists across separate Pi sessions) — this is within-session only
- Do not add vector search or embedding-based recall — `vcc_recall` regex search is sufficient
- Do not modify Pi core behavior
- Do not support any Pi version prior to whatever both source extensions currently target
- Do not add persistent or content-bearing analytics; session-local content-free operational telemetry is allowed
