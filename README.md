<div align="center">
  <img src="exarchos-logo.png" alt="Exarchos" width="280" />

  [![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

  **Structured SDLC workflows with multi-agent orchestration for Claude Code**<br>
  Verifiable outcomes · Graphite stacked PRs · Full auditability via event sourcing
</div>

---

## Installation

### From Claude Code Marketplace (Recommended)

```
claude plugin install exarchos@lvlup-sw
```

### For Development

```bash
git clone https://github.com/lvlup-sw/exarchos.git
cd exarchos
npm install && npm run build
claude --plugin-dir .
```

### Dev Companion (Optional)

Adds GitHub, Serena, Context7, and Microsoft Learn MCP for enhanced development:

```bash
npx @lvlup-sw/exarchos-dev
```

### Legacy Installer

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

### Prerequisites

- **Node.js** >= 20
- **Graphite CLI** (`gt`) — required for stacked PR workflows

## Workflows

| Task | Command |
|------|---------|
| New feature/design | `/exarchos:ideate` |
| Bug fix | `/exarchos:debug` |
| Code improvement | `/exarchos:refactor` |

## Build & Test

```bash
npm run build          # tsc + bun → dist/
npm run test:run       # vitest single run
npm run typecheck      # tsc --noEmit
npm run validate       # Validate plugin structure
```

## Why Exarchos?

Claude Code is powerful, but complex features expose three gaps: sessions lose state during context compaction, subagents can't collaborate or challenge each other, and there's no structured way to verify what agents produce. Exarchos fills these gaps.

- **Verifiable outcomes** — Layered quality gates enforce spec compliance, code quality, and TDD at every stage. Work that doesn't pass doesn't merge.
- **Multi-agent orchestration** — Agent teams work in parallel git worktrees with independent context. The orchestrator steers; teammates execute, review, and coordinate.
- **Graphite stacked PRs** — Completed tasks are progressively stacked as PRs via Graphite, with merge queue integration. No monolithic PRs.
- **Full auditability** — Every workflow transition, task completion, and agent interaction is recorded in an append-only event store. Saga compensation ensures safe cancellation and recovery. CQRS materialized views provide real-time observability.
- **Context resilience** — HSM-driven workflow state survives context compaction. Sessions auto-resume exactly where they left off.
- **Token efficient** — 5 composite MCP tools using action discriminators replace what would otherwise be 26+ individual tool definitions. Fewer tool schemas in context means lower per-call token overhead. Structured Markdown content layers (commands, skills, rules) load on demand — only what's relevant enters the context window.

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

### MCP Tools (5 Composite)

Each tool uses an `action` discriminator to route to specific operations:

| Tool | Actions | Purpose |
|------|---------|---------|
| **`exarchos_workflow`** | `init`, `get`, `set`, `cancel`, `cleanup` | HSM state transitions, phase tracking, lifecycle management |
| **`exarchos_event`** | `append`, `query` | Append-only event log, temporal queries |
| **`exarchos_orchestrate`** | `task_claim`, `task_complete`, `task_fail` | Task lifecycle for delegated work |
| **`exarchos_view`** | `pipeline`, `tasks`, `workflow_status`, `stack_status`, `stack_place`, `telemetry`, `team_performance`, `delegation_timeline` | CQRS materialized read models |
| **`exarchos_sync`** | `now` | Remote state synchronization |

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

## Workflow Details

Three HSM-driven SDLC workflows with automatic state checkpointing. All workflows auto-resume on session start. Human checkpoints only at plan approval and merge confirmation.

### Feature Workflow

```
/ideate → /plan → plan-review ←──┐
                      │  gaps?   │
                   [CONFIRM]     │
                      │ ─────────┘
                      ▼
              ┌─ implementation ──────────────────┐
              │                                   │
              │  /delegate → /review ──┐          │
              │      ▲     fail (≤3x)  │          │
              │      └─────────────────┘          │
              └───────────────────────────────────┘
                      │ pass
                      ▼
                 /synthesize → [CONFIRM] → completed
```

| Phase | Command | Purpose |
|-------|---------|---------|
| Design | `/ideate` | Collaborative design exploration with trade-offs |
| Plan | `/plan` | TDD task decomposition + stack ordering |
| Plan review | — | Human approval checkpoint |
| Delegate | `/delegate` | Spawn agent teams in worktrees, progressive PR stacking |
| Review | `/review` | Two-stage: spec compliance → code quality |
| Synthesize | `/synthesize` | Enqueue Graphite stack in merge queue |

### Debug Workflow

```
/debug → triage → investigate ─────┬──────────────────────────┐
                                   │                          │
                            thorough track               hotfix track
                                   │                          │
                     rca → design → implement        implement → validate
                                       │                          │
                              validate → review              completed
                                           │
                                      synthesize → completed
```

| Track | Phases | Use when |
|-------|--------|----------|
| **Thorough** | RCA → design → implement → validate → review → synthesize | Root cause analysis needed |
| **Hotfix** | implement → validate | Cause is known, quick fix |

### Refactor Workflow

```
/refactor → explore → brief ───────┬──────────────────────────────────┐
                                   │                                  │
                             polish track                       overhaul track
                                   │                                  │
                    implement → validate → docs       plan → delegate → review ──┐
                                    │                          ▲    fail (≤3x)   │
                               completed                      └─────────────────┘
                                                                      │ pass
                                                              docs → synthesize
                                                                      │
                                                                 completed
```

| Track | Phases | Use when |
|-------|--------|----------|
| **Polish** | implement → validate → update docs → completed | Small changes, ≤5 files, direct edits |
| **Overhaul** | plan → delegate → review → update docs → synthesize | Large restructuring, delegation required |

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

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
