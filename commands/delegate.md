---
description: Dispatch tasks to subagents
---

# Delegate

Delegate tasks for: "$ARGUMENTS"

## Workflow Position

```
/exarchos:ideate → [CONFIRM] → /exarchos:plan → /exarchos:delegate → /exarchos:review → /exarchos:synthesize → [CONFIRM] → merge
                                                       ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲                                            │
                                    │                                    │
                      ON FAIL ──────┤                                    │
                      --pr-fixes ───┴────────────────────────────────────┘
```

Auto-invokes `/exarchos:review` after tasks complete (or `/exarchos:synthesize` for `--pr-fixes` mode).

## Invocation Modes

| Flag | Source | Use Case |
|------|--------|----------|
| (none) | Implementation plan | Initial task delegation |
| `--fixes` | Review issues | Address spec/quality failures |
| `--pr-fixes` | PR comments | Address human review feedback |

## Skill References

Follow the delegation skill for full process details: `@skills/delegate/SKILL.md`

Supporting references:
- Git worktrees: `@skills/git-worktrees/SKILL.md`
- Implementer template: `@skills/delegate/references/implementer-prompt.md`
- Fixer template: `@skills/delegate/references/fixer-prompt.md`
- Fix mode: `@skills/delegate/references/fix-mode.md`
- PR fixes mode: `@skills/delegate/references/pr-fixes-mode.md`
- Parallel strategy: `@skills/delegate/references/parallel-strategy.md`

## Idempotency

Before delegating, check task status:
1. Read tasks from state file
2. Skip tasks where `status == "complete"`
3. Only dispatch pending/failed tasks
4. If all tasks already complete, skip to auto-chain

## Per-Dispatch Event Emission

For **every** task subagent dispatch (including parallel waves), emit a
`task.assigned` event **before** invoking the subagent. Without this event,
the rehydration projection's `taskProgress` is silently empty (tracked by
`#1179` / `#1180`; see [memory: feedback_orchestrator_task_assigned_emission]).

1. Call `mcp__plugin_exarchos_exarchos__exarchos_event` with:
   ```yaml
   action: "append"
   stream: "<featureId>"
   event: {
     type: "task.assigned",
     data: {
       taskId: "<task-id-from-plan>",
       title: "<task title>",
       branch: "<task-branch-name>",
       worktree: "<absolute-worktree-path>",
       assignee: "<subagent-identifier>"
     }
   }
   ```
2. Only after the event is appended, dispatch the subagent (Task tool
   invocation, parallel wave dispatch, or fixer call).

This applies to all three modes (normal, `--fixes`, `--pr-fixes`).

## Auto-Chain

After all delegated tasks complete, **auto-continue immediately** (no user confirmation needed).

- **Normal / --fixes mode:** Transition phase via
  `mcp__plugin_exarchos_exarchos__exarchos_workflow` with
  `action: "transition"`, `featureId: <featureId>`, `target: "review"`.
  Then invoke `Skill({ skill: "exarchos:review", args: "$STATE_FILE" })`.
- **--pr-fixes mode:** Transition phase via
  `mcp__plugin_exarchos_exarchos__exarchos_workflow` with
  `action: "transition"`, `featureId: <featureId>`, `target: "synthesize"`.
  Then invoke `Skill({ skill: "exarchos:synthesize", args: "$PR_URL" })`.

Never set the phase via `action: "update"` — the runtime rejects phase
mutation inside `updates` per `servers/exarchos-mcp/src/workflow/tools.update.test.ts`
("non-phase mutation only"). Phase set must be via `action: "transition"`.

This is NOT a human checkpoint. State is saved automatically for recovery after context compaction.
