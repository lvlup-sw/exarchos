---
name: troubleshooting
---

# Troubleshooting

## MCP Tool Call Failed
If an Exarchos MCP tool returns an error:
1. Check the error message -- it usually contains specific guidance
2. Verify the workflow state exists: call `mcp__exarchos__exarchos_workflow` with `action: "get"` and the featureId
3. If "version mismatch": another process updated state -- retry the operation
4. If state is corrupted: call `mcp__exarchos__exarchos_workflow` with `action: "cancel"` and `dryRun: true`

## State Desync
If workflow state doesn't match git reality:
1. The SessionStart hook runs reconciliation automatically on resume
2. If manual check needed: compare state file with `git log` and branch state
3. Update state via `mcp__exarchos__exarchos_workflow` with `action: "set"` to match git truth

## Investigation Timeout (Hotfix Track)
If 15-minute investigation timer expires without root cause:
1. The workflow auto-switches to thorough track
2. All investigation findings are preserved in state
3. Continue investigation without time constraint

## Track Switching
If hotfix track reveals complexity requiring thorough investigation:
1. Call `mcp__exarchos__exarchos_workflow` with `action: "set"` to update track to "thorough"
2. Previous investigation findings carry over
3. RCA phase begins after investigation completes

## Exarchos Integration

When Exarchos MCP tools are available, emit events throughout the debug workflow:

1. **At workflow start (triage):** `mcp__exarchos__exarchos_event` with `action: "append"` -> `workflow.started` with workflowType "debug", urgency
2. **On track selection:** `mcp__exarchos__exarchos_event` with `action: "append"` -> `phase.transitioned` with selected track (hotfix/thorough)
3. **On each phase transition:** `mcp__exarchos__exarchos_event` with `action: "append"` -> `phase.transitioned` from->to
4. **Thorough track stacking:** Handled by `/exarchos:synthesize` (Graphite stack submission)
5. **Hotfix track commit:** Single `gt create -m "fix: <description>"` -- no multi-branch stacking needed
6. **On complete:** `mcp__exarchos__exarchos_event` with `action: "append"` -> `phase.transitioned` to "completed"

## Performance Notes

- Complete each step fully before advancing -- quality over speed
- Do not skip validation checks even when the change appears trivial
- Complete each investigation step before concluding root cause. Do not jump to fix without evidence.
