---
name: refactor
description: "Code improvement workflow with polish and overhaul tracks. Triggers: 'refactor', 'clean up', 'restructure', 'reorganize', or /refactor. Phases: explore, brief, implement, validate. Existing code only — Do NOT use for bug fixes (/debug) or new features (/ideate)."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity:
    - explore
    - brief
    - polish-implement
    - polish-validate
    - polish-update-docs
    - overhaul-plan
    - overhaul-plan-review
    - overhaul-delegate
    - overhaul-review
    - overhaul-update-docs
    - synthesize
---

# Refactor Workflow Skill

## Overview

Two-track workflow for improving existing code. Polish track for small, contained refactors; overhaul track for architectural changes and migrations. Both tracks emphasize exploration before commitment and mandatory documentation updates.

## Triggers

Activate this skill when:
- User runs `{{COMMAND_PREFIX}}refactor` command
- User wants to improve existing code structure
- User mentions "refactor", "restructure", "clean up", "migrate"
- User asks to "move", "extract", "rename", or "reorganize" code

**Disambiguation:** If the user says "fix" or "clean up" — use `{{COMMAND_PREFIX}}refactor` when the code *works* but needs structural improvement. Use `{{COMMAND_PREFIX}}debug` when something is *broken* (error, crash, wrong behavior).

## Workflow Overview

```
                              {{COMMAND_PREFIX}}refactor
                                  |
                            +-----+-----+
                            |  Explore  |
                            +-----+-----+
                                  |
                   +--------------+--------------+
                   |                             |
              --polish                       (default)
                   |                             |
                   v                             v
          +--------------+              +--------------+
          |    Polish    |              |   Overhaul   |
          |    Track     |              |    Track     |
          +--------------+              +--------------+
```

## Command Interface

### Start Refactor Workflow

```bash
# Default: overhaul track
{{COMMAND_PREFIX}}refactor "Description of what needs refactoring"

# Fast path: polish track
{{COMMAND_PREFIX}}refactor --polish "Small contained refactor description"

# Explore first, then decide track
{{COMMAND_PREFIX}}refactor --explore "Unsure of scope, explore first"
```

### Mid-Workflow Commands

```bash
# Switch from polish to overhaul (during explore/brief)
{{COMMAND_PREFIX}}refactor --switch-overhaul

# Resume after context compaction
{{COMMAND_PREFIX}}rehydrate
```

## Track Comparison

| Aspect | Polish | Overhaul |
|--------|--------|----------|
| Scope | <=5 files, single concern | No limit |
| Worktree | No (direct) | Yes (isolated) |
| Delegation | No | Yes (full workflow) |
| Documentation | Mandatory update phase | Mandatory update phase |
| Human Checkpoints | 0 | 1 (merge) |

## Characterization Testing (Both Tracks)

Before modifying any existing code behavior, capture current behavior as characterization tests. This is a mandatory pre-step for both tracks:

1. **Before changes:** Write tests that document what the code **currently does** (not what it should do). Exercise the code through the most appropriate observable seam (API, CLI, integration boundary, or function) with representative inputs and assert on actual outputs/effects.
2. **During changes:** Any characterization test failure means behavior changed. Evaluate: intentional or accidental?
3. **After changes:** Document which characterization test failures were expected. Remaining characterization tests become regression tests.

This aligns with Michael Feathers' approach in *Working Effectively with Legacy Code* — understand behavior before changing it.

## Polish Track

Fast path for small, contained refactors (<=5 files, single concern). Orchestrator may write code directly (exception to orchestrator constraints). No worktree, no delegation.

HSM phases: `explore` → `brief` → `polish-implement` → `polish-validate` → `polish-update-docs` → `completed`

For detailed phase instructions, state management, and auto-chain behavior, see `@skills/refactor/references/polish-track.md`.

## Overhaul Track

Rigorous path for architectural changes, migrations, and multi-file restructuring. Uses full delegation model with worktree isolation.

HSM phases: `explore` → `brief` → `overhaul-plan` → `overhaul-plan-review` → `overhaul-delegate` → `overhaul-review` → `overhaul-update-docs` → `synthesize` → `completed`

For detailed phase instructions, skill invocations, and auto-chain behavior, see `@skills/refactor/references/overhaul-track.md`.

## State Management

Initialize refactor workflow:
```
action: "init", featureId: "refactor-<slug>", workflowType: "refactor"
```

Use `describe` to discover the full state schema at runtime: `exarchos_workflow({ action: "describe", actions: ["init"] })`.

### Phase Transitions and Guards

> **Sequential traversal required.** Every phase MUST be traversed in order — you cannot skip phases, even if you have all the data for a later phase ready. For example, `explore` must transition to `brief` before `overhaul-plan` — attempting `explore` → `overhaul-plan` directly will be rejected by the HSM. From `brief` you must go to `polish-implement` or `overhaul-plan`, not directly to `completed`. Each transition requires its guard to be satisfied via `updates` sent alongside the `phase` parameter in a single `set` call. See `@skills/refactor/references/polish-track.md` or `@skills/refactor/references/overhaul-track.md` for the exact tool call at each step.

Every phase transition has a guard that must be satisfied. Before transitioning, consult `@skills/workflow-state/references/phase-transitions.md` for the exact prerequisite for each guard.

The pattern for every transition: send the guard prerequisite in `updates` and the target in `phase` in a single `set` call.

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["set", "init"] })` for
parameter schemas and `exarchos_workflow({ action: "describe", playbook: "refactor" })`
for phase transitions, guards, and playbook guidance.

### Decision Runbooks

For track-selection criteria at the explore phase, query the decision runbook:
`exarchos_orchestrate({ action: "runbook", id: "scope-decision" })`

This runbook provides structured criteria for choosing between polish and overhaul tracks based on file count, structural impact, and PR scope.

## Track Switching

If scope expands beyond polish limits during explore or brief phase, use `{{MCP_PREFIX}}exarchos_workflow` with `action: "set"` to set `track` to "overhaul" and update `explore.scopeAssessment.recommendedTrack`.

**Scope thresholds:** If >5 files affected OR changes cross module boundaries -> recommend overhaul track.

**Indicators to switch:**
- More than 5 files affected
- Multiple concerns identified
- Cross-module changes needed
- Test coverage gaps require new tests

Output: "Scope expanded beyond polish limits. Switching to overhaul track."

## Integration Points

**CRITICAL:** All skill invocations MUST use explicit `Skill()` tool calls:

| Skill | Invocation | Usage |
|-------|------------|-------|
| `{{COMMAND_PREFIX}}plan` | `{{CHAIN next="plan" args="--refactor <state-file>"}}` | Task extraction from brief |
| `{{COMMAND_PREFIX}}delegate` | `{{CHAIN next="delegate" args="<state-file>"}}` | Subagent dispatch for TDD |
| `{{COMMAND_PREFIX}}review` | `{{CHAIN next="review" args="<state-file>"}}` | Quality review |
| `{{COMMAND_PREFIX}}synthesize` | `{{CHAIN next="synthesize" args="<feature>"}}` | PR creation |

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Skip exploration | Always assess scope first (see `references/explore-checklist.md`) |
| Use polish for large changes | Switch to overhaul when scope expands |
| Skip doc updates | Documentation is mandatory (see `references/doc-update-checklist.md`) |
| Add features during refactor | Scope creep - stick to brief goals |
| Skip tests because "just moving code" | Refactors need test verification |
| Create design document for polish | Use brief in state file instead |
| Work in main for overhaul | Use worktree isolation |

## Exarchos Integration

When Exarchos MCP tools are available, emit events throughout the refactor workflow:

1. **At workflow start (explore):** `{{MCP_PREFIX}}exarchos_event` with `action: "append"` → `workflow.started` with workflowType "refactor"
2. **On track selection:** Auto-emitted by `exarchos_workflow` `set` when `phase` is provided — emits `workflow.transition` with selected track (polish/overhaul)
3. **On each phase transition:** Auto-emitted by `exarchos_workflow` `set` when `phase` is provided — emits `workflow.transition` with from/to/trigger/featureId
4. **Overhaul track stacking:** Handled by `{{COMMAND_PREFIX}}delegate` (subagents use `git commit` + `git push` per implementer prompt)
5. **Polish track commit:** Single `git commit -m "refactor: <description>"` + `git push` — no multi-branch stacking needed
6. **On complete:** Auto-emitted by `exarchos_workflow` `set` when transitioning to terminal state — emits `workflow.transition` to "completed"
