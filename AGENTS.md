My GitHub Handle: [OtwakO](https://github.com/OtwakO)

You are running inside a sandboxed environment, /tmp directory is ephemeral and resets when session is closed. For files that would be used in future session and warrants persistency, properly organize, name, and store them under the project directory.

# Codebase Architecture & Engineering Guidelines

## Core Principles

Write practical, maintainable code. Match effort to the task — do not apply maximum process to
every change.

- Solve the requested problem with the smallest complete change.
- Keep the codebase easy to understand in parts, not just as a whole: a change should be
  understandable without reading the entire repository.
- Testing and review should build enough confidence to move forward, not eliminate every
  theoretical risk.
- Do not add features, abstractions, dependencies, refactors, or tooling because they might be
  useful later.
- If an optional improvement is worth doing, describe its benefit and cost first, and get
  confirmation before implementing it.
- Only expand scope beyond what was asked when it's required for correctness, security, data
  integrity, or to keep the project runnable.
- When unsure, prefer the option that's easier to reverse later.
- If a simpler approach meets the request, say so before implementing something more complex —
  even if the request described the complex version.

## Design Approach

Pick the plainest approach that solves the actual problem. Between two working solutions, prefer
the one a future reader would recognize immediately over the one that's clever or impressive.

### Picking a design
Start with the simplest tool available: a function, a conditional, a small data change. Only reach
for a named design pattern when the problem already has the shape that pattern exists to solve.

A few common patterns as examples of the rule, not the full list:
- Several interchangeable behaviors chosen at runtime → an interface with a few implementations
  (what "strategy" is for).
- Object construction with several genuinely different valid configurations → a factory or
  builder.
- Several independent things need to react to one event → an observer or event system.
- Two incompatible interfaces need to talk to each other → an adapter.

The same test applies to any other pattern too — decorator, command, chain of responsibility,
repository, dependency injection, memoization, and so on: use it when the problem already has that
pattern's shape, skip it when it doesn't. Different parts of the same codebase can and should end
up using different patterns, because they have different problem shapes. Match the pattern to the
problem actually in front of you — don't pick one from memory because it seems like good practice.

If the problem doesn't match any pattern's shape, use the plain version instead. These are signs a
pattern was added for its own sake rather than because the problem needed it — remove it and use
the direct version:
- An interface, abstract class, or config option with exactly one real implementation or value,
  and no second one actually planned.
- A layer whose only job is to call the layer beneath it unchanged.
- Something built to be generic or configurable for a case nobody has asked for yet.

Build for the case in front of you. Generalize once a second real case actually shows up, not
before.

### Fix the cause, not the symptom
When something is broken, find out why before deciding how to fix it. A fix that doesn't explain
the root cause is a patch, not a fix.

Signs a fix is a patch instead of a real fix:
- It's a special case for one bad input or state, and another bad case that would need its own
  special case is easy to imagine.
- It catches, ignores, or silences an error without knowing why the error happened.
- It's applied where the symptom showed up, not where the bad data or bad state was actually
  produced.
- It's landing right next to another recent fix in the same area.

If any of these are true, trace back to where the problem actually starts and fix it there
instead.

Sometimes the real fix genuinely isn't possible right now — a third-party dependency, a hard
deadline, code you don't own. When that happens: say so explicitly, mark the workaround clearly in
the code (e.g. `# workaround: <reason>, real fix would be <what>`), and add an entry to
`DEVELOPMENT.md` so it isn't mistaken for the real fix later.

Never stack a new patch on an existing patch without first checking whether the original patch
should become the real fix instead.

## Matching Effort to Risk

Classify the current change into one of three categories before starting. This decides how much
planning, testing, and documentation the change needs.

### Small or Localized
Examples: a contained bug fix, a small script, a text or config change, a simple UI tweak.
- Read the file being changed and its direct callers or dependencies. Nothing more.
- Make the smallest safe change.
- Run the smallest test that covers it.
- No new architecture, no repo-wide review, no new abstractions.
- Update docs only if something durable actually changed.

### Standard
Examples: a normal feature, a behavior change, a change touching a few related files.
- Write one or two sentences on what "done" looks like before starting.
- Add or update tests for the new or changed behavior.
- Run the tests for the affected area first; only run more if something breaks or looks coupled.
- Update `PLAN.md` if scope, architecture, or next steps changed.

### High-Risk or Structural
Examples: migrations, auth/authorization, public API changes, shared data models, deployments,
destructive operations (delete, drop, overwrite), or anything flagged as sensitive.
- Write the plan down before touching code.
- Confirm any decision that would be expensive to undo.
- Document rollback and compatibility concerns.
- Use broader tests (integration or end-to-end) where the risk justifies it.
- Keep `PLAN.md` and `DEVELOPMENT.md` current as you go.

A change stays High-Risk because of what it touches, not how many lines it is — a one-line change
to a payments function is still High-Risk. Don't classify a change as High-Risk just because more
testing is *possible*; only because the risk is real.

## Definition of Done

A task is done when:
- The requested behavior works.
- The project (or the part you touched) still runs.
- The tests appropriate to the change's category above pass.
- No new warnings, dead code, debug prints, or unexplained TODOs.
- No secrets or hardcoded environment-specific values.
- Docs were updated if setup, usage, or interfaces changed.
- `PLAN.md` reflects any real change to scope, architecture, or state.
- `DEVELOPMENT.md` has an entry if something non-obvious happened worth remembering.
- Nothing unrelated was changed without asking first.
- A bug fix addresses the root cause — or, if it's a workaround, that's stated explicitly and
  logged (see Design Approach).

Not every task needs new tests, a full test run, a README edit, or a `DEVELOPMENT.md` entry — only
add what the category above actually calls for.

**Report what you actually did.** If you only ran the tests for one file, say "tests for X pass" —
not "tests pass." Never describe a partial test run as a full one.

## Handling Ambiguity

Stop and ask when the uncertainty would affect architecture, data shape, public interfaces, auth,
third-party service choice, a destructive operation, or anything expensive to undo.

- Batch your questions into one message if you have more than one.
- Don't ask about things you can infer from the existing code or conventions — just make the call.
- If a request is genuinely ambiguous, list the possible interpretations and ask which one is
  meant, rather than picking one silently.
- If you're about to guess on something consequential, stop and ask instead.

## Planning Before Coding

Before starting a new project, or a Standard/High-Risk feature, write down:
- What you're building and what "done" looks like
- Directory structure and what owns what
- How data flows and what the interfaces look like
- The main steps, in order
- Known risks or open questions

Group files by feature, not by file type — keep a feature's models, logic, and tests together.
There should be one obvious place to start reading from the project root.

For a Small/Localized change, skip all of this — just make the change.

## PLAN.md — current state

`PLAN.md` lives at the repo root and describes the project **as it is right now**, not its
history. Anyone — human or AI — should be able to read it and know where things stand without
reading the code first.

Include only the sections that apply:
- **Objective** — what this project does
- **Architecture** — how it's organized
- **Phases** — what's done, what's next, with clear completion criteria
- **Current state** — the exact stopping point if work is mid-way
- **Open questions** — unresolved decisions
- **Out of scope** — what's deliberately not being built
- **Constraints** — environment quirks, external dependencies

Create it before real implementation starts on a new project. For an existing project that
doesn't have one yet, create it the first time you start multi-step work — don't try to
reconstruct its whole history.

Update it whenever the objective, architecture, phase, current state, or a real decision changes.
Before every commit, check if `PLAN.md` is now stale — if it is, update it in the same commit.
Don't touch it for every small step; only when something durable actually changed.

## DEVELOPMENT.md — history

`DEVELOPMENT.md` lives alongside `PLAN.md` and keeps a record of things worth remembering that
aren't obvious from the code or commit history:
- A hard bug and how it was found and fixed
- A non-obvious decision and why it was made
- An approach that was tried and didn't work
- An environment quirk or workaround
- A limitation in how something was verified

Do not log routine edits, every command run, or a restated commit message. This file only earns
an entry when future-you, or another AI, would otherwise have to rediscover something the hard
way.

Use one short block per entry:
```markdown
### [YYYY-MM-DD] Short title
- **Context**: what you were doing
- **Change**: what changed
- **Reason**: why
- **Verified**: how you checked it
- **Watch out**: anything to be careful of later
```
Skip any field that doesn't add anything. Entries are never edited or deleted — add a new one
instead.

**The difference in one line: `PLAN.md` says what's true now. `DEVELOPMENT.md` says what happened
and why.** If a change affects both — e.g. a bug fix that also changes the architecture — update
both, in the same commit.

## Modularity, Coupling, and Cohesion
- Each file or module owns one clear thing, completely.
- Group code by feature, not by type (not all "models" in one folder and all "controllers" in
  another).
- Prefer a few well-designed functions or interfaces over many thin wrappers.
- Modules talk to each other through their public interface only — never reach into another
  module's internals.
- Dependencies flow in one direction. No circular dependencies.
- Avoid catch-all files: no `utils.py` / `helpers.js` that becomes a dumping ground, no single
  file that ends up knowing about everything.
- Define a shared type or data shape once. Don't redefine it in multiple places.
- If a normal change keeps touching many unrelated files, that's a sign the boundaries are wrong —
  fix the boundary, don't just keep editing around it.

### File Size
Aim for under roughly 250 lines per file as a guide, not a hard rule.

Split a file when:
- It's doing more than one job.
- You have to read unrelated code to understand the part you need.
- Unrelated changes keep colliding in it.
- A clear, self-contained piece of it could become its own module.

Don't split a file into tiny pieces just to hit a line count — that makes things harder to follow,
not easier.

### Shared Code
If something is used in more than one place — logging, config, validation, auth helpers, error
formatting — build it once behind a simple interface instead of copying it.
- Keep the setup and config details inside the shared module. Callers shouldn't need to know how
  it works internally.
- If you're not sure something will be reused, write it inline for now. Pull it out into a shared
  module once it's actually duplicated.
- Don't build a shared abstraction for something that might be reused someday — only for something
  that already is.

## Making Changes: Stay in Scope
- Only touch what the task needs.
- Only clean up things your own change introduced or broke — not pre-existing issues you happened
  to notice.
- Don't rename, reformat, or "modernize" code that isn't part of the task.
- Match the existing style around your change.
- Don't change existing public behavior unless that's the point of the task.

Before writing code, look at:
- The file you're changing
- Its public interface (what other code calls)
- Its direct callers
- Its existing tests
- Any shared types it uses

Only look at more of the repo if something is unclear or a test fails unexpectedly. Check
`PLAN.md` first for orientation instead of re-reading the whole codebase.

## Review
- For a Small/Localized change: review your own diff once — the changed lines, what calls them,
  and how they could fail. That's enough.
- Don't re-review the whole repo for a small change.
- Save a deeper, security-focused, or wider review for High-Risk/Structural work.
- Stop reviewing once you've caught the real risks — repeating the same check again doesn't add
  confidence.

## Interface Design
- Make inputs, outputs, and side effects explicit — use types if the language has them, otherwise
  document them clearly.
- A function should do one cohesive thing. Split it if it's doing two unrelated things — not just
  because its name has "and" in it.
- Avoid hidden global state and surprising side effects.
- If other code, or another team or service, depends on an interface, treat it as a contract:
  don't break it without a migration plan, and deprecate before removing.
- If an interface is internal and every caller can be updated in the same change, it's fine to
  change it directly.

## Error Handling
- Match the convention already used in that part of the codebase, layer by layer — e.g. exceptions
  inside business logic, typed results at a boundary, HTTP error responses in the API layer, exit
  codes in a CLI. Different layers can reasonably use different mechanisms; just be consistent
  within each one.
- Every error should carry enough information to know what failed.
- Know the difference between an error you can recover from (handle it) and one you can't (fail
  loudly, don't try to continue).
- Any external call — network, disk, another service — needs error handling and a timeout. Never
  assume it will succeed.
- Never swallow an error silently, and never report a partial success as if it fully succeeded.

## Testing

Tests should give enough confidence that the change works — not maximum possible coverage.

### What to run, in order
1. Run the smallest existing test that already covers what you changed.
2. Write or update a test for: the new behavior, the bug you fixed, or a real failure mode.
3. Run the tests for that file, module, or boundary.
4. Only go wider than that if: the targeted tests failed unexpectedly, you changed something
   shared, there's a real coupling risk, or the change is High-Risk.

Don't run the entire test suite, every linter, and every scanner for a small change by default.

### How many tests
Aim for the fewest tests that cover the real risk:
- One normal or expected case
- One real edge case or failure mode
- One regression test if you're fixing a bug
- One boundary test, if you changed how two parts talk to each other

Skip: near-duplicate tests, every possible input combination with no real risk behind them, tests
for implementation details that didn't change, and end-to-end tests where a smaller test already
proves it.

- Test isolated logic at the unit level.
- Test real boundaries (API, database, etc.) at the integration level.
- Reserve end-to-end tests for critical paths that can't be checked more cheaply.
- Reuse existing test setup and fixtures instead of building new ones for one test.
- Tests shouldn't depend on running in a specific order.

### Write the test first, or after?
Write the test first when the logic is non-trivial, you're reproducing a bug, or you're
protecting a public interface. For simple wiring, UI layout, config, or a Small/Localized change,
it's fine to write the code first and test right after.

### Keep test output short
- Run tests through the project's normal test command in quiet mode, not verbose mode.
- A passing run should look like one line, e.g. `5/5 passed`. Don't print a line per test.
- A failing run should show which test failed and why — the real error, not just "failed":
  ```
  4/5 passed, 1 failed
  Failed: test_name — expected X, got Y
  ```
- Only include a full stack trace or logs if the short message isn't enough to explain the
  failure.

### When to stop
Stop once the change is covered at a reasonable level and the tests pass. Adding another similar
test after that repeats the same confidence — it doesn't add new confidence.

### [Important] The general rules are:
- Design tests that are effective at covering the **real practical risks of the interested scope**.
- Tests should be deterministic, and **token efficient to write, run, and maintain**.
- Tests should be **repeatable** and **easy to run** in a repeatable way.
- Do not overfit tests to a specific test dataset, test runner, or test framework.
- Duplicated tests, repo-wide tests when the scope is small and added no real value, are a waste of token and time without offering any real confidence, that is just over-testing for no real gain.
- Tests should maximize confidence per test and per fixture token, not maximize test count.

## Refactoring
Only refactor when:
- You can't safely make the requested change without it.
- The existing structure is actively blocking the change.
- A file mixes clearly unrelated responsibilities.
- Real, existing duplication is causing bugs or maintenance pain.
- You're about to add a fix on top of a previous fix in the same area (see Design Approach).
- The user asked for it.

Keep it as small as it needs to be, and say why you're doing it. If a bigger refactor seems worth
it, describe the benefit and cost and ask before doing it — don't fold it into a feature or bug
fix commit.

Refactoring should not change what the code does. If tests need to change because of a
"refactor," it wasn't just a refactor.

## Git
- Start every new project with `git init` and a `.gitignore` (secrets, build output, dependency
  folders, editor files).
- Commit at each complete, working step — not every single edit, and not one giant commit at the
  end.
- Every commit should leave the project (or the part you touched) running, with its tests passing.
- Before committing, check if `PLAN.md` or `DEVELOPMENT.md` need an update, and include that
  update in the same commit.
- One logical change per commit — don't mix a feature, a fix, and a cleanup in the same commit.
- Commit message format: `type: short description` — e.g. `feat: add auth module`,
  `fix: handle null response`, `refactor: split router`.
- Tag a milestone (e.g. a release) only if the tag will actually be useful for rollback later.
- Don't push unless asked to, or unless that's the established workflow for this repo.

### Before anything destructive
These need explicit confirmation first:
- `git push --force` — use `--force-with-lease` instead, and only on a branch that's actually
  yours.
- `git reset --hard` on a shared or remote-tracked branch.
- `git rebase` on a branch that's already been pushed and shared.
- `git clean -fd` — always run `git clean -nfd` first to see what would be deleted.
- `git stash drop` or `git stash clear` — confirm nothing in there is still needed.

Never commit directly to `main`/`master` on a multi-person project — use a branch. Check
`git status` and recent history before any destructive command. Never discard changes that aren't
yours.

## Naming and Code Quality
- Names should explain themselves. Avoid cryptic abbreviations and single-letter names, except
  obvious cases like a loop index.
- Follow the naming style already used in the codebase.
- No dead code, commented-out blocks, debug prints, or unexplained TODOs.
- Keep secrets and environment-specific values out of the code — use config or env vars.
- Don't duplicate a constant that already exists elsewhere — reuse it.

## Idempotency
Anything that might run more than once by accident — setup scripts, migrations, retried API
calls, file generation — should be safe to run twice with the same result.

For things that genuinely can't be idempotent by nature (sending a payment, sending a
notification, incrementing a counter), use a dedup key or a transaction so a retry doesn't double
it up.

Don't build this kind of safety into a script that only ever runs once, by hand, one time.

## Subagents

**This section is about you — the model doing this task — deciding whether to hand part of it to
another agent.**

Default: zero subagents. Do the work yourself, in this same session.

Only delegate to another agent when:
- The work splits into pieces that don't depend on each other, and doing them one-by-one yourself
  would just waste time.
- The work is High-Risk, and a second, independently-formed opinion would catch something you
  might rationalize past — e.g. reviewing an auth change. Not for routine work.
- The files or history involved won't fit in your own context.

If you do delegate: give it the exact question, the smallest set of files it needs, and what you
expect back. Don't ask it to re-read the whole repo. Treat what it gives you as a claim to verify,
not a fact to trust automatically.

Don't delegate to look thorough. Don't split one task into "implementer" + "reviewer" +
"verifier" agents when one agent could safely do all of it. Stop delegating once you have enough
confidence to move on.

## Keeping Context Small
This is about repo-wide habits, not any one task:
- Name files and folders so their purpose is obvious without opening them.
- Keep public interfaces small.
- Keep a helper near the feature it supports, unless it's genuinely shared by several features.
- Use `PLAN.md` for orientation before reading code, and only the relevant `DEVELOPMENT.md`
  entries — not the whole file.
- Don't re-read a file whose content you already have and that hasn't changed.
- Run the targeted test before reaching for the whole suite.

None of this is permission to skip correctness, security, or a real interface concern — it's
about not doing more work than the task needs.

## Dependencies
- Every dependency is something you now have to maintain — justify adding one.
- Prefer small, actively maintained libraries over large or abandoned ones.
- If this project is an application you deploy, lock exact versions so it's reproducible.
- If this project is a library others import, declare a compatible version range for consumers,
  but still lock exact versions in this repo's own CI and dev setup.
- Don't upgrade or swap a dependency as a side effect of an unrelated change.

## Logging
- Set up one structured logging system for the project and use it everywhere — don't let each
  file invent its own format.
- A small one-off script can just print — it doesn't need the full logging setup.
- Use log levels consistently: DEBUG for detail, INFO for normal operation, WARN for something
  degraded but working, ERROR for something that needs attention.
- A production error log should have enough detail to know what happened without a debugger
  attached.
- Never log passwords, tokens, secrets, or personal data.

## Security

Apply real, specific protections — not a generic "sanitize everything" pass:
- Treat input as untrusted at the point it enters your system. Check its shape and constraints.
- Use the protection that matches where the data is going: parameterized queries for a database,
  escaping or encoding for HTML output, safe deserialization for untrusted data, path
  normalization for file paths.
- Check auth at a clear boundary (e.g. middleware, gateway) — not scattered inside business logic.
- Check authorization wherever the information needed to decide access actually lives.
- Never put a secret in source control, logs, or an error message.
- Know the common failure modes for your stack: injection, insecure deserialization, path
  traversal, broken access control.

**Match the effort to real exposure.** A local tool used only by you or a few trusted people
doesn't need rate limiting, CSRF protection, or fuzz testing — there's no realistic attacker in
that picture. A public-facing app handling real user data does need the standard protections
above, applied properly. Reserve deep threat modeling and dedicated security testing for the
actual high-risk cases: auth, payments, and anything touching regulated or personal data.

If you find a real, existing vulnerability while doing unrelated work, it's fine to fix or flag
it — but don't turn a small task into a full security audit on your own initiative.

## Scaling
- Design for roughly the next order of magnitude of load — not for a scale you don't have yet.
- Don't optimize before you've measured that something is actually slow.
- Keep business logic separate from the transport layer (HTTP, CLI, queue) so either can change
  independently.
- Define a shared data shape once, not once per module.
- Propose big changes — caching, concurrency, sharding, a new queue — and their tradeoffs before
  implementing them.

## Documentation
README should cover: what the project does, how to set it up, how to run it, how to run its
tests, and how to deploy it, if it deploys.

- `README.md` — for someone using or operating the project
- `PLAN.md` — current architecture, state, and next steps
- `DEVELOPMENT.md` — history worth remembering
- `ARCHITECTURE.md` — only if the architecture is too big to stay concise inside `PLAN.md`

Don't repeat information that's already obvious from the code or another doc.

## Wrapping Up a Task
Keep your final summary short:
- What changed
- What you tested, and at what level (see "Report what you actually did" above)
- Anything unresolved or limited
- Whether `PLAN.md` or `DEVELOPMENT.md` needs updating, and whether you already did it
- At most one or two optional follow-up ideas, clearly marked as optional

Don't narrate every step you took or list every passing test.
