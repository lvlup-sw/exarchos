---
name: delegation
description: "Dispatch implementation tasks to agent teammates in git worktrees. Use when the user says 'delegate', 'dispatch tasks', 'assign work', 'delegate tasks', or runs /delegate. Spawns teammates, creates worktrees, monitors progress, and collects results. Supports --fixes flag for review finding remediation. Do NOT use for single-file changes or polish-track refactors."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: delegate
---

# Delegation Skill

## Overview

Dispatch implementation tasks to Claude Code subagents with proper context and TDD requirements.

## Triggers

Activate this skill when:
- User runs `/delegate` command
- Implementation plan is ready
- User wants to parallelize work
- Tasks are ready for execution

## Delegation Modes

| Mode | Mechanism | Best for |
|------|-----------|----------|
| `subagent` (default) | `Task` with `run_in_background` | 1-3 independent tasks, CI, headless |
| `agent-team` | `Task` with `team_name` | 3+ interdependent tasks, interactive sessions |

**Auto-detection:** tmux + `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` → `agent-team`. Otherwise → `subagent`. Override with `/delegate --mode subagent|agent-team`.

**CRITICAL:** Always specify `model: "opus"` for coding tasks.

```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",
  description: "Implement user model",
  prompt: `[Full implementer prompt from template]`
})
```

For agent-team event payloads and YAML examples, see `references/agent-teams-saga.md`. For adaptive team composition, see `references/adaptive-orchestration.md`.

## Controller Responsibilities

The orchestrator (you) MUST:

1. **Extract tasks upfront** — Read plan, extract all task details
2. **Provide full context** — Never make subagents read files for task info
3. **Include TDD requirements** — Use implementer prompt template
4. **Track progress** — TodoWrite (subagent) or native TaskList (agent-team)
5. **Set up worktrees** — For parallel execution
6. **Single-writer discipline** (agent-team) — Only the orchestrator mutates `workflow.tasks[]`

## Implementer Prompt Template

Use `@skills/delegation/references/implementer-prompt.md` as template for Task tool prompts.

**Conditional PBT:** When a task has `testingStrategy.propertyTests: true`, include the PBT section from `references/pbt-patterns.md`. When `false`, omit entirely.

## Delegation Workflow — Subagent Mode

1. Prepare worktrees — `scripts/setup-worktree.sh`
2. Extract task details from plan
3. Check for benchmark tasks → set `verification.hasBenchmarks` in state
4. Create TodoWrite entries for tracking
5. Dispatch parallel subagents via Task tool
6. Monitor progress via TaskOutput
7. Collect and verify — `scripts/post-delegation-check.sh`
8. Schema sync if API files modified

For detailed step instructions, see `references/workflow-steps.md`.

## Delegation Workflow — Agent Team Mode (6-Step Saga)

Follow the event-first saga: **emit event → execute side effect** at every step.

| Step | Action | Type |
|------|--------|------|
| Pre-flight | Read tasks, prepare worktrees | — |
| 1 | Create team | Compensable |
| 2 | Create native tasks (batched) | Compensable |
| 3 | Spawn teammates (**pivot**) | Point of no return |
| 4 | Monitor (tiered) | Retryable |
| 5 | Disband | Retryable |
| 6 | Transition to review | Retryable |

For step-by-step instructions, idempotency checks, compensation protocol, and event payloads, see `references/agent-teams-saga.md`.

## Parallel Execution Strategy

Dispatch parallel tasks in a single message with multiple Task calls. See `references/parallel-strategy.md` for group identification, dispatching patterns, and model selection.

## Worktree Enforcement (MANDATORY)

All tasks MUST run in isolated worktrees. Use `scripts/setup-worktree.sh` for setup.

Before dispatching: run `scripts/verify-worktree.sh --cwd <path>`. If exit 1: stop dispatch, report invalid worktree. See `references/worktree-enforcement.md`.

## State Management

Track task progress in workflow state for context persistence. Read tasks with `action: "get"`, `query: "tasks"`. For benchmark labeling, state patterns, and agent-team consistency model, see `references/state-management.md`.

## Fix Mode (--fixes)

Handles review failures instead of initial implementation. Uses `references/fixer-prompt.md` template, dispatches fix tasks per issue, then re-invokes review.

**Arguments:** `--fixes <state-file-path>` — state JSON containing review results in `.reviews.<taskId>.specReview` or `.reviews.<taskId>.qualityReview`.

For detailed process, see `references/fix-mode.md`. For PR feedback workflows (`--pr-fixes`), see `references/pr-fixes-mode.md`.

## Completion Criteria

- [ ] All tasks extracted from plan (or read from state)
- [ ] Worktrees created and validated via verify-worktree.sh
- [ ] Implementers dispatched with full context
- [ ] All tasks report completion, all tests pass
- [ ] Schema sync run if API files modified
- [ ] State file reflects all task completions

## Transition

After all tasks complete, **auto-continue immediately** (no user confirmation):

1. Verify all `tasks[].status === 'complete'` in workflow state
2. Update state: `action: "set"`, `phase: "review"`
3. Invoke: `Skill({ skill: "exarchos:review", args: "<plan-path>" })`

This is NOT a human checkpoint — workflow continues autonomously.

## Known Limitations

- **Agent Teams:** No session resumption, task status lag, one team per session, no nested teams, requires tmux/iTerm2. Cold start falls back to plan's parallel group strategy.
- **Subagents:** No visual monitoring, individual context windows, limited observability.

## Troubleshooting

See `references/troubleshooting.md` for MCP tool failures, state desync, worktree creation, teammate spawn timeouts, and task claim conflicts.

## Exarchos Integration

**Subagent mode:** Emit `task.assigned` on dispatch, use `exarchos_orchestrate task_complete` on completion. Phase transitions auto-emit `workflow.transition`.

**Agent-team mode:** Follow the 6-step saga. Do NOT mix with subagent-mode patterns — the TeammateIdle hook handles completion. See `references/agent-teams-saga.md`.

**Claim guard** (subagent only): Use `exarchos_orchestrate task_claim` for optimistic concurrency. On `ALREADY_CLAIMED`, skip and check status before re-dispatching.
