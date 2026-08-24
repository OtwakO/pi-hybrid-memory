# Technical Report: Observer Cache-Busting Fix Review

**Repo:** `OtwakO/pi-hybrid-memory`
**Commits reviewed:** baseline `fec997c` ("feat: improve memory reliability and telemetry") → `50191ba` ("feat: optimize cache and context retention") → `a742ccc` ("feat: add cache-stable observer epochs", current `HEAD`)
**Author of this report:** an AI assistant (Claude), produced by static source reading only — no test execution, no production traffic observed after the fix. Treat every claim below as a hypothesis to confirm, not a verdict. Confidence labels are per-claim, not global.

## 0. Purpose

This report was produced outside your working context. It exists to give you (the agent doing the follow-up work) a second opinion on a specific problem, the fix applied for it, and further improvements worth considering — with enough detail to independently verify each claim rather than take it on faith. Where I quote code, re-read the live file first — line numbers drift.

**Confidence labels used below:**
- **Confirmed** — I read the exact code/line and the claim follows directly from it.
- **Inferred** — grounded in code I read, but depends on a control-flow path, runtime condition, or arithmetic I did not execute/measure end-to-end.
- **Unverified** — plausible based on available evidence but I have no direct proof; verify before acting.

## 1. Background (why this fix exists)

Original problem (observed in production telemetry, pre-fix): the observer LLM subcall (`src/om/observer.ts` + `src/observer-trigger.ts`) rebuilt its entire prompt from scratch on every invocation — system prompt + a **full, freshly-serialized dump of all prior observations/reflections** + the new conversation chunk, all as one throwaway one-shot call. Because the prior-observations dump grows/changes every invocation, no two consecutive observer calls shared a byte-identical prefix, so prompt caching never paid off across invocations (only within the 2-call tool-loop of a single invocation). This matched telemetry showing alternating full-price/cached-price call pairs, never sustained caching across invocations.

The fix (`50191ba`, `a742ccc`) introduces `ObserverEpochManager` (`src/om/observer-epoch.ts`): a persistent, append-only conversation history for the observer that survives across invocations, and only rebuilds ("cold-resets") on specific triggers instead of every call.

**Confirmed** (via direct diff `fec997c..a742ccc`): this is a real architectural change, not a config/parameter tweak — it changes what gets sent on the wire, not just how often.

## 2. What appears solid — verify, don't just accept

### 2.1 `ObserverEpochManager` core state machine (`src/om/observer-epoch.ts`)

Maintains `state.messages: Message[]` across calls. On `prepare()`, decides cold-vs-warm via, in order:
1. no existing state → cold, reason `initial`
2. `compatibilityKey` mismatch (model/provider/prompt-version changed, see `observerCompatibilityKey` in `src/om/observer-context.ts:36-43`) → cold, reason `compatibility-change`
3. `coverageEndId !== expectedCoverageId` (line ~130) → cold, reason `coverage-discontinuity`
4. warm projected tokens > `maxTokens` → cold, reason `capacity`
5. otherwise → warm, reuse `state.messages` as-is, append only the new delta message

**Confirmed**, and this is the correct high-level shape for solving the original problem: it makes the "stable" part of the prompt genuinely byte-identical and append-only across calls instead of reconstructed, which is the precondition for *any* prompt-caching mechanism (implicit hash-based or explicit `cache_control`) to work across calls, not just within one.

`commit()`/`validateCommit()` reject a commit whose actual returned transcript doesn't start with what was prepared, and reject stale transactions (`transactionId !== transactionCounter`) if `invalidate()` fired mid-flight. **Confirmed** as a reasonable defensive check against concurrent/aborted-run corruption — **worth a concurrency test**: two overlapping `prepare()` calls (e.g. observer-trigger firing while a compaction gap-catchup is also touching the epoch) should be traced to confirm this actually prevents corruption rather than just detecting it after the fact. I did not trace an actual concurrent scenario.

### 2.2 Epoch invalidation on compaction

`src/compaction-hook.ts` calls `runtime.observerEpoch.invalidate("compaction")` after compaction assembly completes. **Confirmed** this exists. **Inferred** that this is necessary and sufficient to prevent a warm epoch from surviving past a point where the observation/reflection set it was built against has been pruned or rewritten — I traced the call site but did not construct a test proving the *absence* of a stale-baseline bug after compaction. Recommend a test: run compaction (which prunes/merges observations), then trigger the observer again, and assert the epoch went cold and the new baseline text reflects the post-compaction observation set, not the pre-compaction one.

### 2.3 `fork()` usage in compaction's gap-catchup loop

`compaction-hook.ts` uses `runtime.observerEpoch.fork()` to get a draft copy before running the gap-catchup loop, rather than mutating the live epoch directly. **Confirmed** present. **Inferred** this is a good defensive choice (avoids partially mutating live state if the loop fails), and it's low-risk regardless because the live epoch gets invalidated by compaction immediately after anyway (§2.2) — so whether `fork()`'s result is ever merged back doesn't actually matter for correctness. Low priority to verify further.

### 2.4 Telemetry (`src/cache-telemetry.ts`, `/hm-cache-info`)

`cold`/`warm` label, `epochRunIndex`, `resetReason`, predicted-vs-projected tokens are now surfaced per call. **Confirmed** present and wired through both call sites. This is the single most useful thing to actually run and look at — it tells you empirically whether warm reuse is happening in your real traffic, which is more trustworthy than anything in this report. Several claims below (§3, §5) depend on data this telemetry can directly confirm or refute — **run it before acting on those sections.**

## 3. Bug candidate — needs verification, not yet reproduced

### 3.1 Self-referential `expectedCoverageId` in `compaction-hook.ts` gap-catchup loop

Two call sites feed `expectedCoverageId` into `ObserverEpochManager.prepare()`:

**`src/observer-trigger.ts:64,119`** — derives it independently from the actual branch state:
```js
const boundaryId = entries[lastBoundIdx]?.id;   // computed from lastObservationCoverEndIdx(entries)
...
expectedCoverageId: boundaryId,
```
This is an external, ground-truth check: it validates the epoch's remembered position against what the branch actually says.

**`src/compaction-hook.ts:121-124`** — derives the *initial* value for its loop like this:
```js
let expectedCoverageId = draftEpoch.stats().coverageEndId
  ?? memoryState.pendingObs.at(-1)?.sourceEntryIds?.at(-1)
  ?? memoryState.committedObs.at(-1)?.sourceEntryIds?.at(-1)
  ?? firstKeptEntryId;
```

**Claim (Inferred, not reproduced):** when the epoch already has warm state, `draftEpoch.stats().coverageEndId` returns non-null, so `expectedCoverageId` is populated **from the same state object that `prepare()` is about to compare it against**. The comparison in `observer-epoch.ts:130` (`this.state.coverageEndId !== input.expectedCoverageId`) becomes a tautology in this call path — it cannot detect a real discontinuity, because both sides of the comparison trace back to the same value.

**Why this would matter if true:** the coverage-discontinuity check exists specifically to catch cases where the branch advanced in a way the epoch doesn't know about (race, pruning, branch switch). If the fallback makes this check a no-op whenever warm state exists, a genuinely stale/inconsistent warm epoch could be extended instead of correctly cold-reset, during exactly the code path (compaction's gap-catchup) that runs at a moment when the underlying data is most likely to have shifted.

**What I did NOT verify:** I did not construct a scenario where `memoryState`'s actual position diverges from the live epoch's `coverageEndId` at the moment gap-catchup runs, so I don't know if this is reachable in practice, or if some other invariant elsewhere in the codebase prevents that divergence from ever occurring. `tests/observer-epoch.test.ts` unit-tests `ObserverEpochManager.prepare()` correctly with independently-supplied `expectedCoverageId` values (e.g. `"raw-0"`, `"raw-1"`, `"other"`) and confirms the discontinuity logic works **in isolation** — so this is not a bug in the class itself, only (possibly) in how one of its two callers feeds it input. There is no existing test covering this specific integration path.

**Recommended verification:** write an integration test (or trace by hand) where: (a) the observer epoch has live warm state from a prior `observer-trigger.ts` run, (b) something changes the branch's actual coverage position before compaction's gap-catchup runs (e.g. simulate a prune or a manual branch edit), (c) assert whether `prepare()` inside the gap-catchup loop detects `coverage-discontinuity` or silently proceeds warm. If it silently proceeds, this is confirmed as a real bug; if some other invariant makes divergence impossible at this call site, downgrade this to a non-issue and note why for future readers.

**Suggested fix if confirmed:** derive the initial `expectedCoverageId` for the gap-catchup loop the same way `observer-trigger.ts` does — independently from the actual current branch/`memoryState` position (e.g. the raw entry immediately preceding `gap[0]`) — falling back to the epoch's own remembered state only when no independent source exists.

## 4. Known limitation (not a bug in this repo) — provider caching capability gap

Source: `@mariozechner/pi-ai@0.66.1`, pulled via `npm pack` from the public registry on 2026-08-24. **Your project may pin a different version — check `package.json`/lockfile and re-verify against the actual installed version before relying on this.**

**Confirmed** (via `grep` across `dist/providers/openai-completions.js`): `sessionId` and `cacheRetention` — the two options this extension passes via `src/cache-options.ts` — do not appear anywhere in that file. They are not mapped to any OpenAI-specific caching parameter (e.g. `prompt_cache_key`). For OpenAI-completions-shaped models, caching is fully implicit/automatic on the provider's side; this extension's cache options are inert for that provider path.

**Confirmed** (via reading `dist/providers/anthropic.js:688-709`): for Anthropic-shaped requests, `cache_control` **is** implemented, but it is unconditionally placed on the last block of the last message only — there is no way, through this library version, for the extension to mark an explicit cache boundary earlier in the prompt (e.g. right after the stable baseline and before the volatile delta).

**Why this matters for interpreting results:** the epoch redesign (§2) fixes the *self-inflicted* cache-busting (byte-identical, append-only prefix across calls) — that part is fully within this repo's control and is a real fix regardless of provider. But whether that fixed prefix actually gets served from cache on a given call still depends on the provider's own cache retention window, which this library gives you zero control over for non-Anthropic providers, and only last-message placement for Anthropic. If gaps between observer invocations are long, warm epoch reuse may still miss on the provider side even though the extension is now doing everything right on its side. **This is worth measuring, not assuming** — check `/hm-cache-info`'s `cache read`/`hit` numbers against the `cold`/`warm` epoch label after running real traffic: if you see `warm` epoch calls with `hit: 0.0%`, that's the provider-TTL ceiling, not a bug in this repo.

## 5. Configuration defaults review

You asked me to double-check whether current defaults (`src/config.ts:14-26`) already reflect the epoch redesign, or still need reconsideration. Here's what's actually there right now:

```js
export const DEFAULT_HYBRID_SETTINGS: HybridSettings = {
  observationThresholdTokens: 1000,
  observerChunkMaxTokens: 60000,
  observerEpochMaxTokens: 96000,   // new in this fix
  compactionThresholdTokens: 50000,
  compactionThresholdPercentage: 80,
  reflectionThresholdTokens: 30000,
  ...
};
```

**Confirmed** (via diff `fec997c..a742ccc` on `src/config.ts`): only `observerEpochMaxTokens` was added. `observationThresholdTokens` and `observerChunkMaxTokens` are carried over **unchanged** from before the epoch redesign — neither was revisited alongside it.

### 5.1 The one I'd actually push on: `observerChunkMaxTokens` (60,000) vs `observerEpochMaxTokens` (96,000)

**Inferred, not measured — verify via `/hm-cache-info` `resetReason` frequency before acting.**

`observerEpochTokenLimit` (`observer-context.ts:45-48`) computes the *effective* ceiling as `min(96000, 40% of the observer model's context window)` — so for a smaller-context observer model, the real cap can be well under 96k. Fixed overhead is `6144` (hardcoded, see also §6). A single delta chunk can be as large as `observerChunkMaxTokens` (60,000), before the epoch even starts appending.

Do the arithmetic: `6144` (fixed) `+ 60000` (one large delta) `= 66,144` out of a `96,000` ceiling — a **single** turn-sized chunk can consume roughly two-thirds of the entire epoch's capacity by itself. The original problem logs that motivated this whole fix showed real per-turn observer chunks in the 30,000–38,000 token range (large tool-call-heavy turns). At that size, the epoch likely has room for only **one to three warm appends** before a `capacity` reset forces it cold again — in exactly the workload that made this fix necessary in the first place.

This doesn't mean the fix doesn't help — going from "cold every single call" to "cold every 2-3 calls" is still a real improvement. But it means the *achievable* warm-hit rate under realistic tool-heavy usage may be well short of what the design implies, unless these two numbers are reconsidered together. I'd flag this as the most concrete, checkable thing in this whole report: **query `/hm-cache-info` for how often `resetReason: capacity` appears relative to `coverage-discontinuity`/`compatibility-change`. If `capacity` dominates, this ratio is the reason, and is worth fixing directly** — either by lowering `observerChunkMaxTokens` to something meaningfully smaller than the epoch ceiling (so multiple turns can accumulate before a reset), or raising `observerEpochMaxTokens` where the observer model's context window allows it, or both.

### 5.2 `observationThresholdTokens` (1,000) — unchanged, and I don't think it interacts with §5.1 the way it might look like it should

It's tempting to think lowering this would also shrink individual chunk sizes and help §5.1. **I don't think that's right** — this threshold gates *when* the observer fires (checked at `turn_end`), not how large the resulting chunk is. Because it's only evaluated once per full agent turn, and a single tool-heavy turn routinely produces far more than 1,000 tokens before `turn_end` ever fires, the threshold is very likely already satisfied trivially on almost every turn regardless of its exact value — so tuning it up or down probably doesn't change chunk size, only how many turns get skipped between firings (and turns rarely get skipped, since the threshold is so low relative to typical turn size). I raised this same point three turns before the epoch redesign existed and reasoned in the *opposite direction* (raise it, to reduce total call count) — that reasoning assumed the old always-cold design, where fewer calls meant fewer full-price rebuilds. Under the new design, more frequent, smaller-delta calls are plausibly *better* (more of the spend lands in the cheap warm-append bucket), provided §5.1's capacity ceiling isn't already the binding constraint. **This value was not reconsidered during the epoch redesign, and I don't have high confidence in either direction for it now — it needs an actual A/B against `/hm-cache-info`'s warm-hit rate, not another guess from me.**

### 5.3 `reflectionThresholdTokens` (30,000) and `compactionThresholdTokens` (50,000) — not coordinated with the new epoch capacity at all

**Confirmed** by absence: there is no code path where `observerEpochMaxTokens`/capacity resets are aware of `reflectionThresholdTokens`, or vice versa. They track different quantities — reflection threshold tracks accumulated *observation* tokens, while epoch capacity is consumed mostly by *raw delta chunk* text, which is far heavier per unit of information. Numerically `30,000 < 96,000` might look like reflection would always run well before the epoch ever gets tight, but because they're measuring different pools, that's not a safe inference — see the arithmetic in §5.1: raw delta accumulation alone can hit the epoch ceiling within a couple of large turns, independent of how many *observations* have accumulated. This is the config-level version of Recommendation #1 below (§6.1) — the two systems were extended in parallel without being made aware of each other, and nothing in the current defaults changes that.

**Summary of §5:** the epoch redesign added exactly one new tuned value (`observerEpochMaxTokens`) and did not revisit the two pre-existing values (`observationThresholdTokens`, `observerChunkMaxTokens`) that interact with it. §5.1 is the one I'd verify first — it's checkable in one `/hm-cache-info` query and has a plausible mechanism, not just a hunch.

## 6. Recommended architectural improvements (beyond the current fix)

These are forward-looking, not things I found broken — ranked by how directly they avoid trading memory quality for cache efficiency. None of these have been built or tested; they're worth considering, not a to-do list.

### 6.1 Coordinate epoch capacity with reflection triggering — highest leverage, and directly follows from §5.1/§5.3

**Unverified — proposal, not a finding.** Right now `observerEpochMaxTokens`, `reflectionThresholdTokens`, and `compactionThresholdTokens` are three independent thresholds (§5.3). If the observer epoch is approaching its capacity ceiling on a large, raw, un-reflected observation list, triggering reflection *proactively* at that point — rather than waiting for the independent `reflectionThresholdTokens` cycle — means the next cold reset happens against an already-compressed baseline (reflections are deliberately deduplicated/synthesized, per `PRUNER_PROMPT`'s subset/restatement removal). This is one of the few changes here where cost and quality point the same direction instead of trading off: a smaller reset **and** less redundant content baked into it, for free. Worth building only if §5.1's `/hm-cache-info` check confirms `capacity` resets are actually frequent — if they're rare, this is solving a problem that isn't happening.

### 6.2 Split the baseline into a reflections tier and an observations tier as separate messages

**Unverified — proposal.** `observerBaselineText` (`observer-context.ts:12-22`) currently concatenates reflections + observations into one string, fully re-embedded on every cold reset. Reflections change far less often than the observation list. Separating them into two messages would let 6.1's capacity check be sized against just the fast-growing observations tier, and gives implicit prefix-hash caching a cleaner shot at reusing the near-static reflections block across cold resets even when the observations block differs.

### 6.3 Dedup identical/near-identical raw content within a chunk before it reaches the observer

**Unverified — proposal, and I did not check whether `serializeSourceAddressedBranchEntries` (`src/om/serialize.ts`) already does this.** In a tool-heavy harness, re-reading the same file or re-running the same command within a short window is common. If exact-duplicate raw tool-output blocks aren't already collapsed (or replaced with a short reference to the earlier occurrence), doing so shrinks the volatile, inherently-uncacheable new-chunk portion directly — the dominant cost — without omitting any information the observer needs. This is a pure win, not a tradeoff, if it isn't already happening. **Check `serialize.ts` first; this may already be solved.**

### 6.4 Add baseline-size / reset-frequency trend tracking to `/hm-cache-info`

**Unverified — proposal.** Not an architecture change, a monitoring one. This is what would let you *notice* the §5.1-style capacity pressure, or the unbounded-baseline growth noted in the original review, before either shows up as a cost spike, rather than inferring it from static code reading the way this report has to.

## 7. Minor items (low priority, quick to check)

- `fixedTokens: 6_144` is a hardcoded magic number duplicated in both `observer-trigger.ts` and `compaction-hook.ts`. If `OBSERVER_SYSTEM` or the tool schema in `observer.ts` changes size later, both sites need updating in sync, or the effective budget silently drifts. Consider deriving this once and sharing it.
- In `compaction-hook.ts:121-123`, the fallback chain checks `memoryState.pendingObs.at(-1)` before `memoryState.committedObs.at(-1)`. **Unverified** whether this ordering (pending assumed more recent than committed) matches the actual semantics of those two arrays elsewhere in the codebase — a quick grep of where `pendingObs`/`committedObs` are populated (`src/om/branch.ts`, `getMemoryState`) should confirm or refute this in under a minute.

## 8. Orthogonal, unrelated to caching — `src/merge/budget.ts`

New in this diff, not part of the caching fix: a priority-ordered trim-to-budget function for the compaction summary (transcript lines → low-relevance → medium-relevance observations → VCC sections → high-relevance observations → remaining sections, in that order). **Confirmed** it never trims `critical`-relevance observations, and signals genuine overflow via a `protectedOverflow` flag rather than silently dropping load-bearing facts once all other trim levers are exhausted. This looked sound on read-through; I did not stress-test it against pathological inputs (e.g. a session with only `critical` observations that alone exceed the budget).

## 9. Suggested priority order

1. Query `/hm-cache-info` for `resetReason` distribution — this single check confirms or denies §5.1 (the capacity/chunk-size ratio concern), which is the most concrete, actionable finding in this report, and tells you whether §6.1 is worth building at all.
2. Verify §3.1 (`expectedCoverageId` self-reference) — cheap to check, directly affects whether the safety net the epoch design depends on actually works during compaction.
3. Run real traffic and compare `cold`/`warm` labels against actual `hit %` — separates "still failing due to §4 (provider TTL, out of this repo's control)" from "still failing due to something in this repo."
4. §6.1–6.4 and §7–§8 are lower urgency; revisit based on what #1–#3 actually show.

## 10. What this report explicitly does not cover

- No load/concurrency testing was performed (§2.1's concurrency question is open).
- No production telemetry from *after* the fix was reviewed — all conclusions about the fix's design, including §5.1's capacity-ceiling arithmetic, are from static reading and reasoning, not observed cache-hit-rate or reset-frequency data.
- Only `@mariozechner/pi-ai@0.66.1` was inspected for provider behavior; re-verify against your actual pinned version.
- I did not check whether `src/om/serialize.ts` already implements the deduplication described in §6.3.
- I did not review `src/vcc/formatter.ts`, `src/vcc/merger.ts`, or the test diffs in detail beyond confirming they exist and relate to the budget/formatting changes in §8 — if those matter to your task, read them directly rather than relying on this report.
