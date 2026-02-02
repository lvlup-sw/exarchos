# Overhaul Track: Plan Phase

## Purpose

Create detailed implementation plan for large refactors using `/plan` skill with refactor context.

## Entry Conditions

- Track is `overhaul`
- Brief phase complete
- Scope assessment available

## Integration with /plan

Invoke planning with refactor context:

```
/plan --from-brief docs/workflow-state/<feature>.state.json
```

Or provide context manually from the brief.

## Refactor Planning Emphasis

### 1. Incremental Changes

Each task must:
- Leave code in working state
- Be independently testable
- Not break functionality mid-task

### 2. Rollback Points

Identify safe stopping points where refactor can be paused if needed.

### 3. Test Strategy

Every task should include test verification requirements.

### 4. Working State Guarantee

After every task, code must compile and tests must pass.

## Plan Structure

```markdown
# Implementation Plan: <Refactor Name>

## Goals Mapping
| Brief Goal | Task(s) |
|------------|---------|
| <goal 1> | Task X, Y |

## Task Breakdown

### Task 001: <Title>
**Changes:** What files
**Tests:** What verifies success
**Working State:** How code stays functional

[Repeat for each task]

## Rollback Strategy
<Safe stopping points>
```

## State Update

```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.artifacts.plan = "<plan-path>" | .phase = "plan-review"'
```

## Exit Conditions

- Plan document created
- All brief goals mapped to tasks
- Incremental strategy clear
- Ready for plan-review checkpoint
