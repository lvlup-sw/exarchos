# Auto-Chain Behavior

## Purpose

Define automatic phase transitions for refactor workflows, minimizing human intervention while maintaining quality.

## Design Principle

**Single human checkpoint per track.**

- Polish track: One checkpoint at completion (commit approval)
- Overhaul track: One checkpoint at merge (PR approval)

All other transitions are automatic.

## Polish Track Auto-Chain

```
explore → brief → implement → validate → update-docs → CHECKPOINT
```

### Transition Rules

| From | To | Condition | Auto? |
|------|-----|-----------|-------|
| explore | brief | Scope assessed | ✓ Yes |
| brief | implement | Brief captured | ✓ Yes |
| implement | validate | Changes complete | ✓ Yes |
| validate | update-docs | Validation passed | ✓ Yes |
| update-docs | complete | Docs updated | ✓ Yes |
| complete | — | Human approves commit | ✗ CHECKPOINT |

### Polish Auto-Chain Commands

After each phase, workflow-state.sh returns next action:

```bash
# After explore
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: AUTO:refactor-brief

# After brief
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: AUTO:refactor-implement

# After implement
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: AUTO:refactor-validate

# After validate (passed)
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: AUTO:refactor-update-docs

# After update-docs
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: WAIT:human-checkpoint:polish-complete
```

### Polish Checkpoint

At completion, present to user:

```markdown
## Polish Refactor Complete

**Changes Made:**
<summary of files modified>

**Goals Achieved:**
- <goal 1>: ✓
- <goal 2>: ✓

**Validation:**
- Tests: ✓ All passing
- Docs: ✓ Updated

**Action Required:**
Ready to commit changes. Approve to commit, or request modifications.
```

## Overhaul Track Auto-Chain

```
explore → brief → plan → delegate → integrate → review → update-docs → synthesize → CHECKPOINT
                                        ↑                    │
                                        └─── fixes ──────────┘ (if review fails)
```

### Transition Rules

| From | To | Condition | Auto? |
|------|-----|-----------|-------|
| explore | brief | Scope assessed | ✓ Yes |
| brief | plan | Brief captured | ✓ Yes |
| plan | delegate | Plan created | ✓ Yes |
| delegate | integrate | All tasks complete | ✓ Yes |
| integrate | review | Integration passes | ✓ Yes |
| review (pass) | update-docs | Review approved | ✓ Yes |
| review (fail) | delegate | Fix tasks dispatched | ✓ Yes (loop) |
| update-docs | synthesize | Docs updated | ✓ Yes |
| synthesize | complete | Human approves PR | ✗ CHECKPOINT |

### Overhaul Auto-Chain Commands

```bash
# After explore
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: AUTO:refactor-brief

# After brief
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: AUTO:refactor-plan

# After plan
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: AUTO:refactor-delegate

# After delegate
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: AUTO:refactor-integrate

# After integrate
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: AUTO:refactor-review

# After review (passed)
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: AUTO:refactor-update-docs

# After review (failed)
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: AUTO:refactor-delegate:--fixes

# After update-docs
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: AUTO:refactor-synthesize

# After synthesize
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: WAIT:human-checkpoint:overhaul-merge
```

### Overhaul Checkpoint

#### PR Approval

```markdown
## Refactor PR Ready

**PR:** <url>

**Summary:**
<refactor summary>

**Goals Achieved:**
- <goal 1>: ✓
- <goal 2>: ✓

**Review Status:**
- Behavior preserved: ✓
- Tests passing: ✓
- Docs updated: ✓

**Action Required:**
Review PR and approve merge, or request changes.
```

## Track Switching

If polish track discovers scope expansion, it switches to overhaul:

```
polish:implement → [scope expands] → overhaul:plan
```

Auto-chain handles this:

```bash
# When scope expands during implement
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.track = "overhaul" | .phase = "plan"'

# Next action returns
~/.claude/scripts/workflow-state.sh next-action <state-file>
# Returns: AUTO:refactor-plan
```

## Failure Handling

### Polish Track Failures

| Failure | Recovery |
|---------|----------|
| Validate fails | Return to implement, fix issues |
| Tests fail | Fix tests, re-validate |
| Scope expands | Switch to overhaul track |

### Overhaul Track Failures

| Failure | Recovery |
|---------|----------|
| Integration fails | Fix and re-integrate |
| Review fails | Delegate fixes, re-review |
| Synthesize fails | Fix PR issues, re-synthesize |

All recoveries are automatic loops until success.

## State Machine Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                        REFACTOR WORKFLOW                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  START → explore → brief ─┬─→ [polish] ─→ implement ─→ validate │
│                           │                                ↓     │
│                           │                          update-docs │
│                           │                                ↓     │
│                           │                          ▣ COMPLETE  │
│                           │                                      │
│                           └─→ [overhaul] ─→ plan ─→ delegate     │
│                                                          ↓       │
│                                                      integrate   │
│                                                          ↓       │
│                                                      review ───┐ │
│                                                          ↓     │ │
│                                                    update-docs │ │
│                                                          ↓     │ │
│                                                    synthesize  │ │
│                                                          ↓     │ │
│                                                    ▣ PR-MERGE  │ │
│                                                                │ │
│                                  delegate:--fixes ←────────────┘ │
│                                        (on review fail)          │
│                                                                  │
│  Legend: ▣ = Human Checkpoint                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Integration with workflow-auto-resume.md

The auto-chain actions are handled by workflow-auto-resume.md rules:

| Action | Skill Invoked |
|--------|---------------|
| AUTO:refactor-explore | Resume scope assessment |
| AUTO:refactor-brief | Continue to brief capture |
| AUTO:refactor-implement | Continue to implement phase |
| AUTO:refactor-validate | Continue to validate phase |
| AUTO:refactor-update-docs | Continue to update-docs phase |
| AUTO:refactor-plan | Invoke /plan with refactor context |
| AUTO:refactor-delegate | Invoke /delegate |
| AUTO:refactor-delegate:--fixes | Invoke /delegate --fixes |
| AUTO:refactor-integrate | Invoke /integrate |
| AUTO:refactor-review | Invoke /review |
| AUTO:refactor-synthesize | Invoke /synthesize |
