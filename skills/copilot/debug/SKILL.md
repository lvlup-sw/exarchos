---
name: debug
description: "Bug investigation and fix workflow. Triggers: 'debug', 'fix bug', 'investigate issue', 'something is broken', or /debug. Hotfix track for quick fixes, thorough track for root cause analysis. Do NOT use for feature development or refactoring. Do NOT escalate to /ideate unless the fix requires architectural redesign."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity:
    - triage
    - investigate
    - rca
    - design
    - debug-implement
    - debug-validate
    - debug-review
    - hotfix-implement
    - hotfix-validate
    - synthesize
---

# Debug Workflow Skill

## Overview

Investigation-first workflow for debugging and regression fixes. Provides two tracks based on urgency: hotfix (fast, minimal ceremony) and thorough (rigorous, full RCA documentation).

## Triggers

Activate this skill when:
- User runs `/debug` command
- User reports a bug or regression
- User needs to investigate an error
- User says "fix this bug" or similar

**Disambiguation:** If the user says "fix" or "clean up" — use `/debug` when something is *broken* (error, crash, wrong behavior). Use `/refactor` when the code *works* but needs structural improvement.

## Workflow Overview

```
                              /debug
                                 │
                            ┌────┴────┐
                            │ Triage  │
                            └────┬────┘
                                 │
               ┌─────────────────┼─────────────────┐
               │                 │                 │
          --hotfix            (default)       --escalate
               │                 │                 │
               ▼                 ▼                 ▼
      ┌────────────────┐  ┌─────────────┐   ┌──────────┐
      │  Hotfix Track  │  │   Thorough  │   │ /ideate  │
      │                │  │    Track    │   │ handoff  │
      └────────────────┘  └─────────────┘   └──────────┘
```

## Command Interface

### Start Debug Workflow

```bash
# Default: thorough track
/debug "Description of the bug"

# Fast path: hotfix track
/debug --hotfix "Production is down - users can't login"

# Escalate to feature workflow
/debug --escalate "This needs architectural changes"
```

### Mid-Workflow Commands

```bash
# Switch from hotfix to thorough (during investigation)
/debug --switch-thorough

# Escalate to /ideate (manual handoff)
/debug --escalate "Reason for escalation"

# Resume after context compaction
/rehydrate
```

## Track Comparison

| Aspect | Hotfix | Thorough |
|--------|--------|----------|
| Urgency | P0 (production down) | P1/P2 (normal priority) |
| Investigation | 15 min time-boxed | No time limit |
| RCA Document | No (minimal in state) | Yes (full docs/rca/) |
| Worktree | No (in-place fix) | Yes (isolated) |
| Review | Smoke test only | Spec review |
| Human Checkpoints | 1 (merge) | 1 (merge) |

### Decision Runbooks

For track-selection criteria at the triage phase, query the decision runbook:
`exarchos_orchestrate({ action: "runbook", id: "triage-decision" })`

For investigation escalation criteria, query:
`exarchos_orchestrate({ action: "runbook", id: "investigation-decision" })`

These runbooks encode the structured decision trees for track selection. The agent reads the decision tree and follows the guidance — the platform does not execute branches.

## Hotfix Track

Fix production issues ASAP. Speed over ceremony.

**HSM phases:** `triage` → `investigate` (15 min max) → `hotfix-implement` (no worktree) → `hotfix-validate` → `completed`

See `references/triage-questions.md` for triage guidance.

### Investigation Timer

1. On hotfix track selection: record `investigation.startedAt` in state
2. After each major finding: check elapsed time
3. At 15 min mark: emit `investigation.timeout` event, pause for user confirmation
   - Switch to thorough track? (yes/no)

For detailed phase instructions, see `references/hotfix-track.md`.

## Thorough Track

Fix bugs with proper rigor. Full RCA documentation.

**HSM phases:** `triage` → `investigate` → `rca` → `design` → `debug-implement` (worktree + TDD) → `debug-validate` → `debug-review` → `synthesize` → `completed`

For detailed phase instructions, see `references/thorough-track.md`. For systematic investigation methodology, see `references/investigation-checklist.md`.

### Characterization Testing (Thorough Track Only)

Before fixing a bug in the thorough track, capture the buggy behavior as a characterization test:

1. **Before fix:** Write a test that documents the current (buggy) behavior — it should PASS with the bug present
2. **Write the fix test:** Write a test that describes the correct behavior — it should FAIL (this is the standard TDD RED phase)
3. **Apply the fix:** Implement the fix. The fix test should now PASS, and the characterization test should now FAIL
4. **Verify:** The characterization test failing confirms the bug is actually fixed. If it still passes, the fix didn't address the root cause.

This is not required for the hotfix track — hotfixes prioritize speed over documentation.

### Track Switching

- **Hotfix -> Thorough:** When investigation timer expires (15 min). All findings preserved.
- **Thorough -> Escalate:** When fix requires architectural changes. Hand off to `/ideate`.

For detailed switching logic, see `references/thorough-track.md`.

## Auto-Chain Behavior

Both tracks have ONE human checkpoint before completion.

**Hotfix auto-chain:**
```
triage → investigate → hotfix-implement → [HUMAN: hotfix-validate] → completed
         (auto)        (auto)
```

**Thorough auto-chain:**
```
triage → investigate → rca → design → debug-implement → debug-validate → debug-review → [HUMAN: synthesize] → completed
         (auto)        (auto) (auto)   (auto)           (auto)            (auto)
```

## State Management

Initialize debug workflow:
```
action: "init", featureId: "debug-<issue-slug>", workflowType: "debug"
```

See `@skills/debug/references/state-schema.md` for full schema.

### Phase Transitions and Guards

Every phase transition has a guard that must be satisfied. Before transitioning, consult `@skills/workflow-state/references/phase-transitions.md` for the exact prerequisite for each guard.

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["set", "init"] })` for
parameter schemas and `exarchos_workflow({ action: "describe", playbook: "debug" })`
for phase transitions, guards, and playbook guidance.

## Integration Points

### With /rehydrate

Debug workflows resume like feature workflows:
```bash
/rehydrate
```

### With Existing Skills

- Uses spec-review skill for thorough track review phase
- Uses synthesis skill for PR creation
- Uses git-worktrees skill for thorough track implementation

### With MCP Workflow State Tools

Extended to support:
- `workflowType: "debug"` field
- Debug-specific phases handled by the SessionStart hook (which determines next action on resume)
- Debug context provided by the SessionStart hook on session start

## Completion Criteria

### Hotfix Complete

- [ ] Root cause identified (even if briefly)
- [ ] Minimal fix applied
- [ ] Affected tests pass
- [ ] Follow-up RCA task created
- [ ] Changes merged

**Completion guard shapes** — set these via `exarchos_workflow set` before transitioning to `completed`:

| Exit path | Guard | Required state |
|-----------|-------|----------------|
| Direct push (no PR) | `fix-verified-directly` | `resolution: { directPush: true, commitSha: "<sha>" }` |
| Validation passed | `validation-passed` | `validation: { passed: true }` |
| Via PR | Through `synthesize` → `completed` | `prUrl` must exist |

### Thorough Complete

- [ ] Full RCA documented in docs/rca/ (use `references/rca-template.md`)
- [ ] Fix matches RCA findings
- [ ] TDD implementation with tests
- [ ] Spec review passed
- [ ] PR merged

**Completion guard shapes** — the thorough track exits through `synthesize` → `completed` (guard: `pr-url-exists`, requires `prUrl` in state).

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Start coding before understanding bug | Investigate first, always |
| Skip RCA on thorough track | Document for future learning |
| Exceed 15 min on hotfix investigation | Switch to thorough track |
| Add features during bug fix | Scope creep - only fix the bug |
| Skip tests because "it's just a fix" | Fixes need tests to prevent regression |

## Troubleshooting

See `references/troubleshooting.md` for MCP tool failures, state desync, investigation timeouts, and track switching issues.
