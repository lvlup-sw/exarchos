# Implementation Plan: Remove Dead Team Coordinator

**Date:** 2026-02-16
**Type:** Refactor (overhaul track)
**Issue:** #368 (partial — team-related subset)
**State:** `~/.claude/workflow-state/refactor-team-coordinator.state.json`

## Summary

Remove the Exarchos team coordinator module and all supporting code. This module implements inter-agent messaging that never delivers messages — it just appends events to JSONL that nobody reads. Claude Code now has native Agent Teams with real bidirectional messaging. The Exarchos layer is ~1,300 LOC of dead abstraction.

**Preserved:** Task actions (claim/complete/fail), all workflow tools, all event tools, all non-team views.

## Spec Traceability

| Brief Goal | Tasks |
|---|---|
| Remove dead team coordinator module | T1 |
| Remove 5 team actions from orchestrate composite | T2 |
| Remove team-status-view and CQRS projection | T3 |
| Remove dead event types from schemas | T4 |
| Remove team action entries from registry | T5 |
| Update CLAUDE.md and delegation skill | T6 |

## Task Dependency Graph

```
T1 (delete team/) ─────────┐
T3 (delete team-status-view)┼──> T2 (strip orchestrate composite)
T4 (prune event schemas)    │       │
                            │       v
                            └──> T5 (strip registry + CLI tests) ──> T6 (update docs)
```

T1, T3, T4 are independent and parallelizable.
T2 depends on T1 (imports team handlers).
T5 depends on T2 (registry actions reference handlers).
T6 depends on T5 (final state must be buildable).

## Parallel Groups

| Group | Tasks | Can Run Simultaneously |
|---|---|---|
| **Group A** | T1, T3, T4 | Yes — independent deletions |
| **Group B** | T2 | After Group A (imports from T1) |
| **Group C** | T5 | After T2 (registry references orchestrate) |
| **Group D** | T6 | After T5 (docs describe final state) |

---

## Task 1: Delete team/ module and tests

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `orchestrate_composite_without_team_imports_compiles`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/orchestrate/composite.test.ts`
   - Add a test that verifies `handleOrchestrate` rejects all 5 team actions (`team_spawn`, `team_message`, `team_broadcast`, `team_shutdown`, `team_status`) with `UNKNOWN_ACTION` error
   - Expected failure: test fails because team actions currently succeed

2. **[GREEN]** Delete team module and update orchestrate composite
   - Delete: `src/team/coordinator.ts`, `src/team/composition.ts`, `src/team/roles.ts`, `src/team/tools.ts`
   - Delete: `src/__tests__/team/coordinator.test.ts`, `src/__tests__/team/composition.test.ts`, `src/__tests__/team/roles.test.ts`, `src/__tests__/team/tools.test.ts`
   - Modify `src/orchestrate/composite.ts`: remove all team imports and `TEAM_ACTIONS` object, `ACTION_HANDLERS` becomes just `TASK_ACTIONS`

3. **[REFACTOR]** Clean up composite module
   - Remove `TEAM_ACTIONS` / `TASK_ACTIONS` distinction — rename to just `ACTION_HANDLERS` directly
   - Update module header comment (no longer "team or task", just "task")

**Dependencies:** None
**Parallelizable:** Yes (Group A — deletion portion only; composite edit coordinates with T2)

---

## Task 2: Strip team actions from orchestrate composite and tests

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `orchestrate_only_routes_task_actions`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/orchestrate/composite.test.ts`
   - Test that `handleOrchestrate` only accepts `task_claim`, `task_complete`, `task_fail`
   - Test that valid actions list in error message contains exactly 3 actions
   - Expected failure: currently lists 8 actions

2. **[GREEN]** Update orchestrate composite
   - File: `src/orchestrate/composite.ts`
   - Remove team handler imports (lines 9-17)
   - Remove `TEAM_ACTIONS` object (lines 31-37)
   - Set `ACTION_HANDLERS` to only task handlers
   - Update existing `composite.test.ts` — remove all team-action test cases, keep task-action tests

3. **[REFACTOR]** Simplify
   - Remove `TEAM_ACTIONS` / `TASK_ACTIONS` intermediate objects — define `ACTION_HANDLERS` directly
   - Update file header comment

**Dependencies:** T1 (team module must be deleted first so imports break cleanly)
**Parallelizable:** No (sequential after T1)

---

## Task 3: Remove team-status-view and its CQRS wiring

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `view_composite_rejects_team_status_action`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/views/tools.test.ts` (or `views/composite.test.ts` if it exists)
   - Test that `handleView({ action: 'team_status' })` returns `UNKNOWN_ACTION` error
   - Expected failure: currently succeeds and returns team status view

2. **[GREEN]** Remove team-status-view
   - Delete: `src/views/team-status-view.ts`
   - Delete: `src/__tests__/views/team-status-view.test.ts`
   - Modify `src/views/tools.ts`:
     - Remove imports of `teamStatusProjection`, `TEAM_STATUS_VIEW`, `TeamStatusViewState` (lines 15-18)
     - Remove `materializer.register(TEAM_STATUS_VIEW, teamStatusProjection)` from `createMaterializer()` (line 44)
     - Remove entire `handleViewTeamStatus` function (lines 155-182)
     - Remove `registerViewTools` server.tool registration for `exarchos_view_team_status` (lines 330-335)
   - Modify `src/views/composite.ts`:
     - Remove `handleViewTeamStatus` from import (line 11)
     - Remove `case 'team_status'` block (lines 51-55)
     - Remove `'team_status'` from `validTargets` array (line 98)

3. **[REFACTOR]** Clean up view tools
   - Verify remaining view registrations are complete and consistent

**Dependencies:** None
**Parallelizable:** Yes (Group A — independent of team module deletion)

---

## Task 4: Prune dead event types from schemas

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `schema_rejects_removed_event_types`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/event-store/schemas.test.ts` (or co-located)
   - Test that `team.formed`, `agent.message`, `agent.handoff` are NOT in the `EVENT_TYPES` array/enum
   - Expected failure: these types currently exist

2. **[GREEN]** Remove event types
   - File: `src/event-store/schemas.ts`
   - Remove `'team.formed'` from EventType union/array (line 7)
   - Remove `'agent.message'` from EventType union/array (line 15)
   - Remove `'agent.handoff'` from EventType union/array (line 16)
   - Remove corresponding data type interfaces (`TeamFormedData`, `AgentMessageData`, `AgentHandoffData`)
   - Update `validateAgentEvent()` — remove `agent.message` and `agent.handoff` from agent event types that require `agentId` validation (line 311-312)
   - Keep `task.claimed` and `task.progressed` in agent event validation (still valid)
   - Update any schema tests that reference these types

3. **[REFACTOR]** Update comment in `validateAgentEvent` describing which types require agent metadata

**Dependencies:** None
**Parallelizable:** Yes (Group A — schema changes are independent)

---

## Task 5: Strip team actions from registry and CLI tests

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `registry_orchestrate_has_only_task_actions`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/registry.test.ts` (or co-located `registry.test.ts`)
   - Test that `exarchos_orchestrate` tool in `TOOL_REGISTRY` has exactly 3 actions: `task_claim`, `task_complete`, `task_fail`
   - Test that `exarchos_view` tool has no `team_status` action
   - Expected failure: currently has 8 orchestrate actions and team_status in views

2. **[GREEN]** Update registry
   - File: `src/registry.ts`
   - Remove 5 team action definitions from `orchestrateActions` (lines 270-326): `team_spawn`, `team_message`, `team_broadcast`, `team_shutdown`, `team_status`
   - Remove `team_status` action from `viewActions` (lines 399-406)
   - Update `exarchos_orchestrate` description (line 472): "Task coordination — claim, complete, and fail tasks"
   - Update `exarchos_view` description (line 476): remove "team status" from description
   - Update CLI tests:
     - `src/cli-commands/guard.test.ts` — remove test cases that reference team actions
     - `src/cli-commands/subagent-context.test.ts` — remove assertions about team action denial for teammates
   - Update `src/__tests__/workflow/index.test.ts` — remove/update the `team_spawn` test case (lines 215-220)

3. **[REFACTOR]** Clean up
   - `DELEGATE_PHASES` and `ROLE_LEAD` constants may still be used by workflow actions — keep if referenced, remove only if orphaned
   - Verify `buildCompositeSchema` still works with 3 actions (minimum is 2, so 3 is fine)

**Dependencies:** T2 (orchestrate composite must be updated first)
**Parallelizable:** No (sequential after T2)

---

## Task 6: Update documentation

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `docs_do_not_reference_team_coordinator`
   - Manual verification step (no automated test needed for docs)
   - Grep for `team_spawn`, `team_message`, `team_broadcast`, `team_shutdown` in `CLAUDE.md` and `skills/`

2. **[GREEN]** Update documentation
   - File: `CLAUDE.md`
     - Update `exarchos_orchestrate` tool table: remove 5 team actions, keep 3 task actions
     - Update tool description: "Task coordination" not "Agent team coordination"
     - Remove `team/` from Key modules list or replace with note about Claude Code native Agent Teams
     - Update `exarchos_view` action list: remove `team_status`
   - File: `skills/delegation/SKILL.md`
     - Add note that Claude Code native Agent Teams replace Exarchos team messaging
     - Remove any references to `team_spawn`, `team_message`, `team_broadcast`, `team_shutdown`

3. **[REFACTOR]** Final consistency check
   - Verify no stale references to removed modules anywhere in docs
   - Run full build and test suite

**Dependencies:** T5 (final code state must be settled)
**Parallelizable:** No (must be last)

---

## Verification

After all tasks complete:

```bash
cd plugins/exarchos/servers/exarchos-mcp
npm run build          # TypeScript compiles
npm run test:run       # All tests pass
npm run test:coverage  # Coverage meets thresholds
```

Root level:
```bash
npm run build          # Root installer builds
npm run test:run       # Root tests pass
```

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Task actions break when team actions removed | Task handlers (`tasks/tools.ts`) have zero imports from `team/` — verified |
| `buildCompositeSchema` fails with <2 actions | Remaining 3 task actions exceed the minimum (2) |
| CLI guard/subagent-context breaks | Registry-driven filtering — removing from registry automatically removes from guards |
| `index.ts` directly imports team module | Verified: `index.ts` has no team imports |
| Views materializer breaks without team projection | Other projections are independent; materializer registry is additive |
