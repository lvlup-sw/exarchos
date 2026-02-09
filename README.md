# Exarchos

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

> Local agent governance for Claude Code — event-sourced SDLC workflows with team coordination

## Quick Start

```bash
npx -y github:lvlup-sw/exarchos
```

Done. Commands work in any project immediately.

## Why Exarchos?

Claude Code sessions lose context during long tasks. Context compaction discards your workflow state, forcing you to re-explain what you were doing. And subagents report back to the orchestrator but cannot collaborate, coordinate, or challenge each other.

Exarchos solves both problems by coordinating local Claude Code agent teams with event-sourced state that survives any context disruption.

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

### MCP Tools

| Category | Tools | Purpose |
|----------|-------|---------|
| **Workflow** | `workflow_init`, `workflow_set`, `workflow_get`, `workflow_summary`, `workflow_next_action` | HSM state transitions, phase tracking |
| **Events** | `event_append`, `event_query` | Append-only event log, temporal queries |
| **Views** | `view_workflow_status`, `view_team_status`, `view_tasks`, `view_pipeline` | CQRS materialized read models |
| **Teams** | `team_spawn`, `team_message`, `team_broadcast`, `team_shutdown`, `team_status` | Agent team lifecycle |
| **Tasks** | `task_claim`, `task_complete`, `task_fail` | Shared task ledger |
| **Stack** | `stack_status`, `stack_place` | Progressive Graphite stacking |
| **Sync** | `sync_now` | Remote event projection |

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

## Key Features

- **Event-Sourced State** — Append-only event log with CQRS materialized views for workflow observability
- **Agent Teams** — Concurrent teammates with independent context, coordinated through shared event stream
- **Progressive Stacking** — PRs created incrementally as tasks complete via Graphite
- **Context Persistence** — Workflows auto-resume on session start via `workflow_next_action`
- **TDD Enforcement** — Every task follows Red-Green-Refactor with phase transition events
- **Worktree Isolation** — Each teammate works in its own git worktree

## What's Included

| Type | Count | Examples |
|------|-------|----------|
| Commands | 12 | `/ideate`, `/plan`, `/delegate`, `/review`, `/synthesize`, `/debug`, `/refactor` |
| Skills | 14 | brainstorming, delegation, debug, refactor, spec-review, quality-review |
| Rules | 10 | TDD standards, coding standards (TypeScript, C#), workflow auto-resume |
| MCP Servers | 1 | Exarchos |

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

## Uninstall

```bash
npx -y github:lvlup-sw/exarchos --uninstall
```

## Troubleshooting

**Commands not available**: Re-run `npx -y github:lvlup-sw/exarchos`

**Missing MCP servers**: Re-run the installer to get newly added servers.

**Rules not applying**: Check frontmatter `paths` pattern matches your files.

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
