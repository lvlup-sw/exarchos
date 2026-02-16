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

### Dispatch Mode Selection

| Mode | Mechanism | Visualization | Best for |
|------|-----------|---------------|----------|
| `subagent` (default) | `Task` tool with `run_in_background` | None — orchestrator polls `TaskOutput` | Quick tasks, CI, non-interactive |
| `agent-team` | Natural language delegation to teammates | tmux split panes | Interactive sessions, complex coordination |

**Auto-detection logic:**
- If inside tmux AND Agent Teams enabled → default to `agent-team`
- Otherwise → default to `subagent`
- User can override via `/delegate --mode subagent` or `/delegate --mode agent-team`

> **Verification:** Agent Teams availability is controlled by the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` environment variable in your session settings. Check `~/.claude/settings.json` for the `env` block.

### Task Tool (Subagents)

**Use when:**
- Need immediate results
- Task requires orchestrator coordination
- Want in-session execution
- Working in worktrees

**Tool:** Claude Code `Task` tool with `model: "opus"`

**CRITICAL:** Always specify `model: "opus"` for coding tasks to use Opus 4.5.

```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",  // REQUIRED for coding
  description: "Implement user model",
  prompt: `[Full implementer prompt from template]`
})
```

### Agent Teams (Teammates)

**Use when:**
- Running in tmux with Agent Teams enabled
- Tasks benefit from visual monitoring
- Complex coordination between tasks
- Interactive development sessions

**Mechanism:** Orchestrator delegates to named teammates via natural language

**Dispatch flow:**
1. Orchestrator creates an agent team with N teammates (one per parallel group)
2. Each teammate gets a worktree path in its spawn prompt
3. Orchestrator activates delegate mode (coordination only — no direct code)
4. Teammates self-coordinate via shared task list
5. `TeammateIdle` hook (see State Bridge section below) runs quality gates; updates Exarchos workflow state
6. Orchestrator synthesizes results when all teammates finish

**CRITICAL:** Always specify `model: "opus"` for coding tasks.

## Controller Responsibilities

The orchestrator (you) MUST:

1. **Extract tasks upfront** - Read plan, extract all task details
2. **Provide full context** - Never make subagents read files for task info
3. **Include TDD requirements** - Use implementer prompt template
4. **Track progress** - Use TodoWrite for all tasks
5. **Set up worktrees** - For parallel execution

## Implementer Prompt Template

Use `@skills/delegation/references/implementer-prompt.md` as template for Task tool prompts.

**Key sections:**
- Task description (full text, not file references)
- File paths to modify
- Test requirements (TDD phases)
- Success criteria
- Working directory (worktree path)

## Delegation Workflow

1. Prepare worktrees -- `scripts/setup-worktree.sh`
2. Extract task details from plan
3. Create TodoWrite entries for tracking
4. Dispatch parallel subagents via Task tool
5. Monitor progress via TaskOutput
6. Collect and verify -- `scripts/post-delegation-check.sh`
7. Schema sync if API files modified

For detailed step instructions, see `references/workflow-steps.md`.

## Parallel Execution Strategy

Dispatch parallel tasks in a single message with multiple Task calls. See `@skills/delegation/references/parallel-strategy.md` for group identification, dispatching patterns, and model selection.

## Worktree Enforcement (MANDATORY)

All tasks MUST run in isolated worktrees. Use `scripts/setup-worktree.sh` for setup.

For detailed enforcement rules, pre-dispatch checklist, and anti-patterns, see `references/worktree-enforcement.md`.

## State Management

This skill tracks task progress in workflow state for context persistence.

### Read Tasks from State

Instead of re-parsing plan, read task list using `mcp__exarchos__exarchos_workflow` with `action: "get"` with `query: "tasks"`. For status checks during monitoring, use `fields: ["tasks"]` to reduce response size.

### On Task Dispatch

Update task status when dispatched using `mcp__exarchos__exarchos_workflow` with `action: "set"`:
- Update the task's status to "in_progress"
- Set the task's startedAt timestamp

If creating worktree, also set the worktree entry with branch, status, and either taskId (single task) or tasks (multi-task).

### On Task Complete

Update task status when subagent reports completion using `mcp__exarchos__exarchos_workflow` with `action: "set"`:
- Update the task's status to "complete"
- Set the task's completedAt timestamp

### On All Tasks Complete

Update phase using `mcp__exarchos__exarchos_workflow` with `action: "set"`:
- Set `phase` to "review"

## Fix Mode (--fixes)

When invoked with `--fixes`, delegation handles review failures instead of initial implementation. Uses fixer-prompt template, dispatches fix tasks per issue, then re-invokes review.

**Arguments:** `--fixes <state-file-path>` where `<state-file-path>` is the workflow state JSON containing review results in `.reviews.<taskId>.specReview` or `.reviews.<taskId>.qualityReview`.

For detailed fix mode process, task structure, and transition flow, see `@skills/delegation/references/fix-mode.md`.

## Completion Criteria

- [ ] All tasks extracted from plan (or read from state)
- [ ] Worktrees created for parallel groups
- [ ] State file updated with worktree locations
- [ ] TodoWrite updated with all tasks
- [ ] Implementers dispatched with full context
- [ ] All tasks report completion
- [ ] All tests pass in worktrees
- [ ] Schema sync run if API files modified
- [ ] State file reflects all task completions

## Transition

After all tasks complete, **auto-continue immediately** (no user confirmation):

1. Update state: `.phase = "review"`, mark all tasks complete
2. Output: "All [N] tasks complete. Auto-continuing to review..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "review", args: "<plan-path>" })
   ```

This is NOT a human checkpoint - workflow continues autonomously.
State is saved, enabling recovery after context compaction.

## Known Limitations

**Agent Teams mode:**
- No session resumption with in-process teammates (`/resume` doesn't restore them)
- Task status can lag — teammates sometimes fail to mark tasks complete
- One team per session
- No nested teams (teammates can't spawn sub-teammates)
- Split panes require tmux or iTerm2 (not VS Code terminal, Windows Terminal, or Ghostty)

**Task Tool mode:**
- No visual monitoring
- Individual context windows per task
- Limited observability

## Troubleshooting

See `@skills/delegation/references/troubleshooting.md` for detailed troubleshooting covering MCP tool failures, state desync, worktree creation, teammate spawn timeouts, and task claim conflicts.

## Exarchos Integration

Emit events at each delegation milestone using Exarchos MCP tools:

1. **Delegation start:** `exarchos_event` append `workflow.started` (if not already emitted)
2. **Task dispatch:** Launch subagents via Claude Code `Task` tool. Inter-agent messaging uses Claude Code's native Agent Teams (not Exarchos)
3. **Task assignment:** `exarchos_event` append `task.assigned` with taskId, title, branch, worktree
4. **Monitor:** `exarchos_view` `workflow_status` or `exarchos_workflow` `get` with `fields: ["tasks"]`
5. **Task completion:** Record stack positions via `exarchos_view` `stack_place`. Subagents handle Graphite stacking via `gt create`
6. **All complete:** Auto-emitted by `exarchos_workflow` `set` when phase transitions — emits `workflow.transition` from delegate to next phase

### Claim Guard

Use `exarchos_orchestrate` `task_claim` for optimistic concurrency. On `ALREADY_CLAIMED`, skip the task and check status via `exarchos_view` `tasks` before re-dispatching.

### State Bridge (TeammateIdle)

When using Agent Teams mode, the `TeammateIdle` hook fires when a teammate completes its work and becomes idle, bridging real-time Agent Teams coordination with persistent Exarchos state:

- **On quality pass:** Updates the matching task's status to "complete" in the workflow state file
- **On quality fail:** Returns exit code 2 (sends feedback to teammate, keeps it working)
- **Graceful degradation:** If no matching workflow/worktree found, gate still passes

This implements a **layered coordination** model:
- Agent Teams handles real-time dispatch and self-coordination
- Exarchos handles persistent workflow state and event sourcing
