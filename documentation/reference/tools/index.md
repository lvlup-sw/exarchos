# MCP Tools Overview

Exarchos exposes 4 composite MCP tools plus 1 hidden sync tool. Each tool is a discriminated union keyed on the `action` parameter.

## Design Principles

**Composite tools over many small tools.** 4 visible tools instead of 40+. Each tool groups related actions behind a single MCP tool registration. This keeps tool registration under 500 tokens total.

**Lazy schema loading.** Tools register with slim descriptions and action-name enums only. Full parameter schemas load on demand via the `describe` action, which every tool supports. Agents call `describe` when they need exact parameter shapes for a specific action.

**Agent-first.** Structured JSON input, strict Zod validation, clear error messages with error codes. The same dispatch function backs both MCP transport and CLI, so behavior is identical regardless of interface.

## The 4 Tools

| Tool | Purpose | Action Count |
|------|---------|-------------|
| [`exarchos_workflow`](workflow.md) | Workflow lifecycle | 7 (init, get, set, cancel, cleanup, reconcile, describe) |
| [`exarchos_event`](event.md) | Event sourcing | 4 (append, query, batch_append, describe) |
| [`exarchos_orchestrate`](orchestrate.md) | Coordination, quality gates, scripts | 25 (task lifecycle, review, gates, scripts, runbooks, agent specs, describe) |
| [`exarchos_view`](view.md) | CQRS projections | 15 (pipeline, tasks, telemetry, readiness, convergence, describe) |

A 5th tool, `exarchos_sync`, handles remote synchronization. It is hidden from MCP registration (not exposed to agents) but accessible via CLI.

## Using `describe`

Every tool supports a `describe` action. Call it with specific action names to get full parameter schemas before invoking them:

```json
{ "action": "describe", "actions": ["init", "get"] }
```

Returns full Zod schemas, descriptions, gate metadata (blocking status, quality dimension), and phase/role constraints for each requested action. The `actions` array accepts 1-10 action names.

## Discriminated Union Dispatch

All tools use the same dispatch pattern. The `action` field is a required string enum that routes to the correct handler. Per-action parameters are validated by the handler, not at the composite schema level -- all non-`action` fields are optional in the registration schema.

```json
{ "action": "pipeline" }
```

Invalid action names return a validation error listing valid actions. Missing required parameters for a specific action return a validation error listing the missing fields.

## Phase and Role Constraints

Each action is scoped to specific workflow phases and roles. Calling an action outside its allowed phases or with the wrong role returns an error with the valid phases/roles. Use `describe` to inspect these constraints before calling.

Roles: `lead` (orchestrator agent), `teammate` (subagent), `any` (either).
