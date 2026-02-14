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

## Teammate Spawn Timeout
If a spawned teammate doesn't respond:
1. Check teammate status: call `exarchos_orchestrate` with `action: "team_status"`
2. If teammate shows as active but idle: send a message via `exarchos_orchestrate` with `action: "team_message"`
3. If teammate is missing: shut down and re-spawn

## Task Claim Conflict
If `exarchos_orchestrate` with `action: "task_claim"` returns ALREADY_CLAIMED:
1. Another agent already claimed this task — skip it
2. Check task status via `exarchos_view` with `action: "tasks"` and `filter: { "taskId": "<id>" }`
3. Do not re-dispatch — the other agent is handling it
