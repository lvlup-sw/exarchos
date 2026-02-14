<!-- Auto-generated from tool registry. Regenerate with: cd plugins/exarchos/servers/exarchos-mcp && npm run generate:docs > ../../../../docs/schemas/tool-reference.md -->

# Exarchos MCP Tool Reference

> Auto-generated from tool registry. Do not edit manually.

## Composite Tools

| Tool | Description | Actions |
|------|-------------|---------|
| `exarchos_workflow` | Workflow lifecycle management — init, read, update, and cancel workflows | init, get, set, cancel |
| `exarchos_event` | Event sourcing — append and query events in streams | append, query |
| `exarchos_orchestrate` | Agent team coordination — spawn, message, and manage teammates and tasks | team_spawn, team_message, team_broadcast, team_shutdown, team_status, task_claim, task_complete, task_fail |
| `exarchos_view` | CQRS materialized views — pipeline, tasks, workflow status, team status, and stack | pipeline, tasks, workflow_status, team_status, stack_status, stack_place |
| `exarchos_sync` | Remote synchronization — trigger immediate sync | now |

## Action Details

### exarchos_workflow

| Action | Description | Phases | Roles |
|--------|-------------|--------|-------|
| `init` | Initialize a new workflow | ideate | lead |
| `get` | Read workflow state with optional query or field projection | all | any |
| `set` | Update workflow state fields or transition phase | all | lead |
| `cancel` | Cancel a workflow with saga compensation | all | lead |

### exarchos_event

| Action | Description | Phases | Roles |
|--------|-------------|--------|-------|
| `append` | Append an event to a stream | all | any |
| `query` | Query events from a stream with optional filtering | all | any |

### exarchos_orchestrate

| Action | Description | Phases | Roles |
|--------|-------------|--------|-------|
| `team_spawn` | Register a new agent teammate with role assignment | delegate | lead |
| `team_message` | Send a direct message to a specific teammate | delegate | lead |
| `team_broadcast` | Broadcast a message to all active teammates | delegate | lead |
| `team_shutdown` | Shut down a teammate agent | delegate | lead |
| `team_status` | Get health status of all teammates | delegate | lead |
| `task_claim` | Claim a task for execution | delegate | teammate |
| `task_complete` | Mark a task as complete with optional result | delegate | teammate |
| `task_fail` | Mark a task as failed with error details | delegate | teammate |

### exarchos_view

| Action | Description | Phases | Roles |
|--------|-------------|--------|-------|
| `pipeline` | Aggregated view of all workflows with stack positions | all | any |
| `tasks` | Task detail view with filtering and projection | all | any |
| `workflow_status` | Workflow phase, task counts, and metadata | all | any |
| `team_status` | Teammate composition and task assignments | all | any |
| `stack_status` | Get current stack positions from events | synthesize, delegate | any |
| `stack_place` | Record a stack position for a task | synthesize, delegate | any |

### exarchos_sync

| Action | Description | Phases | Roles |
|--------|-------------|--------|-------|
| `now` | Trigger immediate sync with remote | all | lead |

## Phase Mappings

| Phase | Available Actions |
|-------|-------------------|
| ideate | workflow:init, workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:team_status, sync:now |
| plan | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:team_status, sync:now |
| plan-review | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:team_status, sync:now |
| delegate | workflow:get, workflow:set, workflow:cancel, event:append, event:query, orchestrate:team_spawn, orchestrate:team_message, orchestrate:team_broadcast, orchestrate:team_shutdown, orchestrate:team_status, orchestrate:task_claim, orchestrate:task_complete, orchestrate:task_fail, view:pipeline, view:tasks, view:workflow_status, view:team_status, view:stack_status, view:stack_place, sync:now |
| review | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:team_status, sync:now |
| synthesize | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:team_status, view:stack_status, view:stack_place, sync:now |
