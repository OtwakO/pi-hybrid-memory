# pi-hybrid-memory

> Requires Pi 0.84 or newer for the `agent_settled` automatic-compaction trigger.

Merges **semantic observational memory** with **structural VCC compaction** into a single unified summary for the [pi](https://github.com/mariozechner/pi) coding agent.

## What It Does

When a Pi session grows too large, this extension replaces the raw conversation history with a compact summary that contains **two complementary layers**:

1. **Memory Layer** (from pi-observational-memory): LLM-extracted observations and distilled reflections — semantic "what to remember" with provenance tracking and relevance levels.
2. **Session State Layer** (from pi-vcc): Algorithmic structural summary — "what happened" including goals, files changed, commits, user preferences, and a compressed transcript.

The two layers are merged into one summary via a priority-aware budget pipeline. It removes stale VCC transcript/history first, then progressively lower-priority semantic and structural units, while keeping reflections and critical observations intact even when protected memory must exceed the configured ceiling.

## Installation

### Option 1: Local copy (quickest)

```bash
cp -r pi-hybrid-memory ~/.pi/agent/extensions/pi-hybrid-memory
```

Then run `/reload` in Pi. The extension is auto-discovered — no settings edit needed.

### Option 2: `pi install` from local path

```bash
pi install ./path/to/pi-hybrid-memory
```

### Option 3: Git repository

```bash
pi install git:github.com/OtwakO/pi-hybrid-memory
```

### Option 4: npm package

```bash
pi install npm:pi-hybrid-memory
```

### Verify it loaded

```bash
/hm-status
```

If the command returns memory metrics, the extension is active.

## Configuration

All extension settings live in `pi-hybrid-memory-config.json`:

- Global: `~/.pi/agent/pi-hybrid-memory-config.json`
- Project overrides: `<project>/.pi/pi-hybrid-memory-config.json`

The global file is created automatically. Project files override individual fields rather than replacing the entire global config.

```json
{
  "overrideDefaultCompaction": true,
  "debug": false,
  "observationThresholdTokens": 1000,
  "observerChunkMaxTokens": 60000,
  "observerEpochMaxTokens": 96000,
  "compactionThresholdTokens": 50000,
  "compactionThresholdPercentage": 80,
  "reflectionThresholdTokens": 30000,
  "compactionModel": { "provider": "openai", "id": "gpt-4o-mini" },
  "transcriptLines": 120,
  "maxFiles": 40,
  "maxCommits": 8,
  "maxSummaryTokens": 16000
}
```

| Setting | Default | Description |
|---|---|---|
| `overrideDefaultCompaction` | `true` | Set to `false` to let Pi's default compaction run instead |
| `debug` | `false` | Enable debug logging |
| `observationThresholdTokens` | 1000 | New tokens of raw conversation before the observer runs |
| `observerChunkMaxTokens` | 60000 | Maximum serialized source tokens per observer call; large backlogs are processed oldest-first and oversized single entries use marked head/tail excerpts |
| `observerEpochMaxTokens` | 96000 | Maximum estimated size of the observer's temporary reusable context before it is safely rebuilt from durable memory; the effective cap is the lower of this value and 40% of the observer model's context window |
| `compactionThresholdTokens` | 50000 | Auto-compact after a completed agent run when current context exceeds this many tokens |
| `compactionThresholdPercentage` | `80` | Whole percentage from 1–99; auto-compacts after a completed agent run when context exceeds this share of the active model's window. Set to `null` to use `compactionThresholdTokens` instead |
| `reflectionThresholdTokens` | 30000 | Observation tokens before reflector/pruner runs |
| `compactionModel` | `null` | Override model for LLM-heavy ops (observer, reflector, pruner). Falls back to session model |
| `transcriptLines` | 120 | Max lines in the VCC brief transcript |
| `maxFiles` | 40 | Total file slots in the VCC summary, allocated Modified → Created → Read and preserved across merge cycles |
| `maxCommits` | 8 | Max commits in the VCC summary |
| `maxSummaryTokens` | 16000 | Growth ceiling for the merged summary; stale transcript and lower-priority units trim first, while protected durable memory may exceed it rather than be silently dropped |

Automatic threshold checks run only after the full agent run settles, not between tool calls. Invalid percentage values are ignored and the token threshold is used instead.

The extension does not read hybrid-memory configuration from Pi's `settings.json`; `pi-hybrid-memory-config.json` is the only configuration surface.

## Commands

### `/hm-status`

Shows current memory state:
- Reflection/observation counts and token estimates
- Relevance histogram
- Activity progress (how close to next trigger thresholds), including whether the current observation pool is eligible for reflection
- VCC settings summary

### `/hm-cache-info`

Shows session-local telemetry for LLM calls owned by hybrid memory: observer, reflector, and pruner. It does not include the main Pi conversation.

The command displays:

- Whole-session aggregates per operation
- The 10 most recent extension LLM calls
- Observer epoch state: committed run count, estimated retained tokens, coverage anchor, and last reset reason
- Per-observer-call cold/warm status, epoch run number, locally predicted reusable-prefix tokens, and projected request tokens
- Input, output, cache-read, and cache-write tokens
- Cache-read ratio as `cacheRead / (input + cacheRead)` when usage is available
- Provider-reported cost from the response
- A separate price-based estimate calculated from the active model's configured per-million-token prices
- `unknown` when usage or pricing is unavailable, rather than treating missing data as zero

Telemetry contains only model/operation metadata, usage, outcome, timestamp, and costs. It is held in memory, resets on `session_start`, and does not persist prompts, observations, source text, API keys, or headers.

Hybrid-memory model calls use stable per-session, per-operation cache identities (`observer`, `reflector`, and `pruner`) and request long cache retention. Providers that support these options map them to their own prompt-cache or affinity mechanisms; unsupported providers ignore them.

Observer calls additionally use a bounded runtime-only append-only epoch. See [Observer epoch and cache reuse](#observer-epoch-and-cache-reuse) for its transaction, reset, compaction, and compatibility behavior.

A call marked `warm` means the extension supplied the retained structured-message prefix. It does not guarantee a provider cache hit: cache TTL, eviction, routing, and provider policy can still produce `cache read 0`. A `cold` call with a reset reason means the extension intentionally rebuilt the epoch for correctness.

### `/hm-memory`

Opens an interactive TUI overlay to browse all memory content:
- **Tab 1 — Observations:** Color-coded by relevance (🔴 critical, 🟠 high, 🟡 medium, ⚪ low), scrollable list
- **Tab 2 — Reflections:** Synthesized insights with supporting observation IDs; when empty, the picker explains whether the observation pool is still below the reflection gate
- **Tab 3 — Compactions:** VCC compaction summaries with full detail view
- **Current Context Summary:** The latest merged context with its actual estimated in-context token count

**Navigation:**
- `↑↓` / mouse scroll — navigate list
- `Enter` — open detail view with full content
- `Tab` / `1` `2` `3` — switch tabs
- `Esc` — close

## Tools

### `hm_recall(<id>)`

`hm_recall` has two lookup modes:

| ID | Mode | Result |
|---|---|---|
| 12 lowercase alphanumeric characters, e.g. `moszb0o30001` | Memory lookup | Recalls an observation or reflection with provenance and bounded source previews |
| 8 lowercase hexadecimal characters, e.g. `1aabb792` | Exact source lookup | Returns that original Pi session entry from the current branch |

```text
hm_recall("moszb0o30001")  # memory + source previews
hm_recall("1aabb792")      # exact original source entry
```

Memory lookup previews are chronological and allocated fairly so later sources are not starved by earlier entries:

- Up to 1,200 characters per source
- Up to 8,000 characters across all previews
- Explicit `… [truncated]` markers
- Source ID, role, timestamp, and token estimate remain visible

Use an 8-character source ID from the Sources section when exact wording, paths, errors, commands, or decisions matter. Direct source lookup uses a separate 20,000-character safety cap and returns `source_unavailable` if the entry has been pruned from the current branch.

Reflection lookup follows supporting observation IDs to their available source entries, preserving the provenance chain.

## How It Works

```
Raw conversation → (Observer → Observations) → (Reflector → Reflections)
                 → (VCC Extractor → Structural Summary)
                 → (Merge Pipeline → Unified Summary)
```

1. **Observer** (LLM): At each turn end, extracts durable observations from new conversation when enough tokens have accumulated.
2. **Reflector/Pruner** (LLM): At compaction time, synthesizes observations into reflections and removes redundant observations.
3. **VCC Pipeline** (algorithmic): Extracts goals, files, commits, preferences, blockers, and builds a compressed transcript.
4. **Merge Pipeline**: Combines both layers into one summary, trimming low-relevance observations if over the token budget.

## Observer epoch and cache reuse

The Pi session branch remains the authoritative memory store. The observer epoch is only a disposable in-memory request context: it is not added to session JSONL, compaction details, or the memory schema. Restarting or reloading Pi loses cache warmth but does not lose observations, reflections, source provenance, or coverage.

An epoch contains:

```text
stable observer system prompt and tool schema
immutable baseline of active reflections and observations
new source-addressed chunk 1
observer/tool transcript 1
new source-addressed chunk 2
observer/tool transcript 2
...
```

After a successful run, the complete prior structured-message sequence is an exact prefix of the next request. This enables provider-independent prefix-cache reuse without removing prior memory, chronology, corrections, or provenance.

Each run is transactional:

```text
prepare epoch draft
→ run and validate observer/tool loop
→ validate transaction and coverage
→ persist observation or coverage entry to the Pi branch
→ commit the exact transcript suffix to the runtime epoch
```

Failures, aborts, invalid provenance, stale transactions, or persistence failures do not advance epoch coverage. Compaction catch-up uses an isolated fork: every uncovered chunk must succeed before one consolidated durable entry is written. A failed catch-up discards the fork and cancels compaction; successful compaction invalidates the live epoch because reflection, pruning, and branch boundaries may have changed.

The epoch is safely rebuilt when its retained context reaches capacity or when continuity cannot be proven. Common reset reasons shown by `/hm-cache-info` are:

| Reset reason | Meaning |
|---|---|
| `session-change` | Pi started, resumed, switched, forked, or created a session |
| `compaction` | Successful compaction changed the active memory projection |
| `coverage-discontinuity` | The next source boundary did not match the epoch's last durably covered source; rare during uninterrupted linear use |
| `capacity` | Another delta would exceed the effective epoch limit |
| compatibility change | Observer model/provider/API, prompt, tool schema, or serializer identity changed |

Existing sessions require no migration. The first observer call after session activation is expected to be cold; later calls should remain warm until one of these reset boundaries occurs.

## Architecture

```
src/
├── index.ts              # Extension entry point
├── types.ts              # Unified type definitions
├── config.ts             # Unified flat config loading
├── runtime.ts            # Runtime state, observer epoch, and in-flight tracking
├── auto-compaction.ts    # Post-agent percentage/token compaction trigger
├── cache-options.ts      # Stable per-session operation cache identities
├── cache-telemetry.ts    # Session-local usage, cost, and epoch diagnostics
├── compaction-hook.ts    # Unified compaction and atomic observer catch-up
├── observer-trigger.ts   # Proactive transactional observer at turn_end
├── status.ts             # /hm-status command
├── tools/
│   └── recall.ts         # hm_recall tool
├── vcc/
│   ├── normalizer.ts     # Raw messages → NormalizedBlocks
│   ├── extractor.ts      # Goals, files, commits, preferences, blockers
│   ├── transcript.ts     # Brief transcript builder
│   ├── formatter.ts      # VCC sections → text
│   └── merger.ts         # VCC summary merge policy
├── om/
│   ├── tokens.ts         # Token estimation
│   ├── prompts.ts        # LLM prompts (observer, reflector, pruner)
│   ├── observer.ts       # LLM/tool observation extraction
│   ├── observer-context.ts # Stable baseline/delta and compatibility identity
│   ├── observer-epoch.ts # Bounded append-only transactional request context
│   ├── compaction.ts     # Reflector + pruner + summary render
│   ├── branch.ts         # Branch entry indexing & memory state
│   ├── serialize.ts      # Entry → text serialization
│   └── relevance.ts      # Relevance histogram
└── merge/
    ├── budget.ts         # Structured priority-based summary budgeting
    └── pipeline.ts       # Merge OM + VCC and synchronize retained details
```

## Running Tests

```bash
npm test
```

## Type Checking

```bash
npm run typecheck
```

## License

MIT
