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
explore → brief → polish-implement → polish-validate → polish-update-docs → CHECKPOINT
```

### Transition Rules

| From | To | Condition | Auto? |
|------|-----|-----------|-------|
| explore | brief | Scope assessed | Yes |
| brief | polish-implement | Brief captured | Yes |
| polish-implement | polish-validate | Changes complete | Yes |
| polish-validate | polish-update-docs | Validation passed | Yes |
| polish-update-docs | completed | Docs updated | Yes |
| completed | — | Human approves commit | CHECKPOINT |

### Polish Auto-Chain Commands

After each phase, use the SessionStart hook with the featureId to determine the next action:

```text
# After explore
The SessionStart hook determines the next action automatically.
Returns: AUTO:brief

# After brief
The SessionStart hook determines the next action automatically.
Returns: AUTO:polish-implement

# After polish-implement
The SessionStart hook determines the next action automatically.
Returns: AUTO:polish-validate

# After polish-validate (passed)
The SessionStart hook determines the next action automatically.
Returns: AUTO:polish-update-docs

# After update-docs
The SessionStart hook determines the next action automatically.
Returns: WAIT:human-checkpoint:polish-update-docs
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
explore → brief → overhaul-plan → overhaul-plan-review → overhaul-delegate → overhaul-review → overhaul-update-docs → synthesize → CHECKPOINT
                                                                                    ↑                           │
                                                                                    └─────── fixes ─────────────┘ (if review fails)
```

### Transition Rules

| From | To | Condition | Auto? |
|------|-----|-----------|-------|
| explore | brief | Scope assessed | Yes |
| brief | overhaul-plan | Brief captured | Yes |
| overhaul-plan | overhaul-plan-review | Plan created | Yes |
| overhaul-plan-review | overhaul-delegate | Plan approved | Yes |
| overhaul-delegate | overhaul-review | All tasks complete | Yes |
| overhaul-review (pass) | overhaul-update-docs | Review approved | Yes |
| overhaul-review (fail) | overhaul-delegate | Fix tasks dispatched | Yes (loop) |
| overhaul-update-docs | synthesize | Docs updated | Yes |
| synthesize | completed | Human approves PR | CHECKPOINT |

### Overhaul Auto-Chain Commands

Use the SessionStart hook with the featureId after each phase:

```text
# After explore
Returns: AUTO:brief

# After brief
Returns: AUTO:overhaul-plan

# After overhaul-plan
Returns: AUTO:overhaul-plan-review

# After overhaul-plan-review (approved)
Returns: AUTO:overhaul-delegate

# After overhaul-delegate
Returns: AUTO:overhaul-review

# After overhaul-review (passed)
Returns: AUTO:overhaul-update-docs

# After overhaul-review (failed)
Returns: AUTO:delegate:--fixes

# After overhaul-update-docs
Returns: AUTO:synthesize

# After synthesize
Returns: WAIT:human-checkpoint:synthesize
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
polish-implement → [scope expands] → overhaul-plan
```

Auto-chain handles this via MCP tools:

```text
# When scope expands during implement, use mcp__plugin_exarchos_exarchos__exarchos_workflow with action: "set":
# 1. First call: Set updates
updates: { "implement.switchReason": "<reason>", "implement.switchedAt": "<ISO8601>" }

# 2. Second call: Transition phase and track
phase: "overhaul-plan"
updates: { "track": "overhaul" }

# Next action returns
The SessionStart hook determines the next action automatically.
Returns: AUTO:overhaul-plan
```

## Failure Handling

### Polish Track Failures

| Failure | Recovery |
|---------|----------|
| Validate fails | Return to polish-implement, fix issues |
| Tests fail | Fix tests, re-validate |
| Scope expands | Switch to overhaul track |

### Overhaul Track Failures

| Failure | Recovery |
|---------|----------|
| Review fails | Delegate fixes, re-review |
| Synthesize fails | Fix PR issues, re-synthesize |

All recoveries are automatic loops until success.

## State Machine Summary

```text
┌─────────────────────────────────────────────────────────────────┐
│                        REFACTOR WORKFLOW                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  START → explore → brief ─┬─→ [polish] ─→ polish-implement ─→ polish-validate │
│                           │                                         ↓          │
│                           │                                  polish-update-docs │
│                           │                                         ↓          │
│                           │                                   ▣ COMPLETE       │
│                           │                                                    │
│                           └─→ [overhaul] ─→ overhaul-plan ─→ overhaul-delegate │
│                                                                    ↓           │
│                                                          overhaul-review ───┐  │
│                                                                    ↓        │  │
│                                                       overhaul-update-docs  │  │
│                                                                    ↓        │  │
│                                                              synthesize     │  │
│                                                                    ↓        │  │
│                                                              ▣ PR-MERGE     │  │
│                                                                             │  │
│                                          overhaul-delegate:--fixes ←────────┘  │
│                                                  (on review fail)              │
│                                                                  │
│  Legend: ▣ = Human Checkpoint                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Integration with workflow-auto-resume.md

The auto-chain actions are handled by workflow-auto-resume.md rules.

**CRITICAL:** Use explicit `Skill()` tool invocations to ensure skills are actually invoked:

| Action | Skill Invocation |
|--------|------------------|
| AUTO:brief | Continue to brief capture (inline) |
| AUTO:polish-implement | Continue to implement phase (inline - orchestrator implements) |
| AUTO:polish-validate | Continue to validate phase (inline) |
| AUTO:polish-update-docs | Continue to update-docs phase (inline) |
| AUTO:overhaul-plan | `Skill({ skill: "exarchos:plan", args: "--refactor <state-file>" })` |
| AUTO:overhaul-plan-review | Plan-review human checkpoint (inline gap analysis) |
| AUTO:overhaul-delegate | `Skill({ skill: "exarchos:delegate", args: "<state-file>" })` |
| AUTO:delegate:--fixes | `Skill({ skill: "exarchos:delegate", args: "--fixes <state-file>" })` |
| AUTO:overhaul-review | `Skill({ skill: "exarchos:review", args: "<state-file>" })` |
| AUTO:synthesize | `Skill({ skill: "exarchos:synthesize", args: "<feature-name>" })` |

### Example Overhaul Chain

```typescript
// After brief complete
Skill({ skill: "exarchos:plan", args: "--refactor ~/.claude/workflow-state/refactor-auth.state.json" })

// After plan complete (invoked by /exarchos:plan skill)
Skill({ skill: "exarchos:delegate", args: "~/.claude/workflow-state/refactor-auth.state.json" })

// After all tasks complete (invoked by /exarchos:delegate skill)
Skill({ skill: "exarchos:review", args: "~/.claude/workflow-state/refactor-auth.state.json" })

// After review passes, update-docs runs inline, then:
Skill({ skill: "exarchos:synthesize", args: "refactor-auth" })
```
