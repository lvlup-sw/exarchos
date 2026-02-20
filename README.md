<div align="center">
  <img src="exarchos-logo.png" alt="Exarchos" width="280" />

  [![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

  **Governed SDLC workflows for Claude Code**<br>
  Agent orchestration · Quality gates · Graphite stacked PRs · Event-sourced auditability
</div>

---

## Why Exarchos?

AI agents are reshaping software development. The work is shifting — from writing every line to designing systems, directing agent teams, and verifying outcomes. But structured development processes haven't kept pace. Agents operate without workflow discipline, produce unverified output, lose context mid-task, and leave no audit trail.

Exarchos brings governed SDLC workflows to Claude Code. You direct the process — ideate, plan, delegate, review, ship — while agent teams execute in parallel, each working in isolated git worktrees with independent context. Every phase has quality gates. Every transition is recorded.

- **Structured workflows** — Three complete SDLC workflows (feature, debug, refactor) with human checkpoints at design decisions and merge only. Everything between is automated.
- **Multi-agent orchestration** — Delegate tasks to agent teams working in parallel worktrees. The orchestrator directs; teammates implement, review, and coordinate.
- **Quality gates at every phase** — Two-stage code review (spec compliance, then code quality), TDD enforcement, and deterministic validation scripts. Work that doesn't pass doesn't merge.
- **Graphite stacked PRs** — Completed work ships as progressively stacked PRs with merge queue integration. No monolithic PRs, no manual branch management.
- **Full auditability** — Every workflow transition, task completion, and agent interaction is recorded in an append-only event log. You can trace exactly what happened, when, and why.
- **Token efficient** — Composite MCP tools and on-demand content loading minimize context overhead, leaving more of Claude's context window for your actual work.
- **Session resilient** — Workflows survive context compaction and session interruptions. Pick up exactly where you left off, even across days or machines.

## Installation

### From Marketplace (Recommended)

```bash
# Add the lvlup-sw marketplace
/plugin marketplace add lvlup-sw/exarchos

# Install the core plugin
/plugin install exarchos@lvlup-sw
```

This installs the Exarchos MCP server, Graphite MCP integration, all workflow commands and skills, lifecycle hooks, and validation scripts.

**Dev companion** (optional) — adds GitHub, Serena, Context7, and Microsoft Learn MCP: `npx @lvlup-sw/exarchos-dev`

### For Development

```bash
git clone https://github.com/lvlup-sw/exarchos.git
cd exarchos
npm install && npm run build
claude --plugin-dir .
```

### Prerequisites

- **Node.js** >= 20
- **Graphite CLI** (`gt`) — required for stacked PR workflows ([install](https://graphite.dev/docs/install))

> Migrating from the legacy `npx` installer? See the [migration guide](docs/migration-from-legacy-installer.md).

## Workflows

> **Note:** Commands are shown in short form (`/ideate`) throughout this README. When installed as a plugin, commands are namespaced as `/exarchos:ideate`, `/exarchos:plan`, etc.

| Task | Command |
|------|---------|
| New feature or design | `/ideate` |
| Bug fix | `/debug` |
| Code improvement | `/refactor` |

Supporting commands (`/plan`, `/delegate`, `/review`, `/synthesize`, `/checkpoint`, `/resume`, `/cleanup`) are phase commands invoked within workflows.

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
| Design | `/exarchos:ideate` | Collaborative design exploration with trade-offs |
| Plan | `/exarchos:plan` | TDD task decomposition + stack ordering |
| Plan review | — | Human approval checkpoint |
| Delegate | `/exarchos:delegate` | Spawn agent teams in worktrees |
| Review | `/exarchos:review` | Two-stage: spec compliance → code quality |
| Synthesize | `/exarchos:synthesize` | Enqueue Graphite stack in merge queue |

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

## How It Works

Your Claude Code session becomes an orchestrator. Exarchos manages the workflow state while you direct the process at each decision point. Agent teammates execute tasks in isolated git worktrees — each with independent context, working in parallel.

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code Lead                         │
│          Orchestrator — /ideate, /plan, /delegate           │
└────────────────────────────┬────────────────────────────────┘
                             │
                    ┌────────┴────────┐
                    │  Exarchos MCP   │
                    │                 │
                    │  Workflow State  │  Persistent across sessions
                    │  Event Log      │  Full audit trail
                    │  Team Coord     │  Spawn/message/shutdown
                    │  Quality Gates  │  Automated verification
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         Teammate 1    Teammate 2    Teammate N
         (worktree)    (worktree)    (worktree)
```

### Integrations

| Component | Source | Purpose |
|-----------|--------|---------|
| **Exarchos** | Core plugin | Workflow orchestration, event logging, team coordination |
| **Graphite** | Core plugin | Stacked PR management and merge queue |
| **GitHub** | [Dev companion](companion/) | PRs, issues, code search |
| **Serena** | [Dev companion](companion/) | Semantic code analysis |
| **Context7** | [Dev companion](companion/) | Up-to-date library documentation |
| **Microsoft Learn** | [Dev companion](companion/) | Official Azure/.NET documentation |

For technical details on the MCP server architecture, event sourcing model, and tool API, see the [architecture documentation](docs/).

## Build & Test

```bash
npm run build          # tsc + bun → dist/
npm run test:run       # vitest single run
npm run typecheck      # tsc --noEmit
npm run validate       # Validate plugin structure
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
