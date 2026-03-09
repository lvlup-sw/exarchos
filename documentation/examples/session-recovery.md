---
outline: deep
---

# Session Recovery

This example walks through checkpointing a workflow, losing context, and rehydrating to continue where you left off.

## Setting the Scene

You are in the middle of a feature workflow building a notification system. Delegation is running with five tasks. Two have completed, two are in progress, and one is pending. You need to close your laptop for a meeting.

## Checkpoint

Save your progress before stepping away:

```
/exarchos:checkpoint
```

```
Checkpoint saved:
  Workflow: notification-system (feature)
  Phase: delegate
  Tasks: 2 completed, 2 in-progress, 1 pending
  Artifacts:
    Design: docs/designs/2026-03-07-notifications.md
    Plan: docs/plans/2026-03-07-notifications.md
    Branches: feat/001-email-sender (merged), feat/003-notification-prefs (merged)
  State saved to event store
```

You close your laptop and go to your meeting.

## The Next Day

You open Claude Code the next morning. A new session starts. The SessionStart hook detects an active workflow:

```
Active workflow detected: notification-system (delegate phase)
  2 tasks completed, 2 in-progress, 1 pending
Run /exarchos:rehydrate to resume.
```

The hook does not load the full workflow state. It tells you a workflow exists and gives you the command to resume.

## Rehydrate

```
/exarchos:rehydrate
```

Rehydration reads the workflow state and recent events from the event store. Here is what loads into context:

```
Rehydrated: notification-system

  Type: feature
  Phase: delegate
  Design: docs/designs/2026-03-07-notifications.md
  Plan: docs/plans/2026-03-07-notifications.md

  Tasks:
    001 email-sender:        completed  ✓
    002 push-notifier:        in-progress (check status)
    003 notification-prefs:   completed  ✓
    004 notification-router:  in-progress (check status)
    005 integration-tests:    pending

  Recent events:
    task.completed (001-email-sender)
    gate.executed (tdd-compliance: pass)
    task.completed (003-notification-prefs)
    gate.executed (tdd-compliance: pass)

  Context cost: ~2.4k tokens
```

The agent now knows the workflow ID, type, current phase, where all artifacts live, which tasks are done, and which need attention. It did not need you to re-explain the project, the design decisions, or the current progress.

## Continue

The agent picks up delegation. It checks the in-progress tasks. Task 2 (push notifier) finished while you were away and is waiting for convergence gate verification. Task 4 (notification router) completed as well.

Both tasks pass their gates. Task 5 (integration tests) is dispatched. It completes, passes review, and synthesis creates a PR. You merge and clean up.

The entire resumption took about 2.4k tokens of rehydration context. From there, the workflow continued as if you had never left.

## What If You Don't Checkpoint?

You do not lose your work. The PreCompact hook runs `/checkpoint` automatically before Claude Code compacts your context window. So even if you forget to checkpoint manually, your state is saved before context is lost.

The manual `/checkpoint` is for intentional breaks: closing your laptop, ending your workday, switching to a different project. It confirms what was saved and gives you the rehydrate command for when you come back.

## What If Context Compacts Mid-Workflow?

Same process. After compaction, the agent's context is shorter but the workflow state in the event store is untouched. Run `/rehydrate` and the agent picks up where it left off.

This can happen multiple times during a long workflow. Each rehydration costs about 2-3k tokens regardless of how many phases the workflow has been through. Compare that to re-explaining your project, design decisions, and progress from scratch, which could take 10-20k tokens and still miss details that the event store captured.

## What Gets Preserved

The workflow state captures:

- **Workflow identity.** Feature ID, type, current phase.
- **Artifacts.** File paths to design docs, plans, and PR URLs. The documents are not stored in the state. Their paths are stored, and the agent reads them when it needs the content.
- **Task status.** Which tasks are completed, in-progress, failed, or pending. Completion timestamps and failure details.
- **Worktree locations.** Which branches exist, which worktrees are active, which have been merged.
- **Gate results.** Which convergence gates have passed or failed, and what findings they produced.
- **Event history.** The append-only log of every transition, gate execution, and task event. This is the source of truth. If state ever gets corrupted, `reconcile` rebuilds it from the event history.

All of this survives session breaks, context compaction, and laptop closures. The workflow is durable by default.
