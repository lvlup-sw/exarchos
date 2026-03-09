---
outline: deep
---

# Checkpoint & Resume

## The Problem

Claude Code has a finite context window. When a conversation grows too large, older messages get compacted — summarized and removed. If you are mid-workflow when this happens, the agent loses awareness of your current phase, task progress, and design decisions.

Exarchos stores workflow state externally in an MCP server. Context compaction affects the conversation, not the workflow.

## /checkpoint — Save Your Place

Run this at any point during a workflow:

```
/exarchos:checkpoint
```

What gets saved:

- Current workflow phase (e.g., "delegate", "review")
- Task progress (which tasks are pending, active, completed, failed)
- Artifact references (design doc path, plan path, PR URLs)
- Event history (queryable from the event store, not dumped into context)

Use `/checkpoint` when:

- You are about to close your laptop
- A long-running delegation is underway and you want insurance
- You want to hand off to another session

The PreCompact lifecycle hook also runs `/checkpoint` automatically before context compaction occurs, so you often do not need to do it manually.

## /rehydrate — Pick Up Where You Left Off

Run this when starting a new session or after context compacts:

```
/exarchos:rehydrate
```

What gets restored (about 2-3k tokens):

- Workflow identity (feature ID, type)
- Current phase and what to do next
- Task status summary (counts, not full details)
- Artifact paths (design, plan, PRs)
- Recent events (last few transitions)

The agent reads this state and knows exactly where you are in the workflow. No re-explaining your project from scratch.

## /reload — Lighter Recovery

```
/exarchos:reload
```

Use this when the agent seems confused but you have not lost full context. Reload triggers `/clear`, which fires the PreCompact hook (saving a checkpoint) and then the SessionStart hook (re-injecting context). The result is a fresh conversation with full workflow awareness. Cheaper than rehydrate.

## /autocompact — Proactive Management

```
/exarchos:autocompact          # Show current status
/exarchos:autocompact on       # Enable at 95%
/exarchos:autocompact off      # Disable
/exarchos:autocompact 80       # Set threshold to 80%
```

Autocompact triggers context compaction proactively when your context usage hits the threshold. This gives the PreCompact hook time to checkpoint cleanly, rather than waiting for an emergency compaction.

Changes take effect on the next session. The default of 95% works for most sessions. Set it lower if you run long workflows with many tool calls.

## When to Use Each

| Situation | Command |
|-----------|---------|
| Closing laptop, ending session | `/checkpoint` (or rely on automatic PreCompact) |
| Starting fresh session with active workflow | `/rehydrate` |
| Agent seems confused mid-session | `/reload` |
| Want to control compaction timing | `/autocompact` |

## How It Works Under the Hood

Workflow state lives in the MCP event store, not in conversation memory. Every phase transition, task completion, and artifact creation emits an event. State is reconstructed by replaying events through CQRS projections.

When you checkpoint, state is reconciled against git reality (branches, worktrees, test results). When you rehydrate, state is projected from the event stream and rendered as a compact context document. If a worktree was removed while you were away, or a branch was merged by someone else, the state is updated to match what actually exists.
