# Auto-Chain Behavior

## Purpose

Define automatic phase transitions for refactor workflows, minimizing human intervention while maintaining quality.

## Design Principle

**Single human checkpoint per track.**

- Polish track: One checkpoint at completion (commit approval)
- Overhaul track: One checkpoint at merge (PR approval)

All other transitions are automatic.

## Polish Track Auto-Chain

```text
explore → brief → implement → validate → update-docs → CHECKPOINT
```

### Transition Rules

| From | To | Condition | Auto? |
|------|-----|-----------|-------|
| explore | brief | Scope assessed | Yes |
| brief | implement | Brief captured | Yes |
| implement | validate | Changes complete | Yes |
| validate | update-docs | Validation passed | Yes |
| update-docs | complete | Docs updated | Yes |
| complete | — | Human approves commit | CHECKPOINT |

### Polish Auto-Chain Commands

After each phase, use `mcp__exarchos__exarchos_workflow_next_action` with the featureId to determine the next action:

```text
# After explore
Use mcp__exarchos__exarchos_workflow_next_action with the featureId.
Returns: AUTO:refactor-brief

# After brief
Use mcp__exarchos__exarchos_workflow_next_action with the featureId.
Returns: AUTO:refactor-implement

# After implement
Use mcp__exarchos__exarchos_workflow_next_action with the featureId.
Returns: AUTO:refactor-validate

# After validate (passed)
Use mcp__exarchos__exarchos_workflow_next_action with the featureId.
Returns: AUTO:refactor-update-docs

# After update-docs
Use mcp__exarchos__exarchos_workflow_next_action with the featureId.
Returns: WAIT:human-checkpoint:polish-complete
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

```text
explore → brief → plan → delegate → integrate → review → update-docs → synthesize → CHECKPOINT
                                        ↑                    │
                                        └─── fixes ──────────┘ (if review fails)
```

### Transition Rules

| From | To | Condition | Auto? |
|------|-----|-----------|-------|
| explore | brief | Scope assessed | Yes |
| brief | plan | Brief captured | Yes |
| plan | delegate | Plan created | Yes |
| delegate | integrate | All tasks complete | Yes |
| integrate | review | Integration passes | Yes |
| review (pass) | update-docs | Review approved | Yes |
| review (fail) | delegate | Fix tasks dispatched | Yes (loop) |
| update-docs | synthesize | Docs updated | Yes |
| synthesize | complete | Human approves PR | CHECKPOINT |

### Overhaul Auto-Chain Commands

Use `mcp__exarchos__exarchos_workflow_next_action` with the featureId after each phase:

```text
# After explore
Returns: AUTO:refactor-brief

# After brief
Returns: AUTO:refactor-plan

# After plan
Returns: AUTO:refactor-delegate

# After delegate
Returns: AUTO:refactor-integrate

# After integrate
Returns: AUTO:refactor-review

# After review (passed)
Returns: AUTO:refactor-update-docs

# After review (failed)
Returns: AUTO:refactor-delegate:--fixes

# After update-docs
Returns: AUTO:refactor-synthesize

# After synthesize
Returns: WAIT:human-checkpoint:overhaul-merge
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

```text
polish:implement → [scope expands] → overhaul:plan
```

Auto-chain handles this via MCP tools:

```text
# When scope expands during implement, use mcp__exarchos__exarchos_workflow_set:
# 1. First call: Set updates
updates: { "implement.switchReason": "<reason>", "implement.switchedAt": "<ISO8601>" }

# 2. Second call: Transition phase and track
phase: "plan"
updates: { "track": "overhaul" }

# Next action returns
Use mcp__exarchos__exarchos_workflow_next_action with the featureId.
Returns: AUTO:refactor-plan
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

```text
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

The auto-chain actions are handled by workflow-auto-resume.md rules.

**CRITICAL:** Use explicit `Skill()` tool invocations to ensure skills are actually invoked:

| Action | Skill Invocation |
|--------|------------------|
| AUTO:refactor-explore | Resume scope assessment (inline) |
| AUTO:refactor-brief | Continue to brief capture (inline) |
| AUTO:refactor-implement | Continue to implement phase (inline - orchestrator implements) |
| AUTO:refactor-validate | Continue to validate phase (inline) |
| AUTO:refactor-update-docs | Continue to update-docs phase (inline) |
| AUTO:refactor-plan | `Skill({ skill: "plan", args: "--refactor <state-file>" })` |
| AUTO:refactor-delegate | `Skill({ skill: "delegate", args: "<state-file>" })` |
| AUTO:refactor-delegate:--fixes | `Skill({ skill: "delegate", args: "--fixes <state-file>" })` |
| AUTO:refactor-integrate | `Skill({ skill: "integrate", args: "<state-file>" })` |
| AUTO:refactor-review | `Skill({ skill: "review", args: "<state-file>" })` |
| AUTO:refactor-synthesize | `Skill({ skill: "synthesize", args: "<feature-name>" })` |

### Example Overhaul Chain

```typescript
// After brief complete
Skill({ skill: "plan", args: "--refactor docs/workflow-state/refactor-auth.state.json" })

// After plan complete (invoked by /plan skill)
Skill({ skill: "delegate", args: "docs/workflow-state/refactor-auth.state.json" })

// After all tasks complete (invoked by /delegate skill)
Skill({ skill: "integrate", args: "docs/workflow-state/refactor-auth.state.json" })

// After integration passes (invoked by /integrate skill)
Skill({ skill: "review", args: "docs/workflow-state/refactor-auth.state.json" })

// After review passes, update-docs runs inline, then:
Skill({ skill: "synthesize", args: "refactor-auth" })
```
