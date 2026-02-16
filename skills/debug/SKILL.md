---
name: debug
description: "Bug investigation and fix workflow with hotfix and thorough tracks. Use when the user says 'debug', 'fix bug', 'investigate issue', 'something is broken', 'debug this issue', or runs /debug. Hotfix track for quick fixes, thorough track for complex bugs requiring root cause analysis. Do NOT use for feature development or planned refactoring. Do NOT escalate to /ideate unless the fix requires architectural redesign — implementation complexity alone is not sufficient reason to escalate."
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
    - implement
    - validate
    - review
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
/resume  # (existing command works)
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

## Hotfix Track

Fix production issues ASAP. Speed over ceremony.

**Phases:** Triage -> Investigate (15 min max) -> Implement (no worktree) -> Validate -> Merge

For detailed phase instructions, see `references/hotfix-track.md`.

## Thorough Track

Fix bugs with proper rigor. Full RCA documentation.

**Phases:** Triage -> Investigate -> RCA -> Design -> Implement (worktree + TDD) -> Review -> Synthesize -> Merge

For detailed phase instructions, see `references/thorough-track.md`.

### Track Switching

- **Hotfix -> Thorough:** When investigation timer expires (15 min). All findings preserved.
- **Thorough -> Escalate:** When fix requires architectural changes. Hand off to `/ideate`.

For detailed switching logic, see `references/thorough-track.md`.

## Auto-Chain Behavior

Both tracks have ONE human checkpoint: merge confirmation.

**Hotfix auto-chain:**
```
triage → investigate → implement → validate → [HUMAN: merge]
         (auto)        (auto)       (auto)
```

**Thorough auto-chain:**
```
triage → investigate → rca → design → implement → review → synthesize → [HUMAN: merge]
         (auto)        (auto) (auto)   (auto)      (auto)   (auto)
```

## State Management

Initialize debug workflow using `mcp__exarchos__exarchos_workflow` with `action: "init"`:

```text
Use mcp__exarchos__exarchos_workflow with action: "init", featureId `debug-<issue-slug>`, and workflowType `debug`.
```

See `@skills/debug/references/state-schema.md` for full schema.

## Integration Points

### With /resume

Debug workflows resume like feature workflows:
```bash
/resume ~/.claude/workflow-state/debug-<issue-slug>.state.json
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

### Thorough Complete

- [ ] Full RCA documented in docs/rca/
- [ ] Fix matches RCA findings
- [ ] TDD implementation with tests
- [ ] Spec review passed
- [ ] PR merged

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
