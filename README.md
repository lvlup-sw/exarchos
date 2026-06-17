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

## You already manage this by hand

A `plan.md` per feature. `CLAUDE.md` rewritten between sessions. Summaries scrawled before `/clear` so the next session has something to start from. Phases enforced by you, reminding the agent. It works. It's also manual, and one long context window away from the agent ignoring all of it.

## Survives `/clear`

Come back to any suspended workflow with `/rehydrate`.

```text
❯ /exarchos:rehydrate payments-v2-migration

Workflow Rehydrated: payments-v2-migration

  Phase: implementing | Type: feature

  Task Progress
    4 of 7 complete · last commit on feature/payments-v2

  Artifacts
    Design: docs/designs/payments-v2.md
    Plan:   docs/plans/payments-v2.md
    PR:     not yet created

  Next Action
    Continue task 5 (gates pending). Run /delegate or pick up manually.
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

To re-check without writing, run `exarchos doctor`. To re-apply just the remediable diff, run `exarchos doctor --fix`.

If a step fails (say, an offline skills or deps install), `onboard` exits non-zero and prints a forward-only advisory: already-applied steps are kept, because reconcile never rolls back. Fix the cause and re-run, and `onboard` picks up from the residual diff.

> **Renamed in v2.10.2:** the old `init`, `install-skills`, and `new-project` verbs were folded into `onboard` (use `onboard --new` for greenfield). They survive one release as error stubs that print `renamed → use 'exarchos onboard'`, and are removed at v3.0.

### Claude Code plugin

```bash
/plugin marketplace add lvlup-sw/.github
/plugin install exarchos@lvlup-sw
```

Same binary underneath. The plugin adds Claude Code slash commands, hooks, and rendered skills.

> **No SSH key?** Use the HTTPS URL: `https://github.com/lvlup-sw/.github.git`

For the two-step flow (download, inspect, then run), channel selection, validation, update, and uninstall, see the [full install guide](https://lvlup-sw.github.io/exarchos/guide/installation).

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

A harness is opinionated about the shape of work; an engine isn't. Exarchos's shape is the SDLC, and the state outlives `/clear` because it sits in an event log instead of the context window.

If your work is mostly one-file changes you finish in a single sitting, this is more machinery than you need — that's the "plan files, manual" row, and it's a perfectly good place to be. Exarchos starts earning its keep once a piece of work outlives the context window you started it in.

## What you get

Four workflow types (`feature`, `debug`, `refactor`, `oneshot`), each a small state machine that owns its own phase transitions. The agent can't jump straight from implementing to merge because the context got long; the machine just refuses the move.

Review runs in two stages, both as code. First: does the diff match the design you approved? Then, separately: is the code any good? Each stage is a TypeScript check against your diff and git history, with a real exit code, not "the model should take a look."

Implementation goes to typed agents, each in its own git worktree. The implementer writes code test-first. The fixer picks up a failed task with the failure event already in context instead of starting cold. The reviewer is read-only and literally can't edit files. They don't step on each other, because they're not working in the same tree.

Everything they do lands in the event log: every transition, gate result, and agent action. The audit trail is a side effect of how the system works, not a feature someone bolted on. And it stays cheap. Registering the MCP surface costs under 500 tokens, schemas load only when used, field projection trims a state query by roughly 90%, and review sends diffs rather than whole files.

### Agent-first architecture

Exarchos ships as a single binary (`exarchos`) with an `mcp` subcommand. Claude Code spawns it as a stdio MCP server and talks to it in structured JSON. Four composite tools cover the whole surface:

| Tool | What it does |
|------|-------------|
| `exarchos_workflow` | Workflow lifecycle: init, get, set, cancel, cleanup, reconcile |
| `exarchos_event` | Append-only event store: append, query, batch |
| `exarchos_orchestrate` | Team coordination: task dispatch, review triage, runbooks, agent specs |
| `exarchos_view` | CQRS projections: pipeline status, task boards, stack health |

All four load their schemas lazily through `describe`. At startup only the slim descriptions and action enums register; the full schemas arrive on demand.

`exarchos_view`'s telemetry actions take correlation filters (`operationId`, `correlationId`, `causationId`) so an agent can scope telemetry to the active workflow. Inside an active dispatch the filter defaults to the chain anchor, and explicit args always win. See [`docs/runbooks/correlation-filters.md`](docs/runbooks/correlation-filters.md) for the surface.

Every tool input is a Zod-validated discriminated union keyed on `action`. The same `dispatch()` function backs the MCP transport and the CLI, so `exarchos workflow get --featureId my-feature` from a terminal returns exactly what the agent gets. One binary, same behavior whether a person or an agent is driving it.

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
| `/cleanup` | Resolve merged workflow to completed state |
| `/prune` | Interactively bulk-cancel stale non-terminal workflows |
| `/checkpoint` | Save workflow state for later resumption |
| `/rehydrate` | Restore workflow state after compaction or a session break |
| `/reload` | Re-inject context after degradation |
| `/autocompact` | Toggle autocompact or set threshold |
| `/tag` | Attribute the current session to a feature or project |
| `/tdd` | Plan implementation using strict Red-Green-Refactor |

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
