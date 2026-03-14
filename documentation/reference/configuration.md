# Configuration

Exarchos configuration spans project settings, plugin settings, lifecycle hooks, MCP server registration, and optional integrations.

## Project configuration (.exarchos.yml) {#project-config}

Drop a `.exarchos.yml` file in your repository root to customize Exarchos behavior per project. All fields are optional. Unspecified fields use built-in defaults. See the [Project Configuration guide](/guide/project-config) for usage examples.

### Schema reference

#### review

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dimensions` | `Record<D1-D5, severity>` | All `blocking` | Dimension-level severity: `blocking`, `warning`, or `disabled` |
| `dimensions.<D>` | `string \| object` | `blocking` | Shorthand `"warning"` or longform `{ severity: "warning", enabled: true }` |
| `gates` | `Record<string, GateConfig>` | `{}` | Per-gate overrides (take precedence over dimension) |
| `gates.<name>.enabled` | `boolean` | `true` | Enable or disable the gate |
| `gates.<name>.blocking` | `boolean` | Inherits dimension | Override whether gate blocks the workflow |
| `gates.<name>.params` | `object` | `{}` | Gate-specific parameters (e.g., `coverage-threshold`) |
| `routing.coderabbit-threshold` | `number` | `0.4` | Risk score threshold for CodeRabbit routing (0.0-1.0) |
| `routing.risk-weights` | `object` | See below | Six risk factors, must sum to 1.0 |

Default risk weights: `security-path: 0.30`, `api-surface: 0.20`, `diff-complexity: 0.15`, `new-files: 0.10`, `infra-config: 0.15`, `cross-module: 0.10`.

#### vcs

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `string` | `github` | VCS platform: `github`, `gitlab`, or `azure-devops` |
| `settings` | `object` | `{}` | Provider-specific settings |
| `settings.auto-merge-strategy` | `string` | `squash` | GitHub: `squash`, `merge`, or `rebase` |

#### workflow

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `skip-phases` | `string[]` | `[]` | Phase names to skip (cannot skip initial or final phases) |
| `max-fix-cycles` | `integer` | `3` | Max fix cycles before circuit breaker (1-10) |
| `phases.<name>.human-checkpoint` | `boolean` | varies | Require human approval at this phase |

#### tools

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `default-branch` | `string` | auto-detect | PR base branch |
| `commit-style` | `string` | `conventional` | `conventional` or `freeform` |
| `pr-template` | `string` | (none) | Path to PR template (relative to repo root) |
| `auto-merge` | `boolean` | `true` | Auto-merge after CI passes |
| `pr-strategy` | `string` | `github-native` | `github-native` (stacked) or `single` |

#### hooks

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `on.<event-type>` | `HookAction[]` | `{}` | Shell commands to run when an event fires |
| `on.<event-type>[].command` | `string` | (required) | Shell command (receives event JSON on stdin) |
| `on.<event-type>[].timeout` | `integer` | `30000` | Timeout in ms (1000-300000) |

Hooks are fire-and-forget. Failures are logged but never block the workflow. Set `EXARCHOS_SKIP_HOOKS=true` to disable all hooks.

### Minimal example

```yaml
review:
  dimensions:
    D3: warning
vcs:
  provider: github
tools:
  auto-merge: false
```

### Full example

```yaml
review:
  dimensions:
    D1: blocking
    D3: warning
    D5: disabled
  gates:
    tdd-compliance:
      blocking: false
      params:
        coverage-threshold: 80
    security-scan:
      enabled: true
      blocking: true
  routing:
    coderabbit-threshold: 0.6
vcs:
  provider: github
  settings:
    auto-merge-strategy: squash
workflow:
  skip-phases: [plan-review]
  max-fix-cycles: 2
tools:
  default-branch: main
  commit-style: conventional
  auto-merge: true
  pr-strategy: github-native
hooks:
  on:
    workflow.transition:
      - command: 'echo "$EXARCHOS_PHASE" | slack-notify'
        timeout: 10000
```

## Plugin settings

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

## Lifecycle hooks

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

### Hook details

PreCompact saves workflow state before Claude Code compacts the conversation. This ensures no progress is lost when context is reduced.

SessionStart runs on every session start and resume. It discovers active workflows and injects context so the agent can continue where it left off.

PreToolUse acts as a guard on Exarchos MCP tool calls. It can reject operations that would violate workflow constraints (e.g., skipping phases).

TaskCompleted and TeammateIdle run convergence gates when tasks finish or teammates go idle. The 120-second timeout accommodates script execution.

SubagentStart injects workflow context into newly spawned implementer, fixer, or reviewer agents.

SubagentStop matches the `exarchos-implementer` and `exarchos-fixer` agent names. Handles cleanup when subagents terminate.

## Plugin manifest

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

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKFLOW_STATE_DIR` | `~/.claude/workflow-state` | Directory for workflow state files |
| `EXARCHOS_PLUGIN_ROOT` | Set by Claude Code | Plugin installation root |
| `EXARCHOS_PROJECT_ROOT` | (unset) | Override project root for `.exarchos.yml` discovery |
| `EXARCHOS_SKIP_HOOKS` | (unset) | Set to `true` to disable all config hooks |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | (unset) | Autocompact threshold percentage |
