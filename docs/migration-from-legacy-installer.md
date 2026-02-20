# Migrating from the Legacy Installer

This guide covers migrating from the `npx` symlink-based installer to the native Claude Code plugin system.

## What Changed

Exarchos now distributes as a **Claude Code plugin** instead of a custom npm installer. The plugin system provides native discovery, updates, hook registration, and MCP server management — replacing the manual symlink/copy logic.

| Aspect | Legacy Installer | Plugin System |
|--------|-----------------|---------------|
| Install method | `npx -y github:lvlup-sw/exarchos` | `/plugin marketplace add lvlup-sw/exarchos` |
| File placement | Symlinks/copies to `~/.claude/` | Managed by Claude Code in plugin cache |
| MCP registration | Edits `~/.claude.json` directly | Native via `.mcp.json` |
| Hook registration | Merges into `~/.claude/hooks.json` | Native via `hooks/hooks.json` |
| Updates | Re-run `npx` manually | Claude Code plugin update mechanism |
| Commands | `/ideate`, `/plan`, etc. | `/exarchos:ideate`, `/exarchos:plan`, etc. |

## Migration Steps

### 1. Uninstall the Legacy Installation

Remove the symlinks and configuration entries created by the old installer.

```bash
# Remove Exarchos content from ~/.claude/
rm -f ~/.claude/commands/ideate.md
rm -f ~/.claude/commands/plan.md
rm -f ~/.claude/commands/delegate.md
rm -f ~/.claude/commands/review.md
rm -f ~/.claude/commands/synthesize.md
rm -f ~/.claude/commands/debug.md
rm -f ~/.claude/commands/refactor.md
rm -f ~/.claude/commands/checkpoint.md
rm -f ~/.claude/commands/resume.md
rm -f ~/.claude/commands/cleanup.md
rm -f ~/.claude/commands/reload.md
rm -f ~/.claude/commands/rebuild.md

# Remove skills (check with ls -la first — only remove symlinks, not your own files)
ls -la ~/.claude/skills/
rm -rf ~/.claude/skills/brainstorming
rm -rf ~/.claude/skills/implementation-planning
rm -rf ~/.claude/skills/delegation
rm -rf ~/.claude/skills/spec-review
rm -rf ~/.claude/skills/quality-review
rm -rf ~/.claude/skills/synthesis
rm -rf ~/.claude/skills/debug
rm -rf ~/.claude/skills/refactor
rm -rf ~/.claude/skills/workflow-state
rm -rf ~/.claude/skills/dotnet-standards
rm -rf ~/.claude/skills/git-worktrees
rm -rf ~/.claude/skills/shepherd
rm -rf ~/.claude/skills/cleanup

# Remove rules
rm -f ~/.claude/rules/coding-standards.md
rm -f ~/.claude/rules/tdd.md
rm -f ~/.claude/rules/orchestrator-constraints.md
rm -f ~/.claude/rules/primary-workflows.md
rm -f ~/.claude/rules/mcp-tool-guidance.md
rm -f ~/.claude/rules/skill-path-resolution.md
rm -f ~/.claude/rules/pr-descriptions.md
rm -f ~/.claude/rules/rm-safety.md
rm -f ~/.claude/rules/telemetry-awareness.md

# Remove hooks (check first — only remove Exarchos-managed entries)
# If hooks.json contains ONLY Exarchos hooks:
rm -f ~/.claude/hooks.json

# Remove tracking metadata
rm -f ~/.claude/exarchos.json
```

**Remove legacy hooks from `~/.claude/settings.json`:**

The legacy installer wrote hooks directly into settings.json with hardcoded paths. Open `~/.claude/settings.json` and remove the entire `"hooks"` key (it contains `SessionStart`, `PreCompact`, `PreToolUse`, `TaskCompleted`, `TeammateIdle`, `SubagentStart` entries pointing to `~/.claude/mcp-servers/exarchos-cli.js`). The plugin provides its own hooks via `hooks/hooks.json`.

**Remove MCP server entries from `~/.claude.json`:**

Open `~/.claude.json` and remove the `exarchos` and `graphite` entries from `mcpServers`. If you used the dev companion, also remove `microsoft-learn`.

### 2. Install the Plugin

```bash
# Add the Exarchos marketplace
/plugin marketplace add lvlup-sw/exarchos

# Install the core plugin
/plugin install exarchos@lvlup-sw
```

### 3. Install Dev Companion (Optional)

If you previously installed GitHub, Serena, Context7, or Microsoft Learn:

```bash
npx @lvlup-sw/exarchos-dev
```

### 4. Update Command References

Plugin commands are namespaced. Update any scripts, aliases, or muscle memory:

| Old | New |
|-----|-----|
| `/ideate` | `/exarchos:ideate` |
| `/plan` | `/exarchos:plan` |
| `/delegate` | `/exarchos:delegate` |
| `/review` | `/exarchos:review` |
| `/synthesize` | `/exarchos:synthesize` |
| `/debug` | `/exarchos:debug` |
| `/refactor` | `/exarchos:refactor` |
| `/checkpoint` | `/exarchos:checkpoint` |
| `/resume` | `/exarchos:resume` |
| `/cleanup` | `/exarchos:cleanup` |

### 5. Verify

Start a new Claude Code session and check:

```
/exarchos:ideate    # Should load the brainstorming skill
```

The SessionStart hook should fire automatically, checking for active workflows and Graphite availability.

## Workflow State

Your existing workflow state in `~/.claude/workflow-state/` is **not affected** by migration. Active workflows will auto-resume in the new plugin installation.

## Troubleshooting

### Commands not found after install

Restart Claude Code. Plugin commands load on session start.

### MCP server not connecting

Run `/doctor` to check MCP server status. The plugin registers servers via `.mcp.json` — you should see `exarchos` and `graphite` listed.

### Duplicate commands

If you see both `/ideate` and `/exarchos:ideate`, the legacy installation wasn't fully cleaned up. Re-check the uninstall steps above.

### Graphite MCP unavailable

The Graphite MCP server requires `gt` on your PATH. Install from [graphite.dev/docs/install](https://graphite.dev/docs/install). Core workflows work without Graphite — only `/exarchos:synthesize` requires it.
