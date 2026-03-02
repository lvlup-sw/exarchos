<div align="center">
  <img src="exarchos-logo.png" alt="Exarchos" width="280" />

  [![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

  **Your agents forget. Exarchos doesn't.**<br>
  Checkpoint any workflow · Rehydrate in seconds · Ship verified code
</div>

---

## The problem

You already know Claude Code needs structure. You probably have a plan.md workflow — write a spec, iterate on it, tell the agent to execute, commit the artifacts alongside the code. Maybe a debug.md. Maybe separate docs per feature.

It works. Until context compaction wipes the session and your agent forgets the plan it's halfway through executing. Or the agent drifts from the spec and you don't catch it until review. Or you come back tomorrow and spend 30 minutes re-explaining what the agent already knew.

The manual workflow is the right instinct. But markdown files can't persist state across sessions, enforce phase gates, or verify that the agent actually followed the plan.

## How Exarchos solves it

**Your plan.md workflow, systematized — with persistence, verification, and token efficiency.**

Exarchos persists workflow state in an event-sourced MCP server — not markdown files, not conversation history. When context compaction hits (or you close your laptop and come back tomorrow), run `/rehydrate`. Your workflow resumes with behavioral guidance, artifact pointers, and task progress intact. No history replay. No re-reading files. ~2-3k tokens to restore full awareness.

```
# Mid-feature, context is getting long
/checkpoint                  → state saved to MCP event store

# Next day, new session
/rehydrate                   → workflow restored: phase, tasks, design doc path, PR links
                               behavioral guidance injected, next action suggested
                               cost: ~2-3k tokens (not 20k)
```

**Design docs, plans, and PR links persist as references** — never inlined into context. Your workflow can generate dozens of artifacts without growing the context footprint. State size stays constant.

## What you get

- **Structured SDLC workflows.** Design → plan → implement → review → ship — the same lifecycle you've been building by hand, but with enforced phase transitions, auto-continuation between human checkpoints, and three workflow types (feature, debug, refactor) that handle the common patterns. Your spec, plan, and design artifacts are first-class objects, not afterthoughts.
- **Rehydrate + artifacts.** Checkpoint mid-task, resume hours or days later. Design docs, plans, review verdicts, and PR links survive across sessions as lightweight references — not inlined into context, just pointers.
- **Token-efficient by design.** Field-projected state queries (90% fewer tokens than full reads). Diff-based code review (only changed lines, not full files). Context economy is also a quality gate — code too complex for LLM context can't ship.
- **Convergence gates.** Five independent quality dimensions verified at every phase boundary — spec fidelity, architectural compliance, context economy, operational resilience, workflow determinism. Code advances only when all pass.
- **Agent teams.** Delegate tasks to parallel Claude Code instances in isolated git worktrees. The orchestrator coordinates; teammates execute.
- **Two-stage review.** Spec compliance first (does it match the design?), then code quality (is it well-written?). Deterministic verification scripts, not vibes.
- **Full audit trail.** Append-only event log records every workflow transition, gate result, and agent decision. Trace what happened, when, and why.

## Installation

### From Marketplace (Recommended)

```bash
# Add the lvlup-sw marketplace
/plugin marketplace add lvlup-sw/exarchos

# Install the core plugin
/plugin install exarchos@lvlup-sw
```

This installs the Exarchos MCP server, all workflow commands and skills, lifecycle hooks, and validation scripts.

**Dev companion** (optional): adds GitHub, Serena, Context7, and Microsoft Learn MCP servers. `npx @lvlup-sw/exarchos-dev`

### For Development

```bash
git clone https://github.com/lvlup-sw/exarchos.git
cd exarchos
npm install && npm run build
claude --plugin-dir .
```

### Prerequisites

- **Node.js** >= 20

> Migrating from the legacy `npx` installer? See the [migration guide](docs/migration-from-legacy-installer.md).

## Workflows

> **Note:** Commands are shown in short form (`/ideate`) throughout this README. When installed as a plugin, commands are namespaced as `/exarchos:ideate`, `/exarchos:plan`, etc.

| Task | Command |
|------|---------|
| New feature or design | `/ideate` |
| Bug fix | `/debug` |
| Code improvement | `/refactor` |

| Resume any workflow | `/rehydrate` |
| Save progress mid-task | `/checkpoint` |

Phase commands (`/plan`, `/delegate`, `/review`, `/synthesize`, `/cleanup`) are invoked within workflows and auto-chain between human checkpoints.

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
| Plan | `/exarchos:plan` | TDD task decomposition with provenance tracing |
| Plan review | — | Human approval checkpoint |
| Delegate | `/exarchos:delegate` | Spawn agent teams in worktrees |
| Review | `/exarchos:review` | Two-stage: spec compliance → code quality |
| Synthesize | `/exarchos:synthesize` | Create stacked PRs and enqueue for merge |

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

## Token Efficiency

Every token spent on workflow infrastructure is a token not spent on your code. Exarchos is designed to be the cheapest possible workflow layer.

| Mechanism | How it works | Savings |
|-----------|-------------|---------|
| **Field projection** | State queries return only requested fields, not the full object | ~90% fewer tokens |
| **Diff-based review** | Code review operates on changed lines, not full files | ~97% for large files |
| **Post-compaction assembly** | `/rehydrate` restores full workflow awareness in ~2-3k tokens | vs. 10-20k for manual re-explanation |
| **Artifact references** | Design docs, plans, PRs stored as file paths — never inlined into context | Constant state size regardless of artifact count |
| **Context economy gate** | Quality dimension (D3) that blocks code shipping if it's too complex for LLM context | Prevents bloat at the source |

## How It Works

Your Claude Code session acts as the orchestrator. Exarchos manages workflow state; you make decisions at each checkpoint. Agent teammates execute tasks in isolated git worktrees, each with independent context, working in parallel.

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
| **Exarchos** | Core plugin | Workflow orchestration, event logging, team coordination, convergence gates |
| **GitHub** | [Dev companion](companion/) | PRs, issues, code search, stacked PR management |
| **Serena** | [Dev companion](companion/) | Semantic code analysis |
| **Context7** | [Dev companion](companion/) | Up-to-date library documentation |
| **Microsoft Learn** | [Dev companion](companion/) | Official Azure/.NET documentation |

For technical details on the MCP server architecture, event sourcing model, and tool API, see the [architecture documentation](docs/).

<!-- ## Scaling Up

Exarchos runs entirely on your local machine. For teams that need cloud
execution in secure sandboxes, multi-provider model routing, and
enterprise observability, see [Basileus](https://basileus.dev) — the
platform that Exarchos workflows connect to. -->

## Build & Test

```bash
npm run build          # tsc + bun → dist/
npm run test:run       # vitest single run
npm run typecheck      # tsc --noEmit
npm run validate       # Validate plugin structure
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
