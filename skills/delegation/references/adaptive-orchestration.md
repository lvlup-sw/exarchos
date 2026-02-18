# Adaptive Orchestration

When using Agent Teams mode, the orchestrator can leverage historical data for smarter team composition.

## Pre-Delegation Intelligence

Before creating the team, query the TeamPerformanceView for historical teammate metrics:
- `exarchos_view` with `action: 'team_performance'` -- teammate efficiency, module expertise, quality gate pass rates
- Use `synthesizeIntelligence()` from SubagentStart hook for historical fix-cycle patterns per module

## Team Composition

Informed by historical metrics:
- **Team sizing:** Use `teamSizing.avgTasksPerTeammate` to determine optimal teammate count
- **Task assignment:** Match modules to teammates with relevant `moduleExpertise`
- **Cold start:** When no historical data exists, fall back to plan's parallel groups for sizing

## Guard-Aware Task Graph

Before creating the native Claude Code task list:
1. Build a dependency graph from plan task `blockedBy` fields
2. Identify the critical path through the dependency chain
3. Front-load independent tasks for maximum parallelism
4. On TeammateIdle, scan the task graph for newly unblocked tasks (tasks whose `blockedBy` dependencies are all completed) so teammates can claim them

## Intelligence Views

Two CQRS views provide team analytics:

- `exarchos_view` with `action: 'team_performance'` -- Query before delegation for team sizing and module assignment. Returns teammate metrics (tasks completed, avg duration, module expertise, quality gate pass rates) and team sizing recommendations.
- `exarchos_view` with `action: 'delegation_timeline'` -- Query after delegation for retrospective analysis. Returns task timeline with bottleneck detection (longest task, blocking dependencies).
