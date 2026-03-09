---
outline: deep
---

# How it works

## MCP server as state backend

Exarchos ships as a single binary with an `mcp` subcommand. Claude Code spawns it as a stdio MCP server. No network listeners, no database, no external dependencies.

Four composite tools cover the entire API surface:

| Tool | Purpose |
|------|---------|
| `exarchos_workflow` | Workflow lifecycle: init, get, set, cancel, cleanup, reconcile |
| `exarchos_event` | Append-only event store: append, query, batch |
| `exarchos_orchestrate` | Team coordination: task dispatch, review triage, script execution, runbooks |
| `exarchos_view` | CQRS projections: pipeline status, task boards, convergence, stack health |

Every tool input is a Zod-validated discriminated union keyed on `action`. The same dispatch function backs both the MCP transport and the CLI, so `exarchos workflow get --featureId my-feature` from a terminal returns the same result the agent gets through MCP.

## Event-sourced append-only log

Every action produces events stored in JSONL files on the local filesystem. State is a projection of events, not a mutable record.

When you call `exarchos_workflow({ action: "get", featureId: "my-feature" })`, the server replays events and returns the computed current state. CQRS view projections (pipeline, tasks, convergence) work the same way: fold events into a view, return the result.

If the state file gets corrupted or deleted, `reconcile` rebuilds it by replaying the event log. The events are the source of truth. Everything else is derived.

## State machine enforcing phase transitions

The workflow state machine defines valid transitions for each workflow type. Feature workflows can move from `ideate` to `plan`, but not from `ideate` to `review`. Debug workflows branch into hotfix and thorough tracks. Refactor workflows branch into polish and overhaul tracks.

Guards check preconditions before each transition: does a plan document exist? Have all tasks completed? Did convergence gates pass? If a guard fails, the transition is rejected with a message explaining what's missing.

```text
ideate → plan → plan-review → delegate → review → synthesize → completed
```

The agent can query valid transitions for any state with `exarchos_workflow({ action: "transitions" })` and get back the phases it can move to.

## Lazy schema registration

At startup, each tool registers with a slim description and an enum of available actions. Total cost: under 500 tokens across all four tools. No parameter schemas are loaded yet.

When the agent needs to call a specific action, it calls `describe` to get the full parameter schema on demand. A typical session uses 5-6 actions out of the 30+ available. Lazy loading avoids spending tokens on the rest.

## Field projection

State queries accept an optional `fields` parameter that specifies which parts of the state to return. Instead of fetching the full workflow state object (which can run to several hundred tokens), the agent requests just the fields it needs.

```json
{
  "action": "get",
  "featureId": "my-feature",
  "fields": ["phase", "tasks"]
}
```

This reduces token consumption by roughly 90% for common queries like "what phase am I in?" or "which tasks are still pending?"

## Lifecycle hooks

Eight hooks automate verification at specific moments in the session lifecycle:

| Hook | Trigger | What it does |
|------|---------|--------------|
| `PreCompact` | Before context compaction | Checkpoints the active workflow so it can be rehydrated |
| `SessionStart` | Session start or resume | Detects active workflows and restores context |
| `PreToolUse` | Before any Exarchos MCP call | Guards invalid operations based on phase and role |
| `TaskCompleted` | After a task finishes | Runs convergence gates against the completed work |
| `TeammateIdle` | When a subagent goes idle | Verifies teammate work quality |
| `SubagentStart` | When a subagent starts | Injects workflow context into the subagent |
| `SubagentStop` | When an implementer or fixer stops | Processes subagent completion results |
| `SessionEnd` | Session ends | Persists final state |

Hooks run as fast-path CLI subcommands that skip heavy initialization. The `PreCompact` hook snapshots state in under 30 seconds. The `PreToolUse` guard runs in under 5 seconds.

Without hooks, the agent could skip quality gates by not calling them. With hooks, verification runs automatically whether the agent remembers or not.
