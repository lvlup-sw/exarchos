---
name: fix-mode
---

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

4. **Dispatch fixers** — fresh dispatch is the default, with resume as an opt-in optimization on runtimes that support it:

   **Fresh dispatch (cross-platform default):**
   ```typescript
   Task({
     subagent_type: "exarchos-fixer",
     run_in_background: true,
     description: "Fix: [issue summary]",
     prompt: "[fixer-prompt template with issue details]"
   })
   ```

   
   **Resume (runtimes with native session:resume, e.g. Claude Code):**
   ```typescript
   Task({
     resume: "[agentId from workflow state]",
     prompt: "Your implementation failed. [failure context]. Apply adversarial verification."
   })
   ```
   

5. **Re-review after fixes**:
   After all fix tasks complete, auto-invoke review phase:
   ```typescript
   Skill({ skill: "exarchos:review", args: "<state-file>" })
   ```


## Resume-First Strategy

When fixing failed tasks on runtimes with native session resume, prefer resuming the original agent over dispatching a fresh fixer. Resume preserves the implementer's full context (file reads, reasoning, partial progress), making fixes faster and more accurate.

### agentId Tracking

The `agentId` is captured from the `Task()` completion output and stored in workflow task state. The `SubagentStop` hook (`hooks/hooks.json`) automatically captures `agentId` when `exarchos-implementer` or `exarchos-fixer` agents complete.

Check workflow state for `agentId`:
```text
exarchos_workflow get with fields: ["tasks"]
→ tasks[id=<taskId>].agentId
```

### Decision Flow

1. **agentId available?** → Resume with failure context
2. **agentId unavailable?** → Fresh dispatch with `exarchos-fixer` agent type
3. **Resume fails?** → Fall back to fresh dispatch

### Gate Chain After Fix

After any fix (resume or fresh dispatch), run the `task-fix` runbook:
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
