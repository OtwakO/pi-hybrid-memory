# Codebase Architecture & Engineering Guidelines

## Core Philosophy
Write practical, maintainable code. No over-engineering. Every decision should reduce future
friction, not demonstrate cleverness. These guidelines apply to any language, framework, or stack.
When a specific tool or convention is unavailable, apply the spirit of the rule with what is available.

## Definition of Done
A task is only complete when all of the following are true:
- Tests written and passing for the work completed
- No new warnings, errors, dead code, debug statements, or hardcoded values introduced
- Relevant documentation updated (README, inline comments, interface descriptions)
- Project is in a runnable, non-broken state
- Committed with a meaningful message

A task that skips any item is not done. It is in progress.

## Handling Ambiguity
- When requirements are unclear or would affect architecture, stop and ask before proceeding.
  Do not silently assume and build.
- **Ask early, ask once**: consolidate all open questions into a single exchange before starting.
  Identify all blockers upfront, not one at a time.
- **What warrants asking**: stack choices, data model design, API contracts, auth approach,
  third-party service selection, and any decision that would be expensive to reverse.
- **What does not warrant asking**: internal naming, file structure, implementation details,
  and anything cheap to change later. Make a sensible call and move forward.
- When an assumption is necessary, state it explicitly before acting:
  "Assuming X because Y — let me know if this should be different."
- Prefer reversible decisions over irreversible ones when uncertain.

## Planning Before Coding
- Before writing any code for a new project or significant feature, produce a brief written plan:
  directory structure, key modules, data flow, and interface contracts. Commit this as the
  first artifact (e.g. initial README or ARCHITECTURE.md).
- Do not start implementation until the structure is clear. Structural mistakes in early commits
  compound into every file that follows.
- If scope is unclear, implement the smallest slice that proves the architecture works before
  building out the rest.

## Project Structure
- Decide and document directory structure before writing code. It must not evolve organically.
- Group by feature/domain, not by file type. Keep model, logic, and tests for a domain together.
  This enforces locality of change.
- A single canonical entry point must be obvious from the project root.

## Modularity & Structure
- Each module/file owns one responsibility and does it completely.
- **Deep modules, simple interfaces**: rich internal logic behind minimal, stable public APIs.
  Prefer fewer, well-designed functions over many shallow wrappers.
- **Locality of change**: a feature or fix should touch as few files as possible, ideally one.
  If a change ripples across 5+ files, the boundaries are wrong.
- Modules depend downward (on utilities/primitives), never sideways or upward.
  Circular dependencies are forbidden.

## Coupling & Cohesion
- **Low coupling**: modules communicate through explicit interfaces or contracts, never by
  reaching into each other's internals.
- **High cohesion**: everything inside a module is tightly related. If two things share a file
  but nothing else, split them.
- If a file exceeds ~300 lines or handles more than one concern, refactor it.

## Interface Design
- Inputs and outputs must be explicit and typed, or clearly documented in dynamic languages.
  No implicit global state, no hidden side effects.
- Functions do one thing. If the name contains "and," split it.
- Fail loudly and early. Never silently swallow errors.

## Backward Compatibility & Interface Changes
- Treat any public interface as a contract. Breaking it requires an explicit migration path.
- Deprecate before removing: mark the old interface, provide the replacement, remove it later.
- Internal interfaces can change freely — this is the payoff of low coupling.

## Error Handling
- One error handling pattern for the entire project, used consistently. Never mix strategies.
- Errors must carry enough context to identify root cause without a debugger.
- Distinguish recoverable errors (handle gracefully) from unrecoverable ones (crash fast, log everything).
- All external I/O must have explicit error handling and timeouts. Never assume success.

## Test-Driven Development (TDD)
- **Default to TDD**: write a failing test before implementing any non-trivial logic.
  Red → Green → Refactor → Commit.
- Tests are part of the commit, not an afterthought. A feature is not done until tested and passing.
- **Test at the right level**: unit test isolated logic; integration test system boundaries;
  end-to-end test only critical paths. Don't over-invest in E2E — slow and brittle.
- Tests must be deterministic. No randomness, time-dependent logic, or live external services.
  Mock or stub all I/O at the boundary.
- Test names are documentation. A failing test must describe exactly what broke without
  reading the body.
- **TDD limits**: exploratory spikes and UI layout may be written first, tested after —
  but must be tested before being committed as production code.
- Coverage is a floor, not a goal. Focus on critical paths, edge cases, and failure modes.

## Refactoring Discipline
- Refactor as a dedicated step, never mixed into a feature or bug fix commit.
- Triggers: duplication appearing a second time, a file approaching 300 lines, or a change
  requiring too many files to touch. Don't wait for pain.
- Refactoring must leave observable behavior identical. If tests change during a refactor,
  something is wrong.

## Git Discipline
- Commit at every significant step. If the work can be described as a unit, it is a commit.
- **The commit contract**: every commit leaves the project runnable with tests passing. No exceptions.
- **Commit message format** — `type: short description`:
  `feat: add auth module`, `fix: null response from payment API`, `refactor: split router`.
  No `wip`, `stuff`, or `update`.
- **Atomic commits**: one logical change per commit. Mixed concerns make reverts catastrophic.
- Tag stable milestones (MVP, feature-complete, pre-deploy) for unambiguous rollback points.

## Code Quality Baseline
- No dead code, commented-out blocks, or TODOs without an explanation.
- Consistent naming conventions decided before writing code and applied uniformly.
  Use a linter if one is available for the stack.
- All config and secrets in environment variables or config files. Never hardcoded.
- Tests live alongside the code they test, not in a distant folder.

## Idempotency
- Operations that create, modify, or delete state must be safe to run more than once without
  unintended side effects. Design for retry from the start.
- File creation, DB writes, and external API calls should check for existing state before acting,
  or be structured so repeating them produces the same result.
- Applies especially to setup scripts, migrations, and initialization code.

## LLM-Friendliness (AI Maintainability)
- Directory layout and filenames must make the project's purpose obvious without reading code.
- One-line comment at the top of each non-trivial file describing its role. For complex logic,
  explain *why*, not *what*.
- Target <250 lines per file. A file should be fully understandable in a single read.
- No hidden conventions or implicit magic. Behavior must be obvious from the call site.
- Every module exposes a clear public API. Internal helpers are kept private by convention
  or language feature where possible.

## Dependency Management
- Pin dependencies to exact versions where the stack supports it. No floating ranges in production.
- Every dependency is a long-term liability — justify it before adding.
- Prefer small, focused libraries. Avoid abandoned or unvetted packages.

## Observability
- Structured logging from day one in a consistent, parseable format. No plain concatenated strings.
- Log levels used consistently: DEBUG for noise, INFO for normal operations, WARN for degraded
  states, ERROR for failures requiring attention.
- Production errors must include enough context to reproduce: stack trace, relevant IDs, timestamp.
- Never log sensitive data — passwords, tokens, or personal information.

## Security Defaults
- All external input is untrusted until validated and sanitized. No exceptions.
- Auth checks happen at the boundary, not buried inside business logic.
- Secrets are never in source control, logs, or error messages.
- Be aware of common vulnerability classes for the stack in use: injection, insecure
  deserialization, path traversal, broken access control. These are default failure modes,
  not edge cases.

## Scalability Defaults
- Design for the next order of magnitude, not the next ten. Avoid premature optimization.
- Business logic has no knowledge of the transport layer (HTTP, CLI, queue, etc.).
  Keep I/O and compute separate.
- Core types and data shapes defined once, imported everywhere. No duplicated definitions.

## Documentation Baseline
- README must cover: what it does, local setup, how to run tests, how to run or deploy.
  Nothing more required, nothing less acceptable.
- Public interfaces must have a one-line description of purpose and any non-obvious behavior.
- Non-obvious architecture decisions recorded in the README or a dedicated `ARCHITECTURE.md`
  if the project warrants it.