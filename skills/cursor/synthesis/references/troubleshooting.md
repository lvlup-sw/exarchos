# Troubleshooting

## Handling Failures

### Test Failure (Unexpected)

If tests fail during synthesis (they passed in review):

1. Return to review phase to investigate
2. Re-run `/exarchos:review` to diagnose
3. Dispatch fixes via `/exarchos:delegate --fixes`
4. Return to synthesis after review passes

### PR Checks Fail

1. Wait for CI feedback
2. Create fix task for failures
3. Push fixes to the stack branches
4. Re-run synthesis verification

### Merge Queue Rejection

If the merge queue rejects a PR:
1. Check CI status via `exarchos_orchestrate({ action: "check_ci", prId: "<number>" })`
2. Fix failing checks
3. Push fixes and re-enqueue

## Handling PR Feedback

If the user receives PR review comments:

1. Route to the shepherd skill:
   ```typescript
   Skill({ skill: "exarchos:shepherd", args: "[PR_URL]" })
   ```

2. Shepherd reads PR comments, assesses CI, and applies fixes directly
3. After fixes, return to merge confirmation

## Final Report Template

```markdown
## Synthesis Complete

### Pull Requests
[PR URLs from list_prs action]

### Stack Branches
- task/001-types
- task/002-api
- task/003-tests

### Test Results
- Unit tests: PASS
- Type check: PASS
- Lint: PASS
- Build: PASS

### Next Steps
1. Wait for CI/CD checks
2. Request code review (if required)
3. Merge when approved
4. Worktrees will be cleaned up after merge

### Documentation
- Design: docs/designs/YYYY-MM-DD-feature.md
- Plan: docs/plans/YYYY-MM-DD-feature.md
```

## MCP Tool Call Failed
If an Exarchos MCP tool returns an error:
1. Check the error message -- it usually contains specific guidance
2. Verify the workflow state exists: call `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "get"` and the featureId
3. If "version mismatch": another process updated state -- retry the operation
4. If state is corrupted: call `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "cancel"` and `dryRun: true`

## State Desync
If workflow state doesn't match git reality:
1. The SessionStart hook runs reconciliation automatically on resume
2. If manual check needed: compare state file with `git log` and branch state
3. Update state via `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "set"` to match git truth

## PR Creation Failed
If `create_pr` fails:
1. Check the error output for specific guidance
2. Run `exarchos_orchestrate({ action: "list_prs", state: "open" })` to verify the branch state
3. If rebase conflict: run `git rebase origin/<base>` to resolve
4. If authentication issue: check VCS provider token permissions

## Stack Rebase Conflict
If `git rebase` encounters conflicts:
1. Resolve conflicts manually in each affected file
2. Run `git add <resolved-files>` then `git rebase --continue`
3. After resolution, push with `git push --force-with-lease`

## Exarchos Integration

When Exarchos MCP tools are available:

1. **After stack submission:** Call `mcp__plugin_exarchos_exarchos__exarchos_event` with `action: "append"` with event type `stack.enqueued` including PR numbers from `exarchos_orchestrate({ action: "list_prs", state: "open" })`
2. **Monitor merge status:** Use `exarchos_orchestrate({ action: "list_prs", state: "all" })` to check stack/PR status
3. **On successful merge:** Call `mcp__plugin_exarchos_exarchos__exarchos_event` with `action: "append"` with event type `phase.transitioned` to mark workflow complete

## Performance Notes

- Complete each step fully before advancing -- quality over speed
- Do not skip validation checks even when the change appears trivial
- Verify all tests pass before creating PR. Do not skip the pre-submit validation step.
