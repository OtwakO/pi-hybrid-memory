# Reference Repository Commits

These are the upstream commits the pi-hybrid-memory extension was built from / took
inspiration from. The `reference/` directory was removed from the repo after this
initial implementation. When updating against newer upstream versions, diff against
these commit hashes (or `git pull` fresh clones and `git log a6dcea6..HEAD` etc.) to
see what changed.

Recorded 2026-06-27.

## pi-observational-memory (primary design reference for the OM subsystem)

- Repo: https://github.com/elpapi42/pi-observational-memory.git
- Branch: `master`
- Commit: `a6dcea6a4535bb906b7bd215c5153fcc04a122a9`
- Author date: 2026-05-05 09:00:02 -0500
- Subject: "Bump version"

What we ported from this repo:
- Observer (gap + proactive) using `agentLoop` + `record_observations` tool
- Reflector / pruner pipeline with coverage tags (uncited / cited / reinforced)
- `MemoryDetailsV4`, `ReflectionRecord` with `supportingObservationIds`,
  `LegacyReflection` migration, `reflectionContent` helper
- `observationsToPromptLines`, observation entry `ObservationEntryData` with
  `coversFromId` / `coversUpToId`, boundary-based observation collection
- Branch utilities: `findLastCompactionIndex`, `getMemoryState`,
  `collectObservationsByCoverage`, `rawTokensSinceLastBound`,
  `rawTokensSinceLastCompaction`, `firstRawIdAfter`, `gapRawEntries`,
  `rawTailEntriesBetween`
- Bootstrap mode under `turn_end` (deferred backlog to VCC)
- Fail-closed compaction on gap-observer failure (intentional defensive design
  upstream — we preserve this despite carrying VCC as a fallback)
- `passive` config option / `MEMORY_ID_PATTERN` (`/^[a-f0-9]{12}$/`)

Where we diverged from this commit:
- We bundle the OM subsystem with pi-vcc under a single unified summary
  (`mergePipelines`), so the OM subsystem no longer owns the final summary.
- We use `completeSimple` (JSON) for reflector / pruner instead of `agentLoop`
  (still TODO — flagged as architecture concern #9).
- `reflectionContent` lives in `om/compaction.ts` (local) rather than in
  `types.ts` (where the reference has it).
- Upstream generates deterministic SHA-256-derived 12-character hex IDs and
  validates with `/^[a-f0-9]{12}$/`. This project currently generates
  12-character base-36 timestamp/counter IDs, so its runtime contract is
  `/^[a-z0-9]{12}$/` for backward compatibility with persisted sessions.

## pi-vcc (primary design reference for the VCC subsystem)

- Repo: https://github.com/sting8k/pi-vcc.git
- Branch: `master`
- Commit: `9a710489973a0dca92810c1de672159f56fc8c9e`
- Author date: 2026-04-26 14:55:36 +0700
- Subject: "Update demo gif"

What we ported from this repo:
- Transcript normalizer (`vcc/normalizer.ts`), section extractor with
  `HEADER_NAMES` (`Session Goal`, `Files And Changes`, `Commits`,
  `Outstanding Context`, `User Preferences`), formatter, merger, transcript
- `mergeVccSummaries` with `mergeSection` (per-section caps: Session Goal 8,
  Commits 8, other sections 15) and `mergeFileLines` (Modified / Created /
  Read dedup, 10-path cap per category)
- `buildBriefSections` / `stringifyBrief` / `capBrief` with `Intl.Segmenter`
  word-wrapping, bash compression, tool one-liners, stop-word filtering
- `formatVccSections` with `RECALL_NOTE` block
- First-class `previousSummary` passing into the LLM (`previousSummaryUsed`
  recorded) — we honour this via `mergeVccSummaries`

Where we diverged from this commit:
- Dropped `transcriptEntries` field from `SectionData` (always emptied in our
  bridge code — confirmed unused, removed in cleanup).
- Dropped `FileOps` interface (unused; the bridge code accumulates file paths
  into arrays directly).

## pi-request-inspector (TUI overlay pattern reference)

- Repo: unrecorded local clone (no remote set in our reference clone)
- Branch: `main`
- Commit: `6786b67199bb61d69c4e5f0164663bc255b3ef1c`
- Author date: 2026-05-05 03:43:06 +0800
- Subject: "Update README"

What we took inspiration from:
- Full-screen `ctx.ui.custom()` overlay pattern with `OVERLAY_OPTS`
  (width 92%, maxHeight 92%, anchor center)
- `row()` helper for border padding, dynamic width math via `visibleWidth`
- Scrolling list → detail view with offset / sel clamping and live percentage
- Mouse wheel handling (`button === 64` up, `65` down)

## Future re-syncing ritual

When `reference/` is restored and `git pull`ed, diff the relevant subsystem
against the recorded commit to refresh:

```sh
cd reference/pi-observational-memory && git diff a6dcea6..HEAD -- src/
cd reference/pi-vcc && git diff 9a71048..HEAD -- src/
cd reference/pi-request-inspector && git diff 6786b67..HEAD
```

When evaluating changes, favour minimal, backwards-compatible adoption of
upstream wins (coverage tags, reflection strengthening, structured fields,
TUI patterns) — same philosophy as the prior merge sessions.

Dated comparison reports live in [`docs/upstream-reviews/`](./docs/upstream-reviews/).