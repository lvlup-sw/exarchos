---
outline: deep
---

# Agent Delegation

This example walks through a feature with parallel agent teams, including what happens when one of the agents fails.

## The plan

You are adding a notification system to your application. The plan has been approved with five tasks. Tasks 1-3 are independent and can run in parallel. Task 4 depends on all three, and task 5 depends on task 4.

```text
Plan: notification-system (5 tasks, 3 parallel groups)

  Group 1 (parallel):
    Task 001: Email sender service with tests
    Task 002: Push notification service with tests
    Task 003: Notification preferences with tests

  Group 2 (sequential):
    Task 004: Notification router (depends on 001, 002, 003)

  Group 3 (sequential):
    Task 005: Integration tests (depends on 004)
```

## Delegation dispatch

After plan approval, `/delegate` prepares worktrees and dispatches three implementer agents simultaneously. Each agent gets its own worktree and a self-contained prompt with the full task description, file paths, and acceptance criteria.

```text
Delegation started: notification-system
  Worktree created: .worktrees/task-001 (branch: feat/001-email-sender)
  Worktree created: .worktrees/task-002 (branch: feat/002-push-notifier)
  Worktree created: .worktrees/task-003 (branch: feat/003-notification-prefs)

  Agent dispatched: task-001 (email sender)
  Agent dispatched: task-002 (push notifier)
  Agent dispatched: task-003 (notification preferences)
```

No agent can see another agent's worktree. They work on isolated branches. Your main working tree is untouched.

## Parallel execution

The three agents work concurrently. Here is the timeline:

```text
t=0m  Task 001 (email):  claimed
t=0m  Task 002 (push):   claimed
t=0m  Task 003 (prefs):  claimed

t=3m  Task 001 (email):  RED — emailSender.test.ts written, tests fail
t=4m  Task 003 (prefs):  RED — preferences.test.ts written, tests fail
t=5m  Task 002 (push):   RED — pushNotifier.test.ts written, tests fail

t=7m  Task 001 (email):  GREEN — emailSender.ts implemented, tests pass
t=8m  Task 003 (prefs):  GREEN — preferences.ts implemented, tests pass
t=9m  Task 002 (push):   GREEN — pushNotifier.ts implemented, tests...

t=10m Task 001 (email):  REFACTOR — cleanup complete
t=10m Task 002 (push):   FAILED — test timeout after 30s
t=11m Task 003 (prefs):  REFACTOR — cleanup complete

t=11m Task 001: convergence gates pass → completed
t=12m Task 003: convergence gates pass → completed
```

Tasks 1 and 3 complete successfully. Task 2 fails with a test timeout.

## Failure recovery

When a task fails, the delegation skill reads the failure output and spawns a fixer agent. The fixer gets the full context: the original task description, the partial implementation, and the test output.

```text
Task 002 failed: test timeout in pushNotifier.test.ts
  Test: "should send push notification to registered device"
  Error: Exceeded timeout of 30000ms
  Partial implementation in .worktrees/task-002

Fixer agent dispatched for task-002
```

The fixer agent examines the failing test. The push notification mock was set up as a synchronous function, but the implementation awaits it. The mock never resolves its promise, so the test hangs until it times out.

```typescript
// Before (broken mock):
const mockPush = vi.fn(() => ({ success: true }));

// After (returns a promise):
const mockPush = vi.fn(() => Promise.resolve({ success: true }));
```

The fixer updates the mock. Tests pass. Convergence gates run and pass. Task 2 is now complete.

```text
t=16m Task 002: fixer completed — mock wasn't returning a promise
t=16m Task 002: convergence gates pass → completed
```

## Sequential tasks

With tasks 1-3 complete, task 4 (notification router) is dispatched. It depends on the interfaces defined by all three services, so it could not start earlier.

```text
t=17m Task 004 (router):  claimed → RED → GREEN → REFACTOR
t=24m Task 004: convergence gates pass → completed

t=25m Task 005 (integration): claimed → RED → GREEN
t=30m Task 005: convergence gates pass → completed
```

Task 5 runs after task 4 finishes. The full delegation takes about 30 minutes of wall time.

## Monitoring

At any point during delegation, you can check progress:

```bash
/exarchos:view pipeline
```

```text
Pipeline: notification-system (delegate phase)

  Task 001 (email sender):          completed  ✓
  Task 002 (push notifier):         completed  ✓ (fixed)
  Task 003 (notification prefs):    completed  ✓
  Task 004 (notification router):   active     ▶
  Task 005 (integration tests):     pending    ○

  Progress: 3/5 completed, 1 active, 1 pending
  Events: 14 recorded
```

You do not need to monitor. The agents work independently. But if you want to know where things stand, the pipeline view shows it.

## Review and ship

All five tasks complete. Two-stage review runs automatically against the combined diff.

Stage 1 (spec compliance): All design requirements trace to code and tests. TDD compliance verified across all five branches, including the fixed task 2.

Stage 2 (code quality): Static analysis clean. No security findings. One context economy suggestion about the notification router's switch statement, classified as informational.

Verdict: **APPROVED**.

Synthesis creates the PR. CI passes. You merge and run `/exarchos:cleanup`. Five worktrees removed, five branches pruned, workflow resolved.

```text
Cleanup complete:
  Feature: notification-system
  PRs merged: 1
  Worktrees removed: 5
  Branches synced: ✓
```
