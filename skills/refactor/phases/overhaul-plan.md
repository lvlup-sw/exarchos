# Overhaul Track: Plan Phase

## Purpose

Create detailed implementation plans for large refactors with emphasis on incremental, working-state changes. This phase integrates with the existing `/plan` skill while adding refactor-specific constraints that ensure safety and reversibility.

**Key principle:** Every task leaves the codebase in a working state. No task should break tests or functionality.

## Entry Conditions

- Track is `overhaul`
- Brief phase complete with scope assessment
- State file has `.track = "overhaul"` and `.phase = "brief"` complete
- Refactoring goals documented in brief

## Integration with /plan

The overhaul track leverages the existing `/plan` skill with additional refactor context.

### Invocation

```bash
# Auto-invocation from brief phase
Skill({ skill: "plan", args: "--refactor docs/workflow-state/<feature>.state.json" })
```

### Context Passing

The `/plan` skill receives refactor context from the brief:

1. **Scope boundaries** - Which files/modules are affected
2. **Refactoring goals** - What improvements are targeted
3. **Constraints** - Working state requirements, rollback needs
4. **Test baseline** - Current test status to maintain

### Plan Modifications

When `/plan` receives refactor context, it applies these additional rules:

| Standard Plan | Refactor Plan |
|---------------|---------------|
| Tasks can be feature-incomplete | Each task must leave code functional |
| Tests verify new behavior | Tests verify existing + new behavior |
| Dependencies between tasks | Explicit rollback points identified |
| Parallel execution focus | Sequential safety emphasis |

## Refactor-Specific Emphasis

### 1. Incremental Changes (Working State Guarantee)

**Every task MUST leave code in a working state.**

Requirements per task:
- [ ] Code compiles after task completion
- [ ] All existing tests pass
- [ ] New tests (if added) pass
- [ ] No temporary broken states

Anti-patterns to avoid:
- "Part 1 of 3" tasks that break until Part 3
- Renaming without updating all references
- Interface changes without adapter layers
- Deleting before replacing

**Incremental Strategy Examples:**

| Refactor Type | Safe Approach |
|---------------|---------------|
| Rename | Add alias -> Update references -> Remove old |
| Extract | Create new -> Duplicate logic -> Redirect calls -> Delete original |
| Replace | Add new alongside -> Toggle between -> Verify -> Remove old |
| Restructure | Scaffold new -> Copy behavior -> Redirect -> Clean up |

### 2. Rollback Points

Identify explicit points where the refactor can be safely paused or abandoned.

**Rollback Point Criteria:**
- All tests pass
- No temporary code remains
- Could ship to production if needed
- Clear documentation of state

**Template:**

```markdown
## Rollback Points

### After Task 003
**State:** Old API deprecated, new API available
**Can ship:** Yes
**To resume:** Continue with Task 004
**To abandon:** Remove deprecation warnings, new API becomes optional

### After Task 007
**State:** Migration complete, old code marked for deletion
**Can ship:** Yes
**To resume:** Continue with Task 008 (cleanup)
**To abandon:** Keep both implementations, document tech debt
```

### 3. Test Strategy Per Task

Each task specifies verification requirements:

```markdown
### Task 005: Extract validation logic to shared module

**Test Requirements:**
1. **Existing tests:** All unit tests in `auth.test.ts` must pass unchanged
2. **New tests:** Add `validation.test.ts` with same coverage
3. **Integration:** Run `npm run test:integration` to verify no regressions
4. **Manual verification:** N/A (pure refactor)

**Verification Command:**
npm run test:run -- --coverage
# Coverage must not decrease
```

### 4. Working State Guarantee

After every task completion, verify:

```bash
# Compilation check
npm run build

# Unit tests
npm run test:run

# Integration tests (if applicable)
npm run test:integration

# Lint (code quality)
npm run lint
```

**State tracking in workflow file:**

```json
{
  "tasks": [
    {
      "id": "001",
      "title": "Add new interface",
      "status": "complete",
      "working_state_verified": true,
      "test_results": {
        "passed": 145,
        "failed": 0,
        "coverage": "87%"
      }
    }
  ]
}
```

## Plan Structure Template

Save to: `docs/plans/YYYY-MM-DD-<refactor-name>.md`

```markdown
# Implementation Plan: [Refactor Name]

## Source
- **Brief:** `docs/workflow-state/<feature>.state.json`
- **Track:** Overhaul
- **Affected scope:** [Files/modules from brief]

## Goals Mapping

| Brief Goal | Task ID(s) | Verification |
|------------|------------|--------------|
| [Goal 1] | 001, 002 | [How verified] |
| [Goal 2] | 003-005 | [How verified] |
| [Goal 3] | 006 | [How verified] |

## Working State Strategy

**Approach:** [Describe overall incremental approach]

**Key constraints:**
- [Constraint 1 from brief]
- [Constraint 2 from brief]

## Task Breakdown

### Task 001: [Title]

**Phase:** [RED | GREEN | REFACTOR]

**TDD Steps:**
1. [RED] Write test: `TestName_Scenario_ExpectedOutcome`
   - File: `path/to/test.ts`
   - Expected failure: [Reason]
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `path/to/implementation.ts`
   - Changes: [Description]
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up (if needed)
   - Apply: [Improvement]
   - Run: `npm run test:run` - MUST STAY GREEN

**Working State Check:**
- [ ] Code compiles
- [ ] All tests pass (existing + new)
- [ ] No temporary hacks remain

**Rollback point:** [Yes/No - if Yes, document in Rollback section]

**Dependencies:** [Task IDs or "None"]

---

[Repeat for each task]

## Rollback Points

### After Task [N]
**State:** [Description of codebase state]
**Can ship:** [Yes/No]
**To resume:** [Instructions]
**To abandon:** [Cleanup instructions]

## Verification Checklist

After all tasks complete:
- [ ] All original tests still pass
- [ ] New tests added for new code
- [ ] Code coverage maintained or improved
- [ ] No TODO/FIXME comments left behind
- [ ] Brief goals all achieved
- [ ] Ready for review

## Deferred Items

[Any scope items explicitly deferred, with rationale]
```

## State Updates

### On Plan Completion

```bash
# Set plan artifact path
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.artifacts.plan = "docs/plans/YYYY-MM-DD-<refactor>.md"'

# Add tasks to state (repeat for each task)
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.tasks += [{"id": "001", "title": "Task description", "status": "pending", "working_state_verified": false}]'

# Transition to delegate phase
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.phase = "delegate"'
```

### Task State Structure

```json
{
  "id": "001",
  "title": "Extract validation to shared module",
  "status": "pending",
  "working_state_verified": false,
  "rollback_point": true,
  "dependencies": [],
  "branch": "refactor/001-extract-validation"
}
```

## Exit Conditions

Transition to `delegate` phase when:

- [ ] Plan document created at `docs/plans/`
- [ ] All brief goals mapped to tasks
- [ ] Every task has working state verification criteria
- [ ] Rollback points identified (minimum 1)
- [ ] Test strategy defined per task
- [ ] State file updated with plan path and tasks
- [ ] Phase set to `delegate`

## Transition to Delegate

After plan completion, auto-continue to delegate:

1. Update state with plan path and tasks (see State Updates above)
2. Output: "Refactor plan created with [N] tasks and [M] rollback points. Auto-continuing to delegation..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "delegate", args: "docs/workflow-state/<feature>.state.json" })
   ```

This is NOT a human checkpoint - workflow continues autonomously.

## Anti-Patterns

| Avoid | Instead |
|-------|---------|
| Big-bang refactors | Break into working-state increments |
| Skipping tests | Each task verifies existing + new |
| Hidden dependencies | Explicit rollback points |
| "Will fix later" tasks | Every task self-contained |
| Assuming tests pass | Verify after each task |
