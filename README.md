<div align="center">
  <img src="exarchos-logo.svg" alt="Exarchos" width="280" />
  
  **Your agents forget. Exarchos doesn't.**<br>
  Persistent SDLC state for any AI coding agent. It survives `/clear`, auto-compaction, and a blown context window.<br>
  First-class with Claude Code, Codex, Cursor, OpenCode, and Copilot; works with any agent that can run a CLI.

  [![CI](https://github.com/lvlup-sw/exarchos/actions/workflows/ci.yml/badge.svg)](https://github.com/lvlup-sw/exarchos/actions/workflows/ci.yml)
  [![npm version](https://img.shields.io/npm/v/@lvlup-sw/exarchos)](https://www.npmjs.com/package/@lvlup-sw/exarchos)
  [![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

  [Install](#install) · [What's different](#whats-different) · [What you get](#what-you-get) · [Architecture](#agent-first-architecture) · [Docs](https://lvlup-sw.github.io/exarchos/)
</div>

---

> A local, event-sourced governance engine for coding tasks.

## You already manage this by hand

A `plan.md` per feature. `CLAUDE.md` rewritten between sessions. Summaries scrawled before `/clear` so the next session has something to start from. Phases enforced by you, reminding the agent. It works. It's also manual, and one long context window away from the agent ignoring all of it.

## Survives `/clear`

Come back to any suspended workflow with `/rehydrate`.

```text
❯ /exarchos:rehydrate payments-v2-migration

Workflow Rehydrated: payments-v2-migration
  Phase: implementing | Type: feature
  Task Progress: 4 of 7 complete · last commit on feature/payments-v2
  Next Action: Continue task 5 (gates pending). Run /delegate or pick up manually.
```

The state was never in your conversation. It lives in an append-only event log, and `/rehydrate` is just a projection that rebuilds the workflow document for a fresh context window. The whole thing fits in about 2,500 tokens.

## Your plan.md workflow, with teeth

A state machine owns the phase transitions, not a paragraph in `CLAUDE.md`. The questions between phases — "is this actually implemented?", "does it match the design?" — run as TypeScript checks against your diff and git history, not as prompts the agent can talk itself out of. You approve the design and you approve the merge. The middle runs on its own.

Run `/ideate` to start.

<div align="center">
  <a href="docs/assets/architecture.svg">
    <img src="docs/assets/architecture.svg" alt="Exarchos architecture: workflow pipeline, state machine, agent teams in worktrees, quality gates" width="720" />
  </a>
  <br>
  <sub>Architecture: workflow phases, agent dispatch, convergence gates.</sub>
</div>

## Works with your agent

The CLI is the universal surface. Each runtime talks to it through whatever invocation it speaks natively.

| Runtime | Transport | Skill rendering | Slash commands |
|---------|-----------|-----------------|----------------|
| **Claude Code** | Plugin + MCP | First-class (rendered + hooks) | Yes (`/ideate`, `/plan`, etc.) |
| **Codex CLI** | MCP | First-class | Via Codex's command surface |
| **Cursor** | MCP | First-class | Via Cursor's MCP integration |
| **OpenCode** | CLI | First-class | Via OpenCode's runtime |
| **GitHub Copilot CLI** | CLI | First-class | Via Copilot's runtime |
| Anything else | CLI | Generic bundle | Whatever your agent supports |

## Install

The CLI works everywhere. For Claude Code, the plugin is the recommended path.

**Standalone CLI / MCP server (any agent, any runtime):**

```bash
# Unix (macOS / Linux)
curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh | bash

# Windows (PowerShell)
irm https://lvlup-sw.github.io/exarchos/get-exarchos.ps1 | iex
```

### Verification
```bash
exarchos --version
exarchos doctor
exarchos mcp   # starts MCP server over stdio
```

### Onboard

```bash
exarchos onboard
```

One command drives the repo to a green `doctor`: it detects the runtimes and VCS on your `PATH`, writes or reconciles agent config, installs the matching skills, registers the SessionStart binding, then verifies. Re-running is safe — it reconciles drift only.

| Flag | Effect |
|---|---|
| `--new <name>` | Scaffold a fresh project in `<name>/`, then onboard it. |
| `--dry-run` | Print the reconcile plan; write nothing, emit no events. |
| `--force` | Overwrite hand-edited config (preserved otherwise). |
| `--no-hooks` | Skip the SessionStart hook binding. |
| `--runtime <id>` | Target an explicit runtime (`claude`, `codex`, `opencode`, `copilot`, `cursor`, `generic`); bypasses detection. |

To re-check without writing, run `exarchos doctor`. To re-apply just the remediable diff, run `exarchos doctor --fix`. If a step fails, `onboard` exits non-zero and leaves already-applied steps in place — fix the cause and re-run to pick up the residual diff.

### Claude Code plugin

```bash
/plugin marketplace add lvlup-sw/.github
/plugin install exarchos@lvlup-sw
```

Same binary underneath. The plugin adds Claude Code slash commands, hooks, and rendered skills.

For the two-step flow (download, inspect, then run), channel selection, validation, update, and uninstall, see the [full install guide](https://lvlup-sw.github.io/exarchos/guide/installation).

## Launching a harness

```bash
exarchos claude    # or codex, cursor, copilot, opencode
exarchos claude --dry-run   # print the plan, spawn nothing
```

`exarchos <harness>` hands Exarchos the harness's process and worktree lifecycle end to end: it creates the worktree as event-sourced state, execs the harness into it, watches it stay alive through liveness events, and tears the worktree down on exit. No daemon sits in between — spawn, place, observe, teardown, and nothing else runs.

What it deliberately doesn't do is stop the harness from writing outside that worktree. Filesystem-write confinement belongs to the harness itself, or, when you need it enforced no matter which harness is running, to a remote sandbox — that's a different problem than the one this launcher solves.

## What's different

Plenty of tools live near this problem. Most aren't competitors so much as answers to a different question.

| Approach | What it gives you | Best for |
|----------|-------------------|----------|
| Plan files in repo (manual) | A surface to write context to | Solo, short-lived projects, simple tasks |
| Memory layers | Re-injection of relevant past conversation slices | Cross-session chat continuity |
| Spec-driven toolkits | Artifacts (spec, plan, tasks) as deliverables | Greenfield work where the spec is the deliverable |
| Multi-agent simulators | Many specialized AI personas in concert | Enterprise greenfield with heavy planning |
| Workflow DAG engines | A general-purpose runner for any DAG you write | Custom orchestration across your own pipelines |
| **Workflow harness (Exarchos)** | **Enforced SDLC + event log + rehydratable state** | **Solo and team SDLC work that needs to survive `/clear`** |

A harness is opinionated about the shape of work; an engine isn't. Exarchos's shape is the SDLC, and the state outlives `/clear` because it sits in an event log instead of the context window. Skip it for one-file changes you'll finish in a sitting — plain plan files are the better tool there. It starts earning its keep once work outlives the context window you started it in.

## What you get

Four workflow types (`feature`, `debug`, `refactor`, `oneshot`), each a small state machine that owns its own phase transitions. The agent can't jump straight from implementing to merge because the context got long; the machine just refuses the move.

Review runs in two stages, both as code. First: does the diff match the design you approved? Then, separately: is the code any good? Each stage is a TypeScript check against your diff and git history, with a real exit code, not "the model should take a look."

Implementation goes to typed agents, each in its own git worktree. The implementer writes code test-first. The fixer picks up a failed task with the failure event already in context instead of starting cold. The reviewer is read-only and literally can't edit files. They don't step on each other, because they're not working in the same tree.

Everything they do lands in the event log: every transition, gate result, and agent action. The audit trail is a side effect of how the system works, not a feature someone bolted on. And it stays cheap — registering the MCP surface costs under 500 tokens, and review sends diffs rather than whole files.

### Agent-first architecture

Exarchos ships as a single binary (`exarchos`) with an `mcp` subcommand; Claude Code spawns it as a stdio MCP server. Four composite tools cover the whole surface:

| Tool | What it does |
|------|-------------|
| `exarchos_workflow` | Workflow lifecycle: init, get, set, cancel, cleanup, reconcile |
| `exarchos_event` | Append-only event store: append, query, batch |
| `exarchos_orchestrate` | Team coordination: task dispatch, review triage, runbooks, agent specs |
| `exarchos_view` | CQRS projections: pipeline status, task boards, stack health |

Schemas load lazily through `describe`, so registering the surface at startup costs under 500 tokens. The same `dispatch()` function backs both the MCP transport and the CLI — `exarchos workflow get --featureId my-feature` from a terminal returns exactly what the agent gets.

### Works well alongside

Exarchos handles workflow structure and nothing else. It won't duplicate your code-analysis or docs-retrieval MCP servers, and it won't bundle or vendor them either. Install those yourself if you want them; your agent can call them on its own.

## Workflows

> Commands are shown in short form (`/ideate`). As a plugin they're namespaced: `/exarchos:ideate`, `/exarchos:plan`, and so on.

**Start a workflow:**

| When you need to... | Command | What it does |
|:---------------------|:--------|:-------------|
| Build a feature | `/ideate` | Design exploration, TDD plan, parallel implementation |
| Fix a bug | `/debug` | Triage, investigate, fix, validate (hotfix or thorough) |
| Improve code | `/refactor` | Assess scope, brief, implement (polish or full overhaul) |
| Make a trivial change | `/oneshot` | Lightweight in-session plan → implementing → direct-commit (or opt-in PR) |

**Lifecycle commands:**

| Command | What it does |
|:--------|:-------------|
| `/plan` | Create TDD implementation plan from a design doc |
| `/delegate` | Dispatch tasks to agent teammates in worktrees |
| `/review` | Run two-stage review (spec compliance + code quality) |
| `/synthesize` | Create PR from feature branch |
| `/shepherd` | Push PRs through CI and reviews to merge readiness |

Plus `/checkpoint`, `/rehydrate`, `/reload`, and `/autocompact` for session continuity; `/cleanup` and `/prune` for workflow hygiene; `/tag` and `/tdd` for attribution and strict TDD. Full reference: [docs](https://lvlup-sw.github.io/exarchos/).

## Build & test

```bash
npm run build          # tsc + 5 cross-compiled binaries via `bun build --compile` → dist/bin/
npm run build:binary   # binaries only (skips tsc + skill render)
npm run test:run       # vitest single run
npm run typecheck      # tsc --noEmit
npm run version:check  # verify version is in sync across the 7 derived call sites
npm run validate       # validate plugin structure
```

## License

Apache-2.0. See [LICENSE](LICENSE).
