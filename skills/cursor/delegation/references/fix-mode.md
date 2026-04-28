# Fix Mode (--fixes)

When invoked with `--fixes`, delegation handles review failures instead of initial implementation.

## Trigger

```bash
/exarchos:delegate --fixes docs/plans/YYYY-MM-DD-feature.md
```

Or auto-invoked after review failures.

## Fix Mode Process

1. **Read failure details** from state using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "get"`:
   - Query `reviews` for review failures

2. **Extract fix tasks** from failure reports:

   ```typescript
   exarchos_orchestrate({
     action: "extract_fix_tasks",
     stateFile: "<path>",
     reviewReport: "<path>",
     repoRoot: "<path>"
   })
   ```

   **On `passed: true`:** Tasks extracted successfully (JSON array in output).
   **On `passed: false`:** Parse error — review report or state file malformed.

3. **Create fix tasks** for each issue:
   - Use `fixer-prompt.md` template
   - Include full issue context
   - Specify target worktree

4. **Dispatch fixers** — dispatch a fresh fixer agent using the runtime's native spawn primitive:

   ```typescript
   Task({
     subagent_type: "fixer",
     description: "Fix: [issue summary]",
     prompt: "[fixer-prompt template with issue details]"
   })
   
   ```

   

5. **Re-review after fixes**:
   After all fix tasks complete, auto-invoke review phase:
   ```typescript
   Skill({ skill: "exarchos:review", args: "<state-file>" })
   ```


### Gate Chain After Fix

After the fix completes, run the `task-fix` runbook:
```typescript
exarchos_orchestrate({ action: "runbook", id: "task-fix" })
```

This executes the gate chain: re-run tests → TDD compliance check → static analysis → mark task complete if all pass. If runbook unavailable, use `describe` to retrieve gate schemas: `exarchos_orchestrate({ action: "describe", actions: ["check_tdd_compliance", "check_static_analysis", "task_complete"] })`

## Fix Task Structure

Each fix task extracted should include:

| Field | Description |
|-------|-------------|
| issue | Problem description from review |
| file | File path needing fix |
| line | Line number (if known) |
| worktree | Which worktree to fix in |
| branch | Which branch owns this fix |
| priority | HIGH / MEDIUM / LOW |

## Transition After Fixes

Fix mode goes back to the integration phase after fixes are applied,
then re-enters review to re-integrate and re-verify:

```text
/exarchos:delegate --fixes -> [fixes applied] -> re-integrate -> /exarchos:review
```

This ensures fixed code is re-verified.
