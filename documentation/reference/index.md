# Reference

This section documents the interfaces and structures that make up Exarchos: commands, skills, agents, scripts, events, configuration, and convergence gates.

## MCP tool architecture

Exarchos exposes 4 composite MCP tools, each a discriminated union keyed on `action`:

| Tool | Purpose | Actions |
|------|---------|---------|
| `exarchos_workflow` | Workflow lifecycle -- init, read, update, cancel, cleanup, reconcile | 7 |
| `exarchos_event` | Event sourcing -- append and query events in streams | 4 |
| `exarchos_orchestrate` | Task coordination, quality gates, script execution, agent specs | 25 |
| `exarchos_view` | Materialized views -- pipeline, tasks, telemetry, convergence | 14 |

A hidden 5th tool (`exarchos_sync`) handles remote synchronization.

Each tool supports a `describe` action that returns full JSON Schema, descriptions, gate metadata, and phase/role constraints for specific actions. This lazy schema pattern keeps initial tool registration lightweight while providing complete schemas on demand.

See [MCP Tools](./tools/) for per-tool action reference.

## Quick links

- [Commands](./commands.md) -- 15 slash commands for workflow control
- [Skills](./skills.md) -- 11 production skills with phase affinity
- [Agents](./agents.md) -- 3 typed agents for isolated work
- [Validation Scripts](./scripts.md) -- Deterministic bash checks replacing prose checklists
- [Events](./events.md) -- 65 event types across 13 categories
- [Configuration](./configuration.md) -- Plugin settings, hooks, integrations
- [Convergence Gates](./convergence-gates.md) -- 5-dimension verification at phase boundaries
