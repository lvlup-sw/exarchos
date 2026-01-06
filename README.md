# Claude Code Global Configuration

Shared configuration for Claude Code: TDD-enforced workflow orchestration with Jules integration.

## Quick Start

```bash
git clone <repo-url> ~/Documents/code/lvlup-claude
cd ~/Documents/code/lvlup-claude && ./scripts/install.sh
```

Done. Commands work in any project immediately.

## The Workflow

```
/ideate → [CONFIRM] → /plan → /delegate → /review → /synthesize → [CONFIRM] → merge
            ↑           (auto)   (auto)     (auto)      (auto)          ↑
          HUMAN                                                       HUMAN
```

**Two human checkpoints.** Everything else auto-continues.

| Command | Purpose |
|---------|---------|
| `/ideate` | Design exploration with trade-offs |
| `/plan` | TDD task decomposition |
| `/delegate` | Dispatch to Jules (async) or subagents (sync) |
| `/review` | Two-stage: spec compliance → code quality |
| `/synthesize` | Merge branches, create PR |

### TDD Iron Law

Every task follows Red-Green-Refactor:
1. **RED**: Write failing test first
2. **GREEN**: Minimum code to pass
3. **REFACTOR**: Clean up, tests stay green

## Context Persistence

Workflows survive context compaction. State saves to `docs/workflow-state/<feature>.state.json` and auto-resumes on session start.

| Command | Purpose |
|---------|---------|
| `/checkpoint` | Force save (usually automatic) |
| `/resume` | Restore from state file |

## Jules Integration

Delegate tasks to Google's Jules autonomous coding agent.

### Setup

1. Get API key: [jules.google/settings](https://jules.google/settings)
2. Export: `echo 'export JULES_API_KEY="your-key"' >> ~/.zshrc && source ~/.zshrc`
3. Connect repos: [jules.google](https://jules.google)

### Tools

| Tool | Purpose |
|------|---------|
| `jules_create_task` | Delegate coding task |
| `jules_check_status` | Check progress |
| `jules_approve_plan` | Approve execution plan |
| `jules_send_feedback` | Send instructions |
| `jules_list_sources` | List connected repos |
| `jules_get_conversation` | Get session history |
| `jules_get_pending_question` | Check if awaiting input |
| `jules_cancel` | Cancel task |

Use `/delegate` for workflow integration. Use `jules_*` tools directly for standalone tasks.

## Configuration

### What's Included

| Type | Count | Examples |
|------|-------|----------|
| Commands | 8 | `/ideate`, `/plan`, `/delegate`, `/review`, `/synthesize` |
| Skills | 8 | brainstorming, delegation, spec-review, quality-review |
| Rules | 4 | TDD + coding standards for TypeScript, C# |
| Plugins | 1 | Jules MCP integration |

### Discovery Order

1. **Project local**: `./.claude/` (highest priority)
2. **Global**: `~/.claude/` (this repo, via symlinks)

### Project Overrides

```bash
# Add project-specific rule
cat > .claude/rules/my-rule.md << 'EOF'
---
paths: '**/*.ts'
---
# My project rule
EOF

# Override permissions
echo '{"permissions":{"allow":["Bash(npm run custom)"]}}' > .claude/settings.json
```

## Repository Structure

```
lvlup-claude/
├── commands/           # Slash commands (/ideate, /plan, etc.)
├── skills/             # Workflow orchestration patterns
├── rules/              # Language-specific TDD + coding standards
├── plugins/jules/      # Jules MCP server
├── scripts/
│   ├── install.sh          # One-time setup
│   ├── new-project.sh      # Per-project setup (optional)
│   └── workflow-state.sh   # State management
├── azd-templates/      # Azure Developer CLI templates
│   └── infra/          # Terraform modules + deployment hooks
├── renovate-config/    # Renovate dependency automation presets
├── ci-templates/       # Reusable CI workflow templates
└── docs/
    ├── designs/        # Design documents
    ├── plans/          # Implementation plans
    └── workflow-state/ # State files (gitignored)
```

## Plugin Marketplace Installation

As an alternative to the symlink-based install, you can install the Jules plugin via the Claude Code plugin marketplace:

```bash
# In Claude Code, run:
/plugin marketplace add lvlup-sw/lvlup-claude
/plugin install jules@lvlup-claude
```

This approach:
- Automatically manages MCP server configuration
- Supports auto-updates when the marketplace updates
- Keeps plugin files separate from your config repo

## Troubleshooting

**Commands not available**: Re-run `./scripts/install.sh`

**Jules not working**:
1. Check API key: `echo $JULES_API_KEY`
2. Check MCP config: `jq '.mcpServers.jules' ~/.claude.json`
3. Rebuild MCP server: `cd ~/Documents/code/lvlup-claude/plugins/jules/servers/jules-mcp && npm run build`
4. Restart Claude Code

**Rules not applying**: Check frontmatter `paths` pattern matches your files.

## License

This project is licensed under the **Apache License 2.0**. See the [LICENSE](LICENSE) file for details.
