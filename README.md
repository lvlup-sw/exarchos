# lvlup-claude

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

> SDLC workflow automation for Claude Code with state checkpointing

## Quick Start

```bash
npx -y github:lvlup-sw/lvlup-claude
```

Done. Commands work in any project immediately.

## Why lvlup-claude?

Claude Code sessions lose context during long tasks. Context compaction discards your
workflow state, forcing you to re-explain what you were doing.

lvlup-claude provides **three SDLC workflows** with automatic state checkpointing:

- **Feature** — Design → Plan → Delegate → Integrate → Review → PR
- **Debug** — Triage → Investigate → Fix → Validate (hotfix or full RCA tracks)
- **Refactor** — Explore → Brief → Implement → Validate (polish or overhaul tracks)

All workflows auto-resume on session start. Human checkpoints only where they add value.

## Workflows

### Feature Workflow

```
/ideate → /plan → plan-review → [CONFIRM] → /delegate → /integrate → /review → /synthesize → [CONFIRM] → merge
           (auto)      ↑             ↑         (auto)      (auto)      (auto)     (auto)           ↑
                       │           HUMAN                     │                                   HUMAN
                       └── gaps? ──┘                         └── fail? → /delegate --fixes ──┘
```

**One plan-review checkpoint** (after plan, before delegation). Auto-loops back to `/plan` if gaps found. Everything else auto-continues until merge, with `/review` auto-looping to `/delegate --fixes` on failure.

| Command | Purpose |
|---------|---------|
| `/ideate` | Design exploration with trade-offs |
| `/plan` | TDD task decomposition + spec tracing |
| `/delegate` | Dispatch to Jules (async) or subagents (sync) |
| `/integrate` | Merge worktree branches, run combined tests |
| `/review` | Two-stage: spec compliance → code quality |
| `/synthesize` | Create PR from integration branch |

### Debug Workflow

```
/debug → Triage → Investigate → [Fix] → Validate → [CONFIRM] → merge
                       │
         ┌─────────────┼─────────────┐
         │             │             │
    --hotfix      (default)     --escalate
    (15 min)     (full RCA)     → /ideate
```

**Single checkpoint:** Merge confirmation. Supports hotfix (fast) and thorough (RCA) tracks.

### Refactor Workflow

```
/refactor → Explore → Brief → [Implement|Plan] → Validate → Update Docs → [CONFIRM]
                                    │
                   ┌────────────────┼────────────────┐
                   │                                 │
              --polish                          (default)
           (direct, ≤5 files)               (full delegation)
```

**Single checkpoint:** Completion/merge. Polish track for small changes, overhaul track for migrations.

### TDD Iron Law

Every task follows Red-Green-Refactor:
1. **RED**: Write failing test first
2. **GREEN**: Minimum code to pass
3. **REFACTOR**: Clean up, tests stay green

## Key Features

- **Context Persistence** — Workflows save to `docs/workflow-state/` and auto-resume on session start
- **TDD Enforcement** — Every task follows Red-Green-Refactor
- **Worktree Isolation** — Parallel tasks in separate git worktrees
- **Human Checkpoints** — Only at plan review and merge confirmation
- **Three Workflow Types** — Feature, Debug, and Refactor with specialized tracks

## What's Included

| Type | Count | Examples |
|------|-------|----------|
| Commands | 11 | `/ideate`, `/plan`, `/delegate`, `/integrate`, `/review`, `/synthesize`, `/debug` |
| Skills | 14 | brainstorming, delegation, debug, refactor, spec-review, quality-review |
| Rules | 9 | TDD standards, coding standards (TypeScript, C#), workflow auto-resume |
| MCP Plugins | 2 | Jules (optional), workflow-state |
| Marketplace Plugins | 5 | github, microsoft-docs, typescript-lsp, pyright-lsp, csharp-lsp |

## Configuration

### Discovery Order

1. **Project local**: `./.claude/` (highest priority)
2. **Global**: `~/.claude/` (this repo, via symlinks)

### Project Overrides

```bash
# Add project-specific rule
mkdir -p .claude/rules
cat > .claude/rules/my-rule.md << 'EOF'
---
paths: '**/*.ts'
---
# My project rule
EOF
```

## Jules Integration (Optional)

Delegate tasks to Google's Jules autonomous coding agent.

```bash
npx -y github:lvlup-sw/lvlup-claude --with-jules
```

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

## Uninstall

```bash
npx -y github:lvlup-sw/lvlup-claude --uninstall
```

## Troubleshooting

**Commands not available**: Re-run `npx -y github:lvlup-sw/lvlup-claude`

**Missing MCP servers**: Re-run the installer to get newly added servers.

**Jules not working**:
1. Check API key: `echo $JULES_API_KEY`
2. Check MCP config: `jq '.mcpServers.jules' ~/.claude.json`
3. Restart Claude Code

**Rules not applying**: Check frontmatter `paths` pattern matches your files.

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
