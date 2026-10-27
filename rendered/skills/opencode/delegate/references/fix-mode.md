# Fix Mode (--fixes)

When invoked with `--fixes`, delegation handles review failures instead of initial implementation.

## Trigger

```bash
/exarchos:delegate --fixes docs/specs/YYYY-MM-DD-feature.md
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
     prompt: "[fixer-prompt template with issue details]"
   })
   
   ```

   

   Put each fixer on the earlier branch of its task first (see "The Fixer Continues the Earlier Branch", below).

5. **Re-review after fixes**:
   After all fix tasks complete, auto-invoke review phase:
   ```typescript
   Skill({ skill: "exarchos:review", args: "<state-file>" })
   ```

## The Fixer Continues the Earlier Branch

A fix continues the branch of the earlier attempt of its task. This applies to a fix after a review failure and to a fix of a task that settlement left unresolved. A fixer does not start a new branch: the static-analysis evidence of a task keys on its branch, and a failing record on another branch stays active, so `task_complete` refuses the fix.

The recipe for each runtime:

1. **Without native isolation**, dispatch the fixer to the earlier worktree of the task. It works there, on the earlier branch.
2. **With native isolation**, the fixer gets a new worktree of its own. Git refuses to switch that worktree to a branch that the earlier worktree holds, and git refuses to remove a worktree with changes. So, before the dispatch:
   - Commit the listed files of the task in the earlier worktree, and remove each file that a gate run left there.
   - Run `git worktree remove <earlier path>`.
   - Tell the fixer to run `git switch <earlier branch>` in its own worktree as its base step.
3. In both cases, the fixer rebases the branch onto `<baseCommit>` when HEAD does not hold it, and it keeps the branch name. The base step of the fixer agent does this, then checks `git merge-base --is-ancestor <baseCommit> HEAD`. When the rebase stops on a conflict, the fixer runs `git rebase --abort`, then stops and reports it.
4. Before its claim, the fixer removes each untracked file that a gate run of the earlier attempt left, and it commits none of them. Settlement refuses a worktree whose status is not empty (`uncommitted-changes`).
5. The claim names the worktree of the fixer and the same `branch` as the earlier claim, or no branch when the earlier claim named none.

**A fix on a new branch halts.** After a static-analysis failure, a fix on a new branch halts at the completion leaf, because the failing record of the earlier branch stays active. The recovery: run `check_static_analysis` with `taskId`, the earlier branch as `branch`, `repoRoot: 'auto'` and the `worktreePath` of the new tree. Then settle the claim under a new batch id.


### Gate Chain After Fix

Fix mode addresses review findings on tasks already complete, so it stays on the per-task gate chain. (A task that settlement leaves unresolved inside a delegation wave is not fixed here. Dispatch its fixer, then settle a new batch that claims the task. See Step 3 of the skill.)

After the fix completes, run the `task-fix` runbook:
```typescript
exarchos_orchestrate({ action: "runbook", id: "task-fix" })
```

This executes the gate chain: kill-probe adequacy (`check_test_adequacy`) → static analysis for the task (`check_static_analysis` with `taskId`) → mark task complete if all pass. Bind the `<baseRef>` template variable to the branch the task forked from (the workflow's integration branch, `synthesis.integrationBranch`): the kill probe measures the fix from it, and blocks with `base-missing` without it. Bind `<taskId>` and `<worktreePath>` to the fixed task: static analysis runs per task in its worktree, and `task_complete` accepts only a passing run for the same task. If runbook unavailable, use `describe` to retrieve gate schemas: `exarchos_orchestrate({ action: "describe", actions: ["check_test_adequacy", "check_static_analysis", "task_complete"] })`

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
