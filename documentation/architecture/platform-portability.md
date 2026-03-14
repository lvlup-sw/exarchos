---
outline: deep
---

# Platform Portability

Exarchos ships as a Claude Code plugin, but the MCP server and event store have no dependency on Claude Code. Any MCP-capable client can connect to the stdio server and use all four composite tools directly.

## Adapter layers

Three adapters translate between transport formats and the core dispatch engine. All three call the same handlers -- the difference is how input arrives.

### MCP adapter

`servers/exarchos-mcp/src/adapters/mcp.ts`

Stdio MCP server built on `@modelcontextprotocol/sdk`. Registers each composite tool with its Zod schema and dispatches incoming JSON-RPC calls. Works with any MCP client: Cursor, Copilot CLI, Windsurf, Continue, or anything else that speaks the protocol.

### CLI adapter

`servers/exarchos-mcp/src/adapters/cli.ts`

Commander program auto-generated from the tool registry. Composite tools become top-level commands, actions become subcommands, flags come from Zod schemas. Good for scripting, debugging, and environments without MCP.

```bash
# Same operation, CLI instead of MCP
exarchos workflow init --feature-id my-feature --workflow-type feature
```

### Hook adapter

`servers/exarchos-mcp/src/cli-commands/`

Claude Code lifecycle handlers: SessionStart, PreCompact, TaskCompleted, TeammateIdle, SubagentStart, SubagentStop, SessionEnd. These are Claude Code-specific and only run when Exarchos is installed as a Claude Code plugin.

## Path resolution

The MCP server resolves data directories through a cascade. Environment variables win, then defaults apply.

### resolveStateDir

| Priority | Source | Value |
|----------|--------|-------|
| 1 | `WORKFLOW_STATE_DIR` env var | User-specified path |
| 2 | Default | `~/.claude/workflow-state` |

Set `WORKFLOW_STATE_DIR` to put state files wherever you want. The env var always wins.

### Team and task directories

Team configuration and task state resolve relative to the plugin root when running inside Claude Code. Outside Claude Code, set `EXARCHOS_PLUGIN_ROOT` to point at the plugin directory. Without it, the system falls back to standard paths.

## Platform detection

The server checks `EXARCHOS_PLUGIN_ROOT` to know whether it's inside a Claude Code plugin. The plugin manifest sets this automatically (`plugin.json` maps `CLAUDE_PLUGIN_ROOT` to `EXARCHOS_PLUGIN_ROOT`).

When the variable is present, the server can:
- Load safety rules from `$EXARCHOS_PLUGIN_ROOT/rules/rm-safety.md`
- Find CLAUDE.md templates at `$EXARCHOS_PLUGIN_ROOT/CLAUDE.md.template`
- Resolve skill and command paths relative to the plugin root

When it's absent, those features are simply unavailable. The workflow engine, event store, and all four composite tools work fine without them.

## Content layer vs runtime

This split is the reason portability works:

**Claude Code-specific (content layer):**
- Skills (`skills/*/SKILL.md`) -- Markdown loaded by Claude Code's skill system
- Commands (`commands/*.md`) -- Slash commands registered in Claude Code
- Agents (`agents/*.md`) -- Subagent definitions spawned by Claude Code
- Rules (`rules/*.md`) -- Safety rules injected into context
- Hooks (`hooks/hooks.json`) -- Lifecycle event handlers

**Platform-agnostic (runtime):**
- MCP server -- stdio JSON-RPC, works with any client
- Event store -- JSONL append-only log on the filesystem
- State store -- JSON files derived from events
- Dispatch engine -- TypeScript handlers, zero Claude Code dependency
- CLI -- Commander-based, zero Claude Code dependency

## Using Exarchos with other MCP clients

Point any MCP client at the stdio server:

```json
{
  "mcpServers": {
    "exarchos": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/exarchos/dist/exarchos.js", "mcp"],
      "env": {
        "WORKFLOW_STATE_DIR": "~/.exarchos/state"
      }
    }
  }
}
```

You get all four composite tools:
- `exarchos_workflow` -- init, get, set, cancel, cleanup, reconcile
- `exarchos_event` -- append, query, batch
- `exarchos_orchestrate` -- convergence gates, runbooks, agent specs, script execution
- `exarchos_view` -- pipeline, tasks, telemetry, convergence status

You lose the content layer (skills, commands, agents, hooks), but the workflow engine is fully functional. The CLI adapter is also available as an alternative interface.
