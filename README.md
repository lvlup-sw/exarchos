<div align="center">
  <img src="exarchos-logo.svg" alt="Exarchos" width="280" />

  **Your agents forget. Exarchos doesn't.**<br>
  Durable SDLC workflows for Claude Code — checkpoint any task, rehydrate in seconds, ship verified code.

  [![CI](https://github.com/lvlup-sw/exarchos/actions/workflows/ci.yml/badge.svg)](https://github.com/lvlup-sw/exarchos/actions/workflows/ci.yml)
  [![npm version](https://img.shields.io/npm/v/@lvlup-sw/exarchos)](https://www.npmjs.com/package/@lvlup-sw/exarchos)
  [![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
  [![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

  [Install](#install) · [What You Get](#what-you-get) · [Architecture](#agent-first-architecture) · [Workflows](#workflows) · [Docs](docs/)
</div>

---

## You probably already do this

You have a plan.md. Maybe a spec file per feature. You iterate with Claude, tell it to execute, commit the artifacts alongside the code. It works.

Until context compaction wipes the session halfway through. Or the agent drifts from the spec and you don't catch it until review. Or you come back tomorrow and spend 30 minutes re-explaining what the agent already knew.

Developers keep reinventing this on their own: iterate on a plan file, execute it, commit the artifacts. Skill-based workflow tools try to systematize it with markdown files loaded into context. But they're stateless. Nothing persists across context compaction, suggestions get ignored as conversations grow, and there's no verification that the agent followed through.

The plan-file workflow is the right instinct. Markdown files just can't persist state across sessions, enforce phase gates, or prove that the agent actually did what you asked.

## Your plan.md workflow, with teeth

Exarchos replaces markdown files with an event-sourced MCP server. A state machine enforces phase transitions (design, plan, implement, review, ship) with quality gates between each step. Parallel agents execute in isolated git worktrees. Lifecycle hooks run validation scripts automatically, so the agent can't skip steps even if it wants to.

When context compaction hits (or you close your laptop and come back Monday), run `/rehydrate`. Design docs, plans, and PR links persist as references, never inlined into context. Your workflow picks up where it left off.

<div align="center">
  <a href="docs/assets/architecture.svg">
    <img src="docs/assets/architecture.svg" alt="Exarchos architecture: workflow pipeline, state machine, agent teams in worktrees, quality gates" width="720" />
  </a>
  <br>
  <sub>Architecture: workflow phases, agent dispatch, quality gates.</sub>
</div>

## Install

```bash
# From the Claude Code marketplace
/plugin marketplace add lvlup-sw/exarchos
/plugin install exarchos@lvlup-sw
```

That's it. Installs the MCP server, all workflow commands, lifecycle hooks, and validation scripts.

**Dev companion** (optional, adds Serena, Context7, and Microsoft Learn MCP servers):
```bash
npx @lvlup-sw/exarchos-dev
```

<details>
<summary>Development setup</summary>

```bash
git clone https://github.com/lvlup-sw/exarchos.git && cd exarchos
npm install && npm run build
claude --plugin-dir .
```

Requires Node.js >= 20.
</details>

## What you get

Three workflow types (feature, debug, refactor) with enforced phase transitions. You approve twice: the design and the merge. Everything between auto-continues.

**Checkpoint and resume.** `/checkpoint` saves mid-task. `/rehydrate` restores it in ~2-3k tokens. No re-explaining your project from scratch when you come back the next day.

**Native Task delegation.** Delegate to parallel Claude Code instances, each in its own git worktree. The orchestrator tracks their progress and runs quality gates on completion.

**Two-stage review.** Spec compliance first (does it match the design?), then code quality (is it well-written?). Verification scripts, not vibes.

**Audit trail.** Every transition, gate result, and agent decision goes into an append-only event log. When something breaks, you can trace exactly what happened and why.

**Token-efficient.** State queries use field projection (90% fewer tokens). Code review sends diffs, not full files.

Your Claude Code session is the orchestrator. Exarchos manages state; you make decisions at each checkpoint.

### Agent-first architecture

Exarchos ships as a single binary (`exarchos`) with an `mcp` subcommand. Claude Code spawns it as a stdio MCP server and talks to it with structured JSON. Four composite tools cover the surface:

| Tool | What it does |
|------|-------------|
| `exarchos_workflow` | Workflow lifecycle: init, get, set, cancel, cleanup, reconcile |
| `exarchos_event` | Append-only event store: append, query, batch |
| `exarchos_orchestrate` | Team coordination: task dispatch, review triage, script execution |
| `exarchos_view` | CQRS projections: pipeline status, task boards, stack health |

Every tool input is a Zod-validated discriminated union keyed on `action`. The same `dispatch()` function backs both the MCP transport and the CLI, so you can call `exarchos workflow get --featureId my-feature` from a terminal and get the same result the agent gets. Lifecycle hooks (pre-compact, session-start, guard, task-gate) run as fast-path subcommands that skip heavy initialization.

The design is agent-first: structured input over natural language, strict schema validation over loose parsing, and a single binary that does one thing whether an agent or a human is driving it.

### Integrations

| Component | Source | Purpose |
|-----------|--------|---------|
| Exarchos | Core plugin | Workflow state, event log, team coordination, quality gates |
| Serena | [Dev companion](companion/) | Semantic code analysis |
| Context7 | [Dev companion](companion/) | Up-to-date library documentation |
| Microsoft Learn | [Dev companion](companion/) | Azure and .NET documentation |

## Workflows

> Commands shown in short form (`/ideate`). As a plugin, they're namespaced: `/exarchos:ideate`, `/exarchos:plan`, etc.

**Start a workflow:**

| When you need to... | Command | What it does |
|:---------------------|:--------|:-------------|
| Build a feature | `/ideate` | Design exploration, TDD plan, parallel implementation |
| Fix a bug | `/debug` | Triage, investigate, fix, validate (hotfix or thorough) |
| Improve code | `/refactor` | Assess scope, brief, implement (polish or full overhaul) |

**Lifecycle commands:**

| Command | What it does |
|:--------|:-------------|
| `/plan` | Create TDD implementation plan from a design doc |
| `/delegate` | Dispatch tasks to agent teammates in worktrees |
| `/review` | Run two-stage review (spec compliance + code quality) |
| `/synthesize` | Create PR from feature branch |
| `/shepherd` | Push PRs through CI and reviews to merge readiness |
| `/cleanup` | Resolve merged workflow to completed state |
| `/checkpoint` | Save workflow state for later resumption |
| `/rehydrate` | Restore workflow state after compaction or session break |
| `/reload` | Re-inject context after degradation |
| `/autocompact` | Toggle autocompact or set threshold |
| `/tag` | Attribute current session to a feature or project |
| `/tdd` | Plan implementation using strict Red-Green-Refactor |

## Build & test

```bash
npm run build          # tsc + bun → dist/
npm run test:run       # vitest single run
npm run typecheck      # tsc --noEmit
npm run validate       # Validate plugin structure
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
