# Stabilization Sweep: Engine Bugs + Skills Gaps

**Date:** 2026-04-09
**Issues:** #1061, #1062, #1063, #1064, #1065, #1066, #1067, #1068, #1069, #1070
**Type:** Bug fix + docs stabilization
**Branch:** `fix/stabilization-sweep`

## Problem

Ten open issues span four independent code areas. Six are MCP engine bugs that block or degrade real workflow runs (especially cross-repo basileus workflows). Four are skills/docs gaps where skill instructions have drifted from engine reality, causing agent misbehavior.

## Approach

Single branch, single PR. Four parallel sub-tasks targeting non-overlapping file sets.

## Sub-Tasks

### T1: Event Store Fixes (#1061, #1062)

**Files:** `servers/exarchos-mcp/src/event-store/`, `servers/exarchos-mcp/src/views/workflow-state-projection.ts`, `servers/exarchos-mcp/src/format.ts`

**#1062 — append returns sequence:0**

`handleEventAppend()` in `event-store/tools.ts` calls `store.appendValidated()` which correctly assigns the sequence number and returns the full event. The response is built via `toEventAck()` (format.ts:50) which extracts `{ streamId, sequence, type }`. The bug is likely that the ack is constructed from the *input* event (sequence undefined/0) rather than the *stored* event returned by `appendValidated()`.

**Fix:** Ensure `toEventAck()` receives the event returned by `appendValidated()`, not the pre-append input. Add a test asserting returned sequence > 0.

**#1061 — team events not projected into `_events`**

In `workflow-state-projection.ts:264-275`, `team.spawned`, `team.disbanded`, and all `team.*` events fall through to a no-op case that returns state unchanged. They are never accumulated into the `_events` field.

**Fix:** Add projection logic for `team.spawned` and `team.disbanded` that appends them to the `_events` array (or map keyed by event type). This unblocks the `all-tasks-complete+team-disbanded` guard that checks `_events` for the delegate-to-review transition.

---

### T2: Orchestrate Polyglot (#1063, #1068)

**Files:** `servers/exarchos-mcp/src/orchestrate/post-delegation-check.ts`, `servers/exarchos-mcp/src/orchestrate/reconcile-state.ts`, `servers/exarchos-mcp/src/orchestrate/pre-synthesis-check.ts`

**#1063 — STATE_FILE_NOT_FOUND for MCP-managed workflows**

`parseStateFile()` in `post-delegation-check.ts:62` and `reconcile-state.ts:190` call `existsSync(stateFile)` and fail when `stateFile` is `undefined` (MCP-managed workflows don't have state files on disk).

**Fix:** When `stateFile` is undefined/missing but `featureId` is provided, fall back to querying workflow state from the MCP event store via the existing `handleReconcileState()` in `workflow/tools.ts`. Extract the shared state-resolution logic into a helper: "resolve state from file OR MCP store."

**#1068 — pre_synthesis_check hardcoded for Node/npm**

`checkTestsPass()` in `pre-synthesis-check.ts:399` hardcodes `npm run test:run` and `npm run typecheck`. No project-type detection, no override parameter.

**Fix:** Add project-type detection by checking for marker files in `repoRoot`:
- `package.json` → `npm run test:run` + `npm run typecheck` (current behavior)
- `*.csproj` → `dotnet test`
- `Cargo.toml` → `cargo test`
- `pyproject.toml` → `pytest`

Also accept an optional `testCommand` parameter to override detection. If no marker file is found and no override is provided, skip with a warning rather than failing.

---

### T3: Task-Gate Behavior (#1069, #1070)

**Files:** `servers/exarchos-mcp/src/cli-commands/gates.ts`, `servers/exarchos-mcp/src/adapters/hooks.ts`

**Problem:** The task-gate hook runs `QUALITY_CHECKS` (gates.ts:26-41) on every `TaskUpdate` completion. These checks hardcode `npm run typecheck` and `npm run test:run`. Inside exarchos workflows, this is both redundant (workflow manages quality gates via review phases) and broken (non-Node projects fail, and the gate silently blocks TaskUpdate with no error feedback).

**Fix:** Option (a) from issue #1070 — disable the task-gate inside active exarchos workflows. When the gate detects an active exarchos workflow (check for workflow state via `featureId` or environment marker), return `{ continue: true }` immediately with a message: "task-gate: skipped (exarchos workflow manages quality gates)". Outside exarchos workflows, apply the same polyglot detection as T2 for the test commands.

Additionally, when the gate blocks a TaskUpdate, emit a clear error message to stderr (fixing the silent rejection in #1069).

---

### T4: Skills/Docs Alignment (#1064, #1065, #1066, #1067)

**Files:** `skills-src/delegation/SKILL.md`, `skills-src/synthesis/SKILL.md`, `skills-src/spec-review/SKILL.md`, `skills-src/quality-review/SKILL.md`

**#1066 — Review skills stale keys**

The spec-review and quality-review skills reference review state keys. The engine guard (`guards.ts:99-109`) accepts flat `reviews.spec-review` and `reviews.quality-review` (kebab-case). Skills must use these exact key names. Add explicit documentation that flat format with hyphenated skill name is required.

**#1067 — Synthesize skill missing events**

The `PHASE_EXPECTED_EVENTS` registry (`check-event-emissions.ts:28`) expects `stack.submitted` and `shepherd.iteration` events during the synthesize phase. The synthesis skill has no instructions to emit these. Add an "Event Emissions" section with `exarchos_event append` examples for both event types.

**#1064 — Delegation skill missing events**

The registry expects `team.spawned`, `team.task.planned`, `team.teammate.dispatched`, and `task.progressed` during the delegate phase. The delegation skill references runbooks that contain events, but the main SKILL.md lacks direct emission instructions. Add an "Event Emissions" section.

**#1065 — Delegation skill missing worktree schema**

The delegation skill shows a minimal worktree entry (`{ branch, taskId, status }`). The engine schema (`WorktreeSchema`) also supports `tasks: string[]` for multi-task worktrees. Document the full schema with both single-task and multi-task examples.

After all edits: `npm run build:skills` to regenerate `skills/` tree.

## Parallelization

```
T1 (event-store)     ─┐
T2 (orchestrate)     ─┤── all parallel, non-overlapping files
T3 (task-gate)       ─┤
T4 (skills/docs)     ─┘
```

T2 and T3 share the polyglot test-command detection concept. Extract a shared `detectTestCommand(repoRoot: string): TestCommand` utility used by both, implemented as part of T2 and consumed by T3.

## Testing

- **T1:** Unit tests for `appendValidated` sequence return, projection of `team.*` events into `_events`
- **T2:** Unit tests for project-type detection, integration test for MCP-managed state fallback
- **T3:** Unit test for workflow-aware gate bypass, stderr error emission on block
- **T4:** `npm run build:skills` + `npm run skills:guard` (no code tests, CI guard validates)

## Acceptance

All 10 issues resolved. Workflow runs from init through delegate→review→synthesize succeed for both Node and non-Node projects. No silent failures.
