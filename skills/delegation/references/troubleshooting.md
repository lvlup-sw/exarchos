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
1. Check task output: use `TaskOutput` with the agent's task ID and `block: false`
2. If the subagent is stuck: stop it with `TaskStop` and re-dispatch
3. For Agent Teams: use Claude Code's native teammate messaging (Shift+Up/Down to select, then type)

## Task Claim Conflict
If `exarchos_orchestrate` with `action: "task_claim"` returns ALREADY_CLAIMED:
1. Another agent already claimed this task — skip it
2. Check task status via `exarchos_view` with `action: "tasks"` and `filter: { "taskId": "<id>" }`
3. Do not re-dispatch — the other agent is handling it
