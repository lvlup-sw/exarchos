# Overhaul Track: Delegate/Integrate/Review

## Purpose

Execute large refactors using worktree-isolated subagents with the standard delegation workflow.

## Entry Conditions

- Track is `overhaul`
- Plan created with tasks defined
- Tasks defined in plan document

## Phase Flow

```
delegate → integrate → review → [update-docs OR delegate --fixes]
```

## Delegation Phase

Invoke the delegation skill with explicit Skill tool call:

```typescript
Skill({ skill: "delegate", args: "docs/workflow-state/<feature>.state.json" })
```

The `/delegate` skill handles:
- Creating worktrees for each task
- Dispatching subagents via Task tool with `model: "opus"`
- Using the implementer prompt template
- Tracking task completion in state

### Refactor-Specific Task Guidance

Each delegated task should emphasize:

1. **Working State**: Code must compile and tests pass after task
2. **Atomic Changes**: One logical change per commit
3. **Test-First**: New code should have tests

Example task prompt addition:
```
IMPORTANT: After this task, code MUST:
- Build successfully
- Pass all tests
- Not break existing functionality
```

### Task Dependencies

Refactors often have strict ordering:
```
Create new class → Move methods → Update callers → Remove old code
```

Ensure dependencies are respected in delegation.

## Integration Phase

```
/integrate docs/workflow-state/<feature>.state.json
```

### Refactor Integration Focus

| Check | Why It Matters |
|-------|----------------|
| Merge conflicts | Refactors touch shared code |
| Test coverage | Combined changes might miss cases |
| Behavior consistency | Same inputs → same outputs |

### Integration Testing

```bash
# Run full test suite
npm run test:run

# Run integration tests specifically
npm run test:integration

# If applicable, run E2E tests
npm run test:e2e
```

## Review Phase

```
/review docs/workflow-state/<feature>.state.json
```

### Refactor Review Criteria

When type is "refactor", apply additional scrutiny:

| Criterion | Description |
|-----------|-------------|
| Behavior preserved | Same inputs produce same outputs |
| No regressions | Existing functionality works |
| Goals achieved | Brief goals are met |
| Performance OK | No degradation |

See `overhaul-review.md` for detailed criteria.

## State Updates

```bash
# After delegation complete
~/.claude/scripts/workflow-state.sh set <state-file> '.phase = "integrate"'

# After integration passes
~/.claude/scripts/workflow-state.sh set <state-file> '.phase = "review"'

# After review passes
~/.claude/scripts/workflow-state.sh set <state-file> '.phase = "update-docs"'

# After review fails - dispatch fix tasks, loop back
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.reviews.<id>.status = "failed" | .reviews.<id>.findings = ["<issue1>"]'
```

## Auto-Chain Behavior

No human checkpoints in this chain. Automatic progression:

| From | To | Condition |
|------|-----|-----------|
| delegate | integrate | All tasks complete |
| integrate | review | Integration passes |
| review | update-docs | Review passes |
| review | delegate --fixes | Review fails (loop) |

## Transition to Integration

After all tasks complete, auto-continue to integration:

1. Update state: `.phase = "integrate"`
2. Output: "All [N] tasks complete. Auto-continuing to integration..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "integrate", args: "docs/workflow-state/<feature>.state.json" })
   ```

This is NOT a human checkpoint - workflow continues autonomously.

## Transition to Review (after integration)

After integration passes, auto-continue to review:

1. Update state: `.phase = "review"`
2. Output: "Integration passed. Auto-continuing to review..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "review", args: "docs/workflow-state/<feature>.state.json" })
   ```

This is NOT a human checkpoint - workflow continues autonomously.

## Exit Conditions

**Success Path:**
- All tasks delegated and completed
- Integration tests pass
- Review passes
- Ready for update-docs phase

**Failure Path:**
- Review failures documented
- Fix tasks dispatched via `--fixes`:
  ```typescript
  Skill({ skill: "delegate", args: "--fixes docs/workflow-state/<feature>.state.json" })
  ```
- Loop until review passes
