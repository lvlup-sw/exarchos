# Configuration

Exarchos configuration spans plugin settings, lifecycle hooks, MCP server registration, and optional integrations.

## Plugin Settings

`settings.json` defines tool permissions and model selection:

```json
{
  "permissions": {
    "allow": [
      "Read", "Write", "Edit", "Glob", "Grep",
      "Task", "mcp__*",
      "Bash(git:*)", "Bash(npm:*)", "Bash(gh:*)",
      "Bash(node:*)", "Bash(ls:*)", "Bash(rm:*)"
    ]
  },
  "model": "claude-opus-4-6"
}
```

The permissions array controls which tools and bash commands the agent can use without user approval. Patterns like `mcp__*` allow all MCP server tools. Bash permissions use `Bash(command:*)` syntax.

## Lifecycle Hooks

Eight hooks in `hooks/hooks.json` integrate with Claude Code's lifecycle:

| Hook | Trigger | Timeout | Purpose |
|------|---------|---------|---------|
| PreCompact | auto | 30s | Checkpoint workflow before context compaction |
| SessionStart | startup, resume | 10s | Check for active workflows to resume |
| PreToolUse | exarchos MCP tools | 5s | Guard invalid tool operations |
| TaskCompleted | task completion | 120s | Run convergence gates on completed tasks |
| TeammateIdle | teammate idle | 120s | Verify teammate work quality |
| SubagentStart | subagent spawn | 5s | Inject context into subagents |
| SubagentStop | implementer/fixer stop | 10s | Clean up after subagent termination |
| SessionEnd | auto | 30s | Session cleanup |

Hooks execute as CLI commands against the bundled `dist/exarchos.js` binary. Each hook receives context through environment variables and stdin.

### Hook Details

**PreCompact** saves workflow state before Claude Code compacts the conversation. This ensures no progress is lost when context is reduced.

**SessionStart** runs on every session start and resume. It discovers active workflows and injects context so the agent can continue where it left off.

**PreToolUse** acts as a guard on Exarchos MCP tool calls. It can reject operations that would violate workflow constraints (e.g., skipping phases).

**TaskCompleted** and **TeammateIdle** run convergence gates when tasks finish or teammates go idle. The 120-second timeout accommodates script execution.

**SubagentStart** injects workflow context into newly spawned implementer, fixer, or reviewer agents.

**SubagentStop** matches the `exarchos-implementer` and `exarchos-fixer` agent names. Handles cleanup when subagents terminate.

## Plugin Manifest

`.claude-plugin/plugin.json` (or `manifest.json` at project root) registers the plugin with Claude Code:

```json
{
  "name": "exarchos",
  "version": "2.5.0",
  "agents": [
    "./agents/implementer.md",
    "./agents/fixer.md",
    "./agents/reviewer.md"
  ],
  "commands": "./commands/",
  "skills": "./skills/",
  "mcpServers": {
    "exarchos": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/exarchos.js", "mcp"],
      "env": {
        "WORKFLOW_STATE_DIR": "~/.claude/workflow-state",
        "EXARCHOS_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}"
      }
    }
  }
}
```

The MCP server runs as a stdio subprocess. `CLAUDE_PLUGIN_ROOT` is set by Claude Code to the plugin installation directory. Workflow state is stored in `~/.claude/workflow-state/`.

## Integrations

Optional integrations are available through the dev companion:

| Integration | Purpose |
|-------------|---------|
| Serena | Semantic code analysis: symbol navigation, reference finding, cross-file understanding |
| Context7 | Up-to-date library documentation lookup |
| Microsoft Learn | Azure and .NET documentation access |

These integrations run as separate MCP servers and are not required for core Exarchos functionality. They provide additional context when available.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKFLOW_STATE_DIR` | `~/.claude/workflow-state` | Directory for workflow state files |
| `EXARCHOS_PLUGIN_ROOT` | Set by Claude Code | Plugin installation root |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | (unset) | Autocompact threshold percentage |
