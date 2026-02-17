
> @lvlup-sw/exarchos-mcp@1.0.0 generate:docs
> tsx scripts/generate-docs.ts

# Exarchos MCP Tool Reference

> Auto-generated from tool registry. Do not edit manually.

## Composite Tools

| Tool | Description | Actions |
|------|-------------|---------|
| `exarchos_workflow` | Workflow lifecycle management — init, read, update, and cancel workflows | init, get, set, cancel |
| `exarchos_event` | Event sourcing — append and query events in streams | append, query |
| `exarchos_orchestrate` | Task coordination — claim, complete, and fail tasks | task_claim, task_complete, task_fail |
| `exarchos_view` | CQRS materialized views — pipeline, tasks, workflow status, stack, and telemetry | pipeline, tasks, workflow_status, stack_status, stack_place, telemetry |
| `exarchos_sync` | Remote synchronization — trigger immediate sync | now |

## Action Details

### exarchos_workflow

| Action | Description | Phases | Roles |
|--------|-------------|--------|-------|
| `init` | Initialize a new workflow. Auto-emits workflow.started event |  | lead |
| `get` | Read workflow state with optional query or field projection | all | any |
| `set` | Update workflow state fields or transition phase. Auto-emits workflow.transition events when phase is provided — do not duplicate via event append | all | lead |
| `cancel` | Cancel a workflow with saga compensation. Auto-emits workflow.cancel and compensation events | all | lead |

### exarchos_event

| Action | Description | Phases | Roles |
|--------|-------------|--------|-------|
| `append` | Append an event to a stream | all | any |
| `query` | Query events from a stream with optional filtering | all | any |

### exarchos_orchestrate

| Action | Description | Phases | Roles |
|--------|-------------|--------|-------|
| `task_claim` | Claim a task for execution | delegate, overhaul-delegate, debug-implement | teammate |
| `task_complete` | Mark a task as complete with optional result. Auto-emits task.completed event | delegate, overhaul-delegate, debug-implement | teammate |
| `task_fail` | Mark a task as failed with error details. Auto-emits task.failed event | delegate, overhaul-delegate, debug-implement | teammate |

### exarchos_view

| Action | Description | Phases | Roles |
|--------|-------------|--------|-------|
| `pipeline` | Aggregated view of all workflows with stack positions | all | any |
| `tasks` | Task detail view with filtering and projection | all | any |
| `workflow_status` | Workflow phase, task counts, and metadata | all | any |
| `stack_status` | Get current stack positions from events | synthesize, delegate, overhaul-delegate, debug-implement | any |
| `stack_place` | Record a stack position for a task | synthesize, delegate, overhaul-delegate, debug-implement | any |
| `telemetry` | Get telemetry metrics with per-tool performance data and optimization hints | all | any |

### exarchos_sync

| Action | Description | Phases | Roles |
|--------|-------------|--------|-------|
| `now` | Trigger immediate sync with remote | all | lead |

## Phase Mappings

| Phase | Available Actions |
|-------|-------------------|
| blocked | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| brief | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| debug-implement | workflow:get, workflow:set, workflow:cancel, event:append, event:query, orchestrate:task_claim, orchestrate:task_complete, orchestrate:task_fail, view:pipeline, view:tasks, view:workflow_status, view:stack_status, view:stack_place, view:telemetry, sync:now |
| debug-review | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| debug-validate | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| delegate | workflow:get, workflow:set, workflow:cancel, event:append, event:query, orchestrate:task_claim, orchestrate:task_complete, orchestrate:task_fail, view:pipeline, view:tasks, view:workflow_status, view:stack_status, view:stack_place, view:telemetry, sync:now |
| design | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| explore | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| hotfix-implement | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| hotfix-validate | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| ideate | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| investigate | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| overhaul-delegate | workflow:get, workflow:set, workflow:cancel, event:append, event:query, orchestrate:task_claim, orchestrate:task_complete, orchestrate:task_fail, view:pipeline, view:tasks, view:workflow_status, view:stack_status, view:stack_place, view:telemetry, sync:now |
| overhaul-plan | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| overhaul-review | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| overhaul-update-docs | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| plan | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| plan-review | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| polish-implement | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| polish-update-docs | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| polish-validate | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| rca | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| review | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
| synthesize | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:stack_status, view:stack_place, view:telemetry, sync:now |
| triage | workflow:get, workflow:set, workflow:cancel, event:append, event:query, view:pipeline, view:tasks, view:workflow_status, view:telemetry, sync:now |
