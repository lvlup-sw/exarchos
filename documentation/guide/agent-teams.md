---
outline: deep
---

# Agent Teams

Exarchos coordinates multiple Claude Code agents working in parallel. Each agent has a defined role, a scoped set of tools, and its own isolated git worktree. The orchestrator (your main Claude Code session) dispatches tasks and collects results.

## Roles

### Implementer

- Job: write production code following TDD (Red-Green-Refactor)
- Tools: Read, Write, Edit, Bash, Grep, Glob
- Constraint: no production code without a failing test first
- Works in: isolated git worktree on a task-specific branch
- Commits: atomic commits per TDD cycle

### Fixer

- Job: resume a failed implementer task and repair it
- Tools: same as implementer
- Constraint: must reproduce the failure before fixing. Verify the fix does not break other tests.
- Works in: same worktree as the failed task
- Context: gets full failure context (error output, test results, code state)

The fixer follows an adversarial verification protocol. It does not trust the failed agent's self-assessment. It traces actual error output, identifies the root cause, and applies a minimal fix.

### Reviewer

- Job: read-only code quality and spec compliance analysis
- Tools: Read, Grep, Glob, Bash (read-only commands only)
- Constraint: never modifies code. Produces structured findings as JSON.
- Works in: isolated git worktree (read-only access)

The reviewer analyzes a diff rather than full files, reducing context consumption by 80-90%.

## Worktree isolation

Each agent runs in its own git worktree, a separate working directory backed by the same repository. This means:

- Agents cannot interfere with each other's work
- The orchestrator's working directory stays clean
- Multiple implementers can work in parallel on different tasks
- If an agent fails, its worktree contains the partial work for a fixer to continue

Worktrees are created in `.worktrees/` (gitignored) during task dispatch. Each gets a task-specific branch. After merge, `/cleanup` removes worktrees and prunes branches.

## Dispatch and coordination

When `/delegate` runs (auto-continues after plan approval):

1. Readiness check. Validates the workflow is in the delegate phase and the plan exists.
2. Worktree creation. A git worktree is created per task, and dependencies are installed.
3. Prompt construction. Each agent gets a self-contained prompt with task description, file paths, TDD requirements, and quality hints. No cross-references to other tasks.
4. Parallel dispatch. Independent tasks dispatch simultaneously. Dependent tasks are sequenced by the plan's dependency graph.
5. Monitoring. As each agent completes, convergence gates run (TDD compliance, static analysis). If a gate fails, findings are reported.
6. Failure recovery. If a task fails, a fixer agent is dispatched with full failure context.

## Delegation modes

| Mode | Mechanism | Best for |
|------|-----------|----------|
| `subagent` (default) | Background tasks | 1-3 independent tasks, CI, headless |
| `agent-team` | Named team with tmux panes | 3+ interdependent tasks, interactive sessions |

Mode is auto-detected based on tmux availability. Override with `/exarchos:delegate --mode subagent` or `--mode agent-team`.

## Runbooks

Agents request their execution plan from the MCP server:

```
exarchos_orchestrate({ action: "runbook", id: "task-completion" })
```

The response is a sequence of steps: which gate to check, what parameters to pass, what to do on pass or fail. Structured data, not prose instructions. The orchestrator executes each step in order and stops on gate failure.

## Monitoring progress

While agents work, you can check status:

```
exarchos_view({ action: "pipeline" })
```

This returns workflow phase, task counts (pending, active, completed, failed), and current team status.

You do not need to monitor actively. When all tasks complete and pass their gates, the delegate phase transitions to review automatically.
