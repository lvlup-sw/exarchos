---
name: refactor
description: "Code improvement workflow with two tracks: polish (small, direct changes) and overhaul (large, delegated restructuring). Use when the user says \"refactor\", \"clean up\", \"restructure\", \"reorganize\", \"refactor this code\", or runs /refactor. Handles explore, brief, implement, validate, and documentation phases. Do NOT use for bug fixes (use /debug) or new features (use /ideate). Applies to existing code only."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity:
    - explore
    - brief
    - implement
    - validate
    - update-docs
    - synthesize
---

# Refactor Workflow Skill

## Overview

Two-track workflow for improving existing code. Polish track for small, contained refactors; overhaul track for architectural changes and migrations. Both tracks emphasize exploration before commitment and mandatory documentation updates.

## Triggers

Activate this skill when:
- User runs `/exarchos:refactor` command
- User wants to improve existing code structure
- User mentions "refactor", "restructure", "clean up", "migrate"
- User asks to "move", "extract", "rename", or "reorganize" code

**Disambiguation:** If the user says "fix" or "clean up" — use `/exarchos:refactor` when the code *works* but needs structural improvement. Use `/exarchos:debug` when something is *broken* (error, crash, wrong behavior).

## Workflow Overview

```
                              /exarchos:refactor
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
/exarchos:refactor "Description of what needs refactoring"

# Fast path: polish track
/exarchos:refactor --polish "Small contained refactor description"

# Explore first, then decide track
/exarchos:refactor --explore "Unsure of scope, explore first"
```

### Mid-Workflow Commands

```bash
# Switch from polish to overhaul (during explore/brief)
/exarchos:refactor --switch-overhaul

# Resume after context compaction
/exarchos:resume
```

## Track Comparison

| Aspect | Polish | Overhaul |
|--------|--------|----------|
| Scope | <=5 files, single concern | No limit |
| Worktree | No (direct) | Yes (isolated) |
| Delegation | No | Yes (full workflow) |
| Documentation | Mandatory update phase | Mandatory update phase |
| Human Checkpoints | 0 | 1 (merge) |

## Polish Track

Fast path for small, contained refactors (<=5 files, single concern). Orchestrator may write code directly (exception to orchestrator constraints). No worktree, no delegation.

Phases: Explore -> Brief -> Implement -> Validate -> Update Docs -> Complete

For detailed phase instructions, state management, and auto-chain behavior, see `@skills/refactor/references/polish-track.md`.

## Overhaul Track

Rigorous path for architectural changes, migrations, and multi-file restructuring. Uses full delegation model with worktree isolation.

Phases: Explore -> Brief -> Plan -> Plan Review -> Delegate -> Review -> Update Docs -> Synthesize

For detailed phase instructions, skill invocations, and auto-chain behavior, see `@skills/refactor/references/overhaul-track.md`.

## State Management

Initialize refactor workflow:
```
action: "init", featureId: "refactor-<slug>", workflowType: "refactor"
```

Full state schema:
```json
{
  "version": "1.1",
  "featureId": "refactor-<slug>",
  "workflowType": "refactor",
  "track": "polish | overhaul",
  "phase": "explore | brief | polish-implement | polish-validate | polish-update-docs | overhaul-plan | overhaul-plan-review | overhaul-delegate | overhaul-review | overhaul-update-docs | synthesize | completed | cancelled | blocked",
  "explore": {
    "startedAt": "ISO8601",
    "completedAt": "ISO8601 | null",
    "scopeAssessment": {
      "filesAffected": ["string"],
      "modulesAffected": ["string"],
      "testCoverage": "good | gaps | none",
      "recommendedTrack": "polish | overhaul"
    }
  },
  "brief": {  // See references/brief-template.md for field descriptions
    "problem": "string",
    "goals": ["string"],
    "approach": "string",
    "affectedAreas": ["string"],
    "outOfScope": ["string"],
    "successCriteria": ["string"],
    "docsToUpdate": ["string"]
  },
  "artifacts": {
    "plan": "string | null",
    "pr": "string | null",
    "updatedDocs": ["string"]
  },
  "validation": {
    "testsPass": "boolean",
    "goalsVerified": ["string"],
    "docsUpdated": "boolean"
  }
}
```

## Track Switching

If scope expands beyond polish limits during explore or brief phase, use `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "set"` to set `track` to "overhaul" and update `explore.scopeAssessment.recommendedTrack`.

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
| `/exarchos:plan` | `Skill({ skill: "exarchos:plan", args: "--refactor <state-file>" })` | Task extraction from brief |
| `/exarchos:delegate` | `Skill({ skill: "exarchos:delegate", args: "<state-file>" })` | Subagent dispatch for TDD |
| `/exarchos:review` | `Skill({ skill: "exarchos:review", args: "<state-file>" })` | Quality review |
| `/exarchos:synthesize` | `Skill({ skill: "exarchos:synthesize", args: "<feature>" })` | PR creation |

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

1. **At workflow start (explore):** `mcp__plugin_exarchos_exarchos__exarchos_event` with `action: "append"` → `workflow.started` with workflowType "refactor"
2. **On track selection:** Auto-emitted by `exarchos_workflow` `set` when `phase` is provided — emits `workflow.transition` with selected track (polish/overhaul)
3. **On each phase transition:** Auto-emitted by `exarchos_workflow` `set` when `phase` is provided — emits `workflow.transition` with from/to/trigger/featureId
4. **Overhaul track stacking:** Handled by `/exarchos:delegate` (subagents use `git commit` + `git push` per implementer prompt)
5. **Polish track commit:** Single `git commit -m "refactor: <description>"` + `git push` — no multi-branch stacking needed
6. **On complete:** Auto-emitted by `exarchos_workflow` `set` when transitioning to terminal state — emits `workflow.transition` to "completed"
