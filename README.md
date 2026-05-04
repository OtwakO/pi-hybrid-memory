# pi-hybrid-memory

Merges **semantic observational memory** with **structural VCC compaction** into a single unified summary for the [pi](https://github.com/mariozechner/pi) coding agent.

## What It Does

When a Pi session grows too large, this extension replaces the raw conversation history with a compact summary that contains **two complementary layers**:

1. **Memory Layer** (from pi-observational-memory): LLM-extracted observations and distilled reflections — semantic "what to remember" with provenance tracking and relevance levels.
2. **Session State Layer** (from pi-vcc): Algorithmic structural summary — "what happened" including goals, files changed, commits, user preferences, and a compressed transcript.

The two layers are merged into one summary via a budget-aware pipeline that trims low-relevance observations first when space is tight.

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
pi install git:github.com/elpapi42/pi-hybrid-memory
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

### Extension Config (`pi-hybrid-memory-config.json`)

Place in `~/.pi/agent/` (global) or `<project>/.pi/` (project-level):

```json
{
  "overrideDefaultCompaction": true,
  "debug": false
}
```

| Setting | Default | Description |
|---|---|---|
| `overrideDefaultCompaction` | `true` | Set to `false` to let Pi's default compaction run instead |
| `debug` | `false` | Enable debug logging |

### Settings (`settings.json`)

In `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`:

```json
{
  "hybrid-memory": {
    "observationThresholdTokens": 1000,
    "compactionThresholdTokens": 50000,
    "reflectionThresholdTokens": 30000,
    "compactionModel": { "provider": "openai", "id": "gpt-4o-mini" },
    "transcriptLines": 120,
    "maxFiles": 40,
    "maxCommits": 8,
    "maxSummaryTokens": 16000
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `observationThresholdTokens` | 1000 | New tokens of raw conversation before the observer runs |
| `compactionThresholdTokens` | 50000 | New tokens before compaction is triggered |
| `reflectionThresholdTokens` | 30000 | Observation tokens before reflector/pruner runs |
| `compactionModel` | `null` | Override model for LLM-heavy ops (observer, reflector, pruner). Falls back to session model |
| `transcriptLines` | 120 | Max lines in the VCC brief transcript |
| `maxFiles` | 40 | Max files in the VCC summary |
| `maxCommits` | 8 | Max commits in the VCC summary |
| `maxSummaryTokens` | 16000 | Hard cap on the final merged summary size |

**Backward compatibility:** `observational-memory.*` settings are read as fallback if `hybrid-memory.*` is not set.

## Commands

### `/hm-status`

Shows current memory state:
- Reflection/observation counts and token estimates
- Relevance histogram
- Activity progress (how close to next trigger thresholds)
- VCC settings summary

## Tools

### `hm-recall(<id>)`

Recovers the full content and source context behind a compacted observation or reflection ID.

```
hm-recall(a1b2c3d4e5f6)
```

Returns:
- Observation/reflection content
- Source entries (user messages, tool calls) that generated it
- Provenance chain for reflections

### `vcc_recall` (inherited from pi-vcc)

Search session history by regex. Defaults to active lineage.

```
vcc_recall(query: "auth|login", scope: "all")
```

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

## Architecture

```
src/
├── index.ts              # Extension entry point
├── types.ts              # Unified type definitions
├── config.ts             # Config loading (extension + settings)
├── runtime.ts            # Runtime state (config, in-flight tracking)
├── compaction-hook.ts    # Unified compaction (OM + VCC + merge)
├── observer-trigger.ts   # Proactive observer at turn_end
├── status.ts             # /hm-status command
├── tools/
│   └── recall.ts         # hm-recall tool
├── vcc/
│   ├── normalizer.ts     # Raw messages → NormalizedBlocks
│   ├── extractor.ts      # Goals, files, commits, preferences, blockers
│   ├── transcript.ts     # Brief transcript builder
│   ├── formatter.ts      # VCC sections → text
│   └── merger.ts         # VCC summary merge policy
├── om/
│   ├── tokens.ts         # Token estimation
│   ├── prompts.ts        # LLM prompts (observer, reflector, pruner)
│   ├── observer.ts       # LLM-based observation extraction
│   ├── compaction.ts     # Reflector + pruner + summary render
│   ├── branch.ts         # Branch entry indexing & memory state
│   ├── serialize.ts      # Entry → text serialization
│   └── relevance.ts      # Relevance histogram
└── merge/
    └── pipeline.ts       # Merge OM + VCC with budget trimming
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
