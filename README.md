<div align="center">
  <img src="exarchos-logo.png" alt="Exarchos" width="280" />

  [![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

  **Structured SDLC workflows with multi-agent orchestration for Claude Code**<br>
  Verifiable outcomes · Graphite stacked PRs · Full auditability via event sourcing
</div>

---

## Quick Start

```bash
npx -y github:lvlup-sw/exarchos
```

The interactive wizard walks you through setup:

```
? Installation mode:      Standard / Dev
? MCP servers:            [Exarchos ✓] [Graphite ✓] [Microsoft Learn]
? Plugins:                [GitHub] [Serena] [Context7]
? Rule sets:              [TypeScript] [C#/.NET] [Workflow]
? Proceed with install?   Yes
```

Commands work in any project immediately after install.

### Other Install Modes

```bash
# Non-interactive (use defaults or previous selections)
npx -y github:lvlup-sw/exarchos --yes

# Dev mode (symlinks for contributors)
npx -y github:lvlup-sw/exarchos --dev

# Uninstall
npx -y github:lvlup-sw/exarchos --uninstall
```

### Prerequisites

- **Node.js** >= 20
- **Graphite CLI** (`gt`) — required for stacked PR workflows

## Why Exarchos?

Claude Code is powerful, but complex features expose three gaps: sessions lose state during context compaction, subagents can't collaborate or challenge each other, and there's no structured way to verify what agents produce. Exarchos fills these gaps.

- **Verifiable outcomes** — Layered quality gates enforce spec compliance, code quality, and TDD at every stage. Work that doesn't pass doesn't merge.
- **Multi-agent orchestration** — Agent teams work in parallel git worktrees with independent context. The orchestrator steers; teammates execute, review, and coordinate.
- **Graphite stacked PRs** — Completed tasks are progressively stacked as PRs via Graphite, with merge queue integration. No monolithic PRs.
- **Full auditability** — Every workflow transition, task completion, and agent interaction is recorded in an append-only event store. Saga compensation ensures safe cancellation and recovery. CQRS materialized views provide real-time observability.
- **Context resilience** — HSM-driven workflow state survives context compaction. Sessions auto-resume exactly where they left off.

**Three SDLC workflows** with automatic state checkpointing:

- **Feature** — Design → Plan → Delegate → Review → Merge (via stacked PRs)
- **Debug** — Triage → Investigate → Fix → Validate (hotfix or full RCA tracks)
- **Refactor** — Explore → Brief → Implement → Validate (polish or overhaul tracks)

All workflows auto-resume on session start. Human checkpoints only at plan approval and merge confirmation.

## Architecture

Exarchos is a unified MCP server combining workflow state management, event sourcing, CQRS views, and team coordination.

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code Lead                         │
│         Orchestrator — /ideate, /plan, /delegate, etc.      │
└────────────────────────────┬────────────────────────────────┘
                             │
                    ┌────────┴────────┐
                    │  Exarchos MCP   │
                    │                 │
                    │  Event Store    │  Append-only JSONL
                    │  CQRS Views     │  Materialized read models
                    │  Team Coord     │  Spawn/message/shutdown
                    │  Workflow HSM   │  State machine transitions
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         Teammate 1    Teammate 2    Teammate N
         (worktree)    (worktree)    (worktree)
```

### MCP Tools (26)

| Category | Tools | Purpose |
|----------|-------|---------|
| **Workflow** | `workflow_init`, `workflow_set`, `workflow_get`, `workflow_summary`, `workflow_next_action`, `workflow_reconcile`, `workflow_checkpoint`, `workflow_cancel`, `workflow_transitions`, `workflow_list` | HSM state transitions, phase tracking |
| **Events** | `event_append`, `event_query` | Append-only event log, temporal queries |
| **Views** | `view_workflow_status`, `view_team_status`, `view_tasks`, `view_pipeline` | CQRS materialized read models |
| **Teams** | `team_spawn`, `team_message`, `team_broadcast`, `team_shutdown`, `team_status` | Agent team lifecycle |
| **Tasks** | `task_claim`, `task_complete`, `task_fail` | Shared task ledger |
| **Stack** | `stack_status`, `stack_place` | Progressive Graphite stacking |

### Companion MCP Servers & Plugins

Configured during install via the interactive wizard:

| Server/Plugin | Type | Purpose |
|---------------|------|---------|
| **Exarchos** | MCP (bundled) | Workflow orchestration, event sourcing, team coordination |
| **Graphite** | MCP (external) | Stacked PR management and merge queue |
| **Microsoft Learn** | MCP (remote) | Official Azure/.NET documentation |
| **GitHub** | Claude plugin | PRs, issues, code search |
| **Serena** | Claude plugin | Semantic code analysis |
| **Context7** | Claude plugin | Up-to-date library documentation |

## Workflows

### Feature Workflow

```
/ideate → /plan → plan-review → [CONFIRM] → /delegate → /review → /synthesize → [CONFIRM] → merge
           (auto)      ↑             ↑         (auto)     (auto)     (auto)           ↑
                       │           HUMAN                                             HUMAN
                       └── gaps? ──┘
```

Tasks execute concurrently via agent teams. Completed work is progressively stacked as PRs via Graphite. Review validates per-PR gates and stack coherence.

| Command | Purpose |
|---------|---------|
| `/ideate` | Design exploration with trade-offs |
| `/plan` | TDD task decomposition + stack ordering |
| `/delegate` | Spawn agent teams, progressive PR stacking |
| `/review` | Two-stage: spec compliance → code quality |
| `/synthesize` | Enqueue stack in merge queue |

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

## What's Installed

The installer copies (standard mode) or symlinks (dev mode) into `~/.claude/`:

| Type | Count | Examples |
|------|-------|----------|
| Commands | 12 | `/ideate`, `/plan`, `/delegate`, `/review`, `/synthesize`, `/debug`, `/refactor` |
| Skills | 14 | brainstorming, delegation, debug, refactor, spec-review, quality-review |
| Rule sets | 3 | TypeScript, C#/.NET, Workflow & Orchestration |
| MCP servers | 1–3 | Exarchos (required), Graphite (required), Microsoft Learn (optional) |
| Plugins | 0–3 | GitHub, Serena, Context7 |

### Installation Modes

| Mode | What it does | For whom |
|------|-------------|----------|
| **Standard** | Copies files to `~/.claude/` with content hash tracking | End users |
| **Dev** | Symlinks to repo for live editing | Exarchos contributors |

Standard mode tracks file hashes in `~/.claude/exarchos.json`. Re-running the installer only updates changed files.

## Configuration

### Discovery Order

1. **Project local**: `./.claude/` (highest priority)
2. **Global**: `~/.claude/` (installed by Exarchos)

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

## Troubleshooting

**Commands not available**: Re-run `npx -y github:lvlup-sw/exarchos`

**Missing MCP servers**: Re-run the installer — the wizard preserves previous selections.

**Rules not applying**: Check frontmatter `paths` pattern matches your files.

**Installer not interactive**: Ensure you're running in a TTY (not piped). Use `--yes` for CI/scripts.

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
