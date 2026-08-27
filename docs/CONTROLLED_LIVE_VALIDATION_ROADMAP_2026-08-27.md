# Controlled Live Validation Roadmap

**Status:** Deterministic lifecycle trial passed; model-assisted trial remains

## Objective

Determine whether the current repository bundle is stable enough for actual usage by exercising it through Pi 0.84.3's real extension loader, RPC compaction command, persisted session journal, process restart, replay, and recall boundaries.

This milestone validates runtime integration. It does not change memory policy, lifecycle schemas, or the installed extension.

## Isolation contract

The trial must not modify the current installed Phase A extension or any real Pi session.

Run Pi with:

- `--no-extensions` to disable normal extension discovery;
- one explicit `-e <absolute repository bundle>` argument;
- `--session-dir <repository-owned evaluation directory>`;
- a dedicated working directory containing trial-only project settings and hybrid-memory config;
- `--approve` so only that disposable working directory's project settings are honored.

Pi's normal configuration directory remains available only for existing provider/model authentication. The trial must not write credentials or change global Pi settings.

All generated trial files live under the gitignored `evaluation-results/live-validation/` directory.

## Why the first trial is deterministic

The first live gate validates persisted V5 exact-duplicate retirement without depending on model judgment:

1. Seed a Pi session through Pi's exported `SessionManager` API.
2. Append normal message entries so Pi can prepare a real manual compaction.
3. Append canonical `hybrid-memory.observation` custom entries containing two exact-duplicate observations with distinct immutable IDs and provenance.
4. Set `reflectionThresholdTokens` above the fixture size so folding makes no model call.
5. Disable automatic compaction and trigger one manual RPC compaction.
6. Require the resulting V5 lifecycle details to contain exactly one `exact-duplicate` retirement and no semantic retirement.

The active projection must retain the earlier representative while both immutable observation IDs remain available to exact recall.

## Trial phases

### 1. Preflight

- Require a clean repository working tree except for the live-validation milestone itself.
- Require `pi --version` to report the supported 0.84.3 line.
- Require the production build to succeed.
- Record SHA-256 hashes for:
  - the repository bundle;
  - the currently installed extension bundle.
- Refuse to continue if the repository and installed paths resolve to the same file.
- Create a fresh trial root; never reuse a prior result directory for a write-enabled run.

### 2. Seed

Use `SessionManager.create(trialCwd, trialSessionDir)` and public append methods only.

Seed:

- multiple compactable user/assistant turns;
- one source message for each observation's provenance;
- two canonical observation records whose normalized content and relevance are equal;
- distinct observation IDs and source-entry IDs.

Do not construct raw JSONL lines by hand.

### 3. First process

Launch Pi RPC with only the repository bundle.

Verify:

- `get_commands` exposes `hm-status`, `hm-memory`, and `hm-cache-info`;
- replay reconstructs the exact immutable evidence and provenance inputs consumed by `hm_recall`; RPC exposes no direct named-tool execution command, so actual tool invocation remains for the model-assisted trial;
- auto-compaction can be disabled;
- manual `compact` succeeds through the extension;
- no `extension_error` event occurs;
- the compaction result is marked as extension-provided and contains strict V5 lifecycle details;
- exactly the later duplicate is retired by the earlier observation;
- the summary contains the active representative and excludes the retired duplicate ID/payload duplication.

Terminate the process cleanly after the compact response is durable.

### 4. Restart and replay

Launch a fresh Pi RPC process against the same isolated session file and repository bundle.

Verify:

- startup reports no extension error;
- `get_entries` returns the persisted custom observation entries and V5 compaction;
- replay exposes one active and one retired observation with no lifecycle diagnostic;
- recalling the active ID returns active evidence and original provenance;
- recalling the retired ID returns its immutable evidence, original provenance, `exact-duplicate` lifecycle state, and preserving observation ID;
- a second unchanged compaction emits no duplicate retirement event.

### 5. Rollback compatibility check

Without modifying the trial session, launch a third read-only/replay process using the backed-up Phase A installed bundle only if its hash still matches the preflight value.

Expected behavior is fail-closed compatibility, not state equivalence:

- the older bundle must not corrupt or rewrite the session;
- it may reject the non-empty retirement lifecycle batch and project the prior valid memory state;
- the diagnostic must be visible;
- the session file hash must remain unchanged by read-only inspection.

Do not perform another compaction with the old bundle.

### 6. Installed-state integrity

After the trial:

- the installed bundle hash must exactly match preflight;
- no file under the real Pi session directory may have been created or modified by the trial;
- generated files must remain under the trial root;
- the trial report records commands, bundle hashes, session hashes, lifecycle counts, diagnostics, and bounded failure details, but no credentials or raw provider responses.

## Pass criteria for actual-usage stability

The extension may be called stable for actual usage only when all of these pass:

1. repository tests, TypeScript, production build, and diagnostics are green;
2. isolated extension loading and command registration succeed;
3. manual compaction persists one valid V5 batch atomically;
4. exact-duplicate retirement is correct and idempotent;
5. restart reconstructs the identical active/retired projection;
6. active and retired IDs remain exactly recallable with provenance;
7. malformed/rejected lifecycle diagnostics remain visible and fail closed;
8. rollback inspection does not mutate the session;
9. installed bundle and real sessions remain byte-for-byte untouched;
10. a separate controlled model-assisted trial later validates observation catch-up/reflection behavior and process restart.

The first deterministic trial can establish lifecycle integration stability, but actual-usage stability also requires the later model-assisted boundary because normal operation includes observer and reflector calls.

## Failure policy

Any unexpected write location, extension error, invalid lifecycle batch, missing provenance, replay mismatch, duplicate retirement on repeat compaction, session mutation during rollback inspection, or installed-bundle hash change fails the milestone.

On failure:

- stop immediately;
- preserve the isolated trial directory for diagnosis;
- do not install the repository bundle globally;
- do not weaken lifecycle assertions to accept the result.

## Small implementation shape

Add one opt-in repository script under `evaluation/live-validation/`:

- `run.ts` owns preflight, disposable paths, process orchestration, and the final report;
- a small RPC client owns strict LF-delimited request/response handling;
- a fixture helper owns public-API session seeding;
- a pure verifier owns lifecycle/replay assertions.

Do not add a generic process framework, test runner, package installer, session database, or runtime code path. Routine `npm test` must not spawn Pi or make provider calls.

## Model-assisted trial design

The remaining gate uses a fresh isolated session and exactly three provider calls:

1. one compaction catch-up observer call;
2. one compaction reflector call;
3. one post-restart agent call that must invoke `hm_recall`.

The fixture seeds one canonical baseline observation so compaction does not enter bootstrap mode, then appends an uncovered durable assertion containing a unique exact marker, identifier, path, numeric value, and explicit long-lived constraint. Enough bounded filler is added to make Pi's normal compaction preparation valid. Automatic/proactive observation remains disabled by a high threshold; only compaction catch-up may observe the uncovered gap.

The trial passes only when:

- catch-up durably appends at least one new canonical observation;
- at least one new observation preserves every exact fixture detail and cites available source provenance;
- the reflector persists at least one valid reflection with canonical support;
- restart replay reports no lifecycle issue and reconstructs the same observations/reflections;
- a normal agent prompt explicitly requiring `hm_recall(<new observation id>)` emits a real `tool_execution_end` event for `hm_recall`;
- the tool result contains the exact durable marker and source provenance;
- the final assistant response does not replace tool evidence with an unsupported claim;
- no semantic retirement event is persisted;
- provider usage is recorded but raw provider responses are not stored;
- installed extension and real sessions remain unchanged.

Any empty observer result, missing exact detail, missing provenance, reflector failure/empty result, absent recall tool invocation, tool error, lifecycle warning, or unexpected write fails closed. Do not retry a failed provider call automatically inside the trial; preserve the isolated result for diagnosis.

## Completion checklist

- [x] Isolation and rollback contract documented.
- [x] Deterministic first-trial boundary selected.
- [x] Live-validation runner implemented.
- [x] Compact RPC client implemented.
- [x] Public-API session fixture implemented.
- [x] Pure persisted-session verifier implemented.
- [x] Dry-run preflight passes without launching Pi.
- [x] Deterministic write-enabled trial passes.
- [x] Restart/replay/idempotency checks pass.
- [x] Old-bundle read-only rollback inspection passes fail-closed.
- [x] Installed bundle and real sessions remain unchanged.
- [ ] Model-assisted observer/reflector trial passes.
- [ ] Extension declared stable for actual usage.

## Deterministic trial result

The passing isolated trial at `2026-08-27T08-35-55-589Z` exercised two real Pi RPC compactions with a process restart between them:

- exactly one `exact-duplicate` retirement was persisted across the complete V5 journal;
- the preserving observation remained active and the later duplicate remained immutable and retired;
- both observations retained one exact source entry;
- the second compaction emitted no duplicate retirement;
- no unexpected observer records were accepted by the deterministic verifier;
- replay reported no lifecycle issue;
- the Phase A bundle surfaced the expected rejected-batch warning when `/hm-status` forced projection;
- the read-only Phase A inspection left the session hash unchanged;
- the installed bundle SHA-256 remained `346f7f9a123976cb568cba5151627412b82a8a30afc5c37204fa28b31d89ac8b`.

An earlier trial correctly failed because Pi's default `keepRecentTokens` made the fixture too small to compact. A later intermediate trial revealed an incomplete coverage fixture by producing unexpected observer observations. Both findings were fixed at the fixture/orchestration boundary rather than bypassing Pi or weakening lifecycle assertions.
