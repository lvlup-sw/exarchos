# Delegation Troubleshooting

## MCP Tool Call Failed
If an Exarchos MCP tool returns an error:
1. Check the error message — it usually contains specific guidance
2. Verify the workflow state exists: call `exarchos_workflow` with `action: "get"` and the featureId
3. If "version mismatch": another process updated state — retry the operation
4. If state is corrupted: call `exarchos_workflow` with `action: "cancel"` and `dryRun: true`

## State Desync
If workflow state doesn't match git reality:
1. The SessionStart hook runs reconciliation automatically on resume
2. If manual check needed: compare state file with `git log` and branch state
3. Update state via `exarchos_workflow` with `action: "set"` to match git truth

## Worktree Creation Failed
If `git worktree add` fails:
1. Check if the branch already exists: `git branch --list <branch-name>`
2. Check if a worktree already exists at the path: `git worktree list`
3. If stale worktree: `git worktree prune` then retry
4. If branch conflict: use a unique branch name

## Subagent Not Responding
If a spawned subagent doesn't respond:
1. Check task output via the runtime's result-collection primitive (`{{SUBAGENT_RESULT_API}}`)
2. If the subagent is stuck: stop it with the runtime's task-stop primitive and re-dispatch
<!-- requires:team:agent-teams -->
3. For Agent Teams: use Claude Code's native teammate messaging (Shift+Up/Down to select, then type)
<!-- /requires -->

## Task Claim Conflict
If `exarchos_orchestrate` with `action: "task_claim"` returns ALREADY_CLAIMED:
1. Another agent already claimed this task — skip it
2. Check task status via `exarchos_view` with `action: "tasks"` and `filter: { "taskId": "<id>" }`
3. Do not re-dispatch — the other agent is handling it

## Common Workflow Errors

### Error: `all-tasks-complete not satisfied: N task(s) incomplete`

**Cause:** The runtime's native task list was modified, but exarchos workflow state was not synced. The `all-tasks-complete` guard checks the exarchos workflow `tasks[]` array, NOT any runtime-native task list.

<!-- requires:team:agent-teams -->
On Claude Code with Agent Teams, this typically happens when teammates update their `TaskList` via `TaskUpdate` but the orchestrator hasn't mirrored those statuses into exarchos workflow state.
<!-- /requires -->


**Solution:** Before transitioning to review, call `exarchos_workflow set` with updated task statuses:
```json
{
  "action": "set",
  "featureId": "<id>",
  "updates": {
    "tasks": [
      { "id": "1", "status": "complete" },
      { "id": "2", "status": "complete" }
    ]
  }
}
```

### Error: `Expected object, received array` when setting reviews

**Cause:** The `reviews` field requires a keyed object, not an array.

**Solution:** Use named keys for each review:
```json
{
  "reviews": {
    "spec-review": { "status": "pass", "issues": [] },
    "quality-review": { "status": "pass", "issues": [] }
  }
}
```

### Error: `No transition from 'explore' to 'plan'`

**Cause:** Refactor workflows use different phase names than feature workflows. Feature uses `plan`, refactor uses `overhaul-plan` (overhaul track) or `polish-implement` (polish track).

**Solution:** Check the `validTargets` array in the error response. For refactor overhaul: use `overhaul-plan`. For refactor polish: use `polish-implement`. Use `exarchos_workflow get` with `query: "phase"` to confirm current phase (fast-path for scalar queries).

### Error: `invalid_enum_value` on event type (e.g., `wave.completed`)

**Cause:** The event type string doesn't match the enum. Common mistakes: `wave.completed` (not a valid type), `task.progress` (use `task.progressed`).

**Solution:** Use exact type strings from the Event Emission Contract table in SKILL.md. Valid team delegation types: `team.spawned`, `team.task.planned`, `team.teammate.dispatched`, `team.disbanded`, `team.task.completed`, `team.task.failed`.

### Error: `Guard 'triage-complete' failed: triage-complete not satisfied`

**Cause:** The guard checks for `state.triage.symptom`, not `state.triage.complete` or `state.triageComplete`.

**Solution:** Set the `triage.symptom` field:
```json
{
  "action": "set",
  "featureId": "<id>",
  "updates": {
    "triage": { "symptom": "<description of the bug or issue>" }
  }
}
```

### Error: `Guard 'root-cause-found' failed`

**Cause:** Guard checks `state.investigation.rootCause`, not `state.rootCause`.

**Solution:** Set `investigation.rootCause`:
```json
{
  "action": "set",
  "featureId": "<id>",
  "updates": {
    "investigation": { "rootCause": "<root cause description>" }
  }
}
```
