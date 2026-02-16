# Fix Mode (--fixes)

When invoked with `--fixes`, delegation handles review failures instead of initial implementation.

## Trigger

```bash
/delegate --fixes docs/plans/YYYY-MM-DD-feature.md
```

Or auto-invoked after review failures.

## Fix Mode Process

1. **Read failure details** from state using `mcp__exarchos__exarchos_workflow` with `action: "get"`:
   - Query `reviews` for review failures

2. **Extract fix tasks** from failure reports:
   - Parse issue descriptions
   - Identify file paths and line numbers
   - Determine which worktree/branch owns the fix

3. **Create fix tasks** for each issue:
   - Use `fixer-prompt.md` template
   - Include full issue context
   - Specify target worktree

4. **Dispatch fixers** (same as implementers, different prompt):
   ```typescript
   Task({
     subagent_type: "general-purpose",
     model: "opus",
     description: "Fix: [issue summary]",
     prompt: "[fixer-prompt template with issue details]"
   })
   ```

5. **Re-review after fixes**:
   After all fix tasks complete, auto-invoke review phase:
   ```typescript
   Skill({ skill: "review", args: "<state-file>" })
   ```

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
/delegate --fixes -> [fixes applied] -> re-integrate -> /review
```

This ensures fixed code is re-verified.
