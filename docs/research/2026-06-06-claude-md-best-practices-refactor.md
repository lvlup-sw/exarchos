# CLAUDE.md Best-Practices Refactor — Discovery Report

- **Workflow:** `claude-md-bestpractices-refactor` (discovery)
- **Date:** 2026-06-06
- **Author:** Claude (Opus 4.8) via `/exarchos:discover`
- **Goal:** Refactor the project `CLAUDE.md` to (a) properly utilize our plugins/MCP and (b) strictly adhere to documented best practices.
- **Deliverable:** This report + a complete proposed `CLAUDE.md` rewrite (§4). Applying the rewrite is a follow-on step (§6).

---

## 1. Executive Summary

The current `CLAUDE.md` is **62 lines** — already under Anthropic's "≤200 line" target, so the problem is **not length, it's content discipline and tool leverage**:

1. **It rots.** The `Architecture` section carries version/PR/issue stamps (`removed in v2.9 (task 3.1)`, `post PR #1076`, `v2.10.1 Bundle B (#1508/#1507)`) and "Not implemented today" future-work notes. Best practice is unanimous: *if a line might not be true in six months, it doesn't belong in CLAUDE.md* — move history to ADRs/git, move future work to issues.
2. **It is encyclopedic where it should be a pointer.** Several architecture bullets are dense prose that "reads well to a human" — the exact signal that it's *too wordy for CLAUDE.md*. The repo already has `docs/architecture/`, `docs/guides/`, and RCAs; CLAUDE.md should point, not paraphrase.
3. **It says nothing about the tooling available in this repo.** There is no guidance to dogfood the Exarchos MCP workflows, prefer `serena` for symbol navigation, use `sem`/`weave` for semantic git, or pull docs via `context7`/`exa`. This is the single biggest *additive* opportunity and is squarely project-specific (it differs from defaults), so it legitimately belongs in CLAUDE.md.
4. **A little is derivable noise.** `ESM`, `strict: true`, `Node >= 20` are readable from `package.json`/`tsconfig.json`. Low-cost, but best practice says cut what Claude can infer.

The proposed rewrite (§4) is **~95 lines**: keeps every load-bearing fact (the two-state-surface integrity rule, the layered toolchain resolver, skills source-of-truth, workflow-dispatch gotchas), **adds a lean `Tooling` section** for plugin/MCP leverage, and **strips the rot**.

---

## 2. Best-Practices Synthesis

Sourced from official Claude Code docs (`code.claude.com/docs/en/{best-practices,memory,plugins,mcp}`) and high-credibility practitioner sources (HumanLayer, Anthropic `claude-quickstarts`, the `plugin-dev/mcp-integration` skill, and the convergent practitioner blogosphere). Full source list in workflow state `artifacts.sources`.

### 2.1 The load-bearing model (why discipline matters)

- CLAUDE.md is injected as a **user message after the system prompt**, wrapped with *"this context may or may not be relevant… you should not respond to this context unless it is highly relevant."* It is **advisory context, not enforced config**. `[code.claude.com/docs/en/memory]`
- Consequence (HumanLayer): the more non-universal content the file carries, the more Claude learns to **disregard the whole file**. *"As instruction count increases, instruction-following quality decreases uniformly."* Bloat doesn't just waste tokens — it competes with and buries your real rules. `[hlyr.dev]`
- Therefore: **CLAUDE.md = the always-on essentials + judgment calls only the model can make.** Everything else has a better home:
  - Must hold 100% → **hook** (deterministic, zero instruction-budget cost).
  - Reference material / multi-step procedure → **skill** (load on demand).
  - Conditional rule → **`.claude/rules/*.md` with `paths:` frontmatter** (conditional load).
  - MCP tool API → the **server's instructions field** (≤2KB), not CLAUDE.md.

### 2.2 The durable do/don't consensus

**DO**
- Lead with **commands** (build/test/lint) — the highest-value section. Litmus test: a fresh agent should be able to "run the tests" and have it work first try.
- Keep it **short, skimmable, markdown headers + terse bullets**. Target **≤200 lines / ~2,500 tokens** (Anthropic's own CLAUDE.md ≈ 2,500 tokens, treated as a *ceiling*). Shorter is better; HumanLayer's root file is <60 lines.
- Write **specific, verifiable** instructions in **imperative mood** ("Run `npm test` before committing", not "test your changes").
- **Point, don't paste**: one-line pointers to `docs/…` beat ten-line summaries that drift. Prefer `file:line` references over inlined snippets.
- Use emphasis (`IMPORTANT`, `YOU MUST`) sparingly for genuinely load-bearing rules; pair hard constraints with their **reason**.
- **Treat it like code**: version it, prune it when behavior drifts, update it after a repeated correction.

**DON'T**
- Don't include anything **derivable from the repo** (file tree, standard language conventions, `package.json`/`tsconfig` facts), **detailed API docs**, **long tutorials**, or **self-evident advice** ("write clean code").
- Don't let it **rot**: no roadmaps/future-work, no rationale-for-past-decisions, no version/PR stamps. *If it rots, it doesn't belong here.*
- Don't send the LLM **to do a linter's job** — style enforcement belongs in Prettier/ESLint + a hook, not prose.
- Don't write **conflicting** or **vague** rules.
- Don't rely on **`@imports` to save context** — imported files load *eagerly at launch*; imports buy organization/ownership, not context reduction. (Confirmed contradiction inside the official docs; `@imports` are eager — issues #51939 / #11759.) For real context reduction use `.claude/rules` with `paths:`, subdir `CLAUDE.md` (on-demand), or skills.

### 2.3 Plugins + MCP (what the docs actually say)

- **Tool Search is the default** (Claude Code 2.1.x): MCP tool *definitions* are **deferred** — only tool *names* + server instructions load at session start, so "adding more MCP servers has minimal impact on your context window." `[code.claude.com/docs/en/mcp]`
- **But selection accuracy still degrades** past ~30–50 available tools. The defense is *not* documenting tools in CLAUDE.md — it's connecting only what you use and writing good server instructions.
- **Where tool guidance belongs:** the **server's instructions field** (≤2KB, critical detail first), *not* CLAUDE.md. The official `plugin-dev/mcp-integration` skill documents MCP tools in **commands/agents** ("## MCP Tools Used" blocks), never in memory files.
- **The right CLAUDE.md role for tools is *policy, not catalog*:** "In this repo, prefer X for Y" is project-specific and belongs here; an API listing of every tool does not.
- **Skill + MCP division of labor (Anthropic's framing):** *"MCP provides the connection; a skill teaches Claude how to use it well."* CLAUDE.md holds always-on rules; skills hold on-demand reference.

---

## 3. Gap Analysis — current `CLAUDE.md`

| # | Current section | Best-practice verdict | Action |
|---|---|---|---|
| 1 | Intro paragraph | ✅ Concise, names the product + distribution. | Keep; add one clause clarifying this file orients agents working **on** the codebase, and restate the standalone-CLI framing (currently only in Design Philosophy). |
| 2 | **Build & Test** | ✅ Highest-value section, exact commands. | Keep verbatim; add a one-line note on scoped MCP-server tests already present. |
| 3 | **Architecture** (8 dense bullets) | ⚠️ Mixed. Load-bearing facts (state surfaces, toolchain resolver, skills renderer) are gold; but version/PR/issue stamps **rot**, and the prose is encyclopedic where doc links exist. | **Compress.** Strip every `vX.Y`/`#NNNN`/`task N.N` stamp. Keep the integrity rules + doc pointers. Cut "Remote MCP — not implemented today" (future work → keep only the tracking-issue pointer or drop). |
| 4 | Safety | ✅ Short, load-bearing. (Mirrors shipped `rules/rm-safety.md`.) | Keep. |
| 5 | Key Conventions | ⚠️ Mostly good; `ESM`/`strict TS`/`Node>=20` are derivable. | Trim the 3 derivable lines; keep the non-obvious ones (co-located tests, skills source-of-truth, frontmatter rules, reference-file no-frontmatter). |
| 6 | Workflow Dispatch Conventions | ✅ Non-obvious, hard-won orchestration gotchas. | Keep (light copy-edit to imperative). |
| 7 | Design Philosophy | ✅ Concise, genuinely project-specific. | Keep; fold the standalone-CLI line into the intro to avoid duplication. |
| 8 | Local Repro & Verification | ✅ Non-obvious (playwright-cli default, demo creds). | Keep. |
| — | **(missing) Tooling / MCP leverage** | ❌ Absent — the user's primary ask (a). | **Add** a lean `Tooling` section: dogfood Exarchos workflows, prefer serena for symbol nav, sem/weave for semantic git, context7/exa for docs. Policy not catalog. |

**Note on user-scope layering:** `~/.claude/CLAUDE.md` already imports `RTK.md` (token-killer proxy) at user scope and applies to every project. The project CLAUDE.md should **not** restate RTK — it's already in context via the higher layer.

---

## 4. Proposed `CLAUDE.md` (drop-in rewrite)

> ~95 lines. Every load-bearing fact preserved; rot stripped; `Tooling` section added. Doc links point to files that already exist in the repo.

````markdown
# CLAUDE.md

Exarchos is local agent governance for Claude Code — event-sourced SDLC workflows with
agent-team coordination. It ships as a **standalone CLI** with an optional `mcp` subcommand and
plugin packaging (lvlup-sw marketplace) — not as a plugin-with-MCP-tools-only. This file orients
agents working **on the Exarchos codebase**.

## Build & Test

```bash
npm run build          # tsc + bun → dist/ (MCP server + CLI bundles)
npm run test:run       # vitest single run
npm run typecheck      # tsc --noEmit
npm run build:skills   # render skills-src/ → skills/<runtime>/ + command-aliases/<runtime>/
npm run skills:guard   # CI: fails if generated skills/ or command-aliases/ drift from sources

cd servers/exarchos-mcp && npm run test:run   # MCP server tests (build via root `npm run build`)
```

## Tooling (use the plugins/MCP available in this repo)

Tools are deferred via Tool Search — prefer them when a task fits; don't enumerate their APIs here.

- **Dogfood Exarchos itself.** Drive non-trivial features through the workflow commands
  (`/exarchos:ideate` → `/plan` → `/delegate` → `/review` → `/synthesize`); the `exarchos` MCP
  server (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`) is the
  state surface. Run `/exarchos:dogfood` to triage tool failures into code/doc/user-error.
- **Code navigation & edits** — prefer **serena** symbol tools over raw grep for TypeScript
  symbol lookup/rename (call `activate_project` with project `exarchos` first; it errors otherwise).
- **Semantic git** — use **sem** (entity-level diff/blame/impact) and **weave** (entity claim +
  merge coordination) when coordinating multi-agent edits across files.
- **Library/API docs** — pull current docs via **context7** or **exa** instead of relying on
  training memory.

## Architecture

Orientation only — deep detail lives in `docs/architecture/`, `docs/guides/`, and RCAs.

- **Installer** — `scripts/get-exarchos.{sh,ps1}` download the single-file binary from GitHub
  Releases; `.claude-plugin/` packaging registers commands/skills/rules/agents + the `exarchos`
  MCP server.
- **Content layers** — Commands (`commands/*.md`); Skills authored at `skills-src/<name>/SKILL.md`
  (`{{TOKEN}}` placeholders + `references/`) and rendered per-runtime to `skills/<runtime>/`; Rules
  (`rules/*.md` — safety only; domain rules live in `skills-src/*/references/`). Structured
  Markdown, not executable code.
- **Skills renderer** (`src/build-skills.ts`) — `npm run build:skills` substitutes placeholders
  from `runtimes/<name>.yaml`, copies `references/` verbatim into every variant, honors
  `SKILL.<runtime>.md` overrides, and emits canonical command aliases for runtimes declaring
  `canonicalCommandAliases`. `npm run skills:guard` re-renders and fails CI on any `skills/` drift.
- **MCP server** (`servers/exarchos-mcp/`) — 4 visible composite tools + 1 hidden `exarchos_sync`,
  over `@modelcontextprotocol/sdk` + `zod` on stdio. Workflow actions are typed TS handlers
  (`servers/exarchos-mcp/src/orchestrate/`) returning structured `ToolResult` — no bash dependency.
- **Toolchain resolution** — `src/config/toolchains.ts` is the single source of truth for toolchain
  *identity*; consumers (`test-runtime-resolver.ts`, `static-analysis.ts`, `new-project.ts`) hold no
  independent marker/command lists. `resolveTestRuntime` is a synchronous, per-field **layered
  resolver**: override > `.exarchos.yml` direct > user `toolchains:` > task-runner > built-in
  registry > unresolved. See [`docs/guides/toolchain-resolution.md`](docs/guides/toolchain-resolution.md).
- **State surfaces (two, and the distinction is load-bearing)** —
  (1) the **SQLite event store** (`events` + projected `workflow_state` + `streams`) is the
  authoritative record of whether a workflow exists; (2) **`<featureId>.state.json`** is a
  *secondary* "planner's stamp" for plan facts the projection can't derive. A `.state.json` may be
  absent for a tracked workflow and is **not** an existence signal. **Canonical existence check:**
  `rehydrate`/`get` → `_meta.workflowExists` — never filesystem `.state.json` presence. Cold probes
  of unknown featureIds are side-effect-free. RCA:
  [`docs/rca/2026-05-30-state-source-integrity.md`](docs/rca/2026-05-30-state-source-integrity.md).

## Safety

- **NEVER:** `rm -rf /`, `rm -rf ~`, `rm -rf .` in home/root, `rm` with unset vars (`$UNSET_VAR/*`).
- **ALWAYS:** use specific paths, `ls` before deleting, avoid `-f` unless needed, verify `-r`
  targets. When uncertain, preview with `echo rm …` or ask.

## Conventions

- **Co-located tests** — `foo.test.ts` beside `foo.ts`; Vitest (`import { describe, it, expect, vi } from 'vitest'`).
- **Strict TypeScript** — no `any`; use `unknown` + type guards. (ESM / NodeNext / Node ≥20 per `package.json` + `tsconfig.json`.)
- **Skills are source-of-truth at `skills-src/`** — edit there, run `npm run build:skills`, commit
  both source and the regenerated `skills/` tree. Direct edits to `skills/<runtime>/**` fail
  `skills:guard`.
- **Skill frontmatter** — `name` (kebab-case), `description` (≤1,024 chars), `metadata`. Skills that
  invoke Exarchos MCP tools MUST set `metadata.mcp-server: exarchos`; utility/standards skills are exempt.
- **Reference files** (`skills-src/<skill>/references/*.md`) MUST NOT carry YAML frontmatter —
  frontmatter is reserved for entry points (`SKILL.md`, `commands/*.md`, `rules/*.md`).

## Workflow Dispatch

- Dispatch parallel sub-agents from the correct feature/phase branch, **never from `main`** — verify
  base-branch topology before launching waves.
- Run merge commands only from the **main worktree** (not a sub-agent worktree).
- For pruning/archiving, don't trust the prune tool alone — verify stale counts and fall back to
  manual shell archival when it under-reports.
- Insert explicit checkpoints every ~10 tasks or before any phase transition.

## Design Philosophy

- New feature designs follow **agent-first CLI patterns (Aspire-inspired)** — not config-file-centric
  or human-first designs.
- Validate every design against the invariants catalog (`.exarchos/invariants.md`), Aspire, and
  roadmap conventions before presenting.

## Local Repro & Verification

- Before claiming local repro needs new seeding/test accounts, check for existing demo admin
  credentials and wired databases (e.g., Turso).
- For browser automation, default to `playwright-cli` — don't reach for the Chrome extension first.
````

---

## 5. What changed & why (delta rationale)

| Change | Best-practice basis |
|---|---|
| **Added `Tooling` section** (dogfood Exarchos, serena, sem/weave, context7/exa) | The user's ask (a). Project-specific tool *policy* belongs in CLAUDE.md; framed as policy-not-catalog per the MCP docs + `plugin-dev/mcp-integration` skill. |
| **Stripped all version/PR/task stamps** from Architecture (`v2.9`, `#1076`, `Bundle B`, etc.) | "If it rots, it doesn't belong here." History → ADRs/git. |
| **Cut "Remote MCP — not implemented today"** | Future-work/aspirational content is a named anti-pattern; tracking lives in issue #1081. |
| **Compressed encyclopedic bullets**, kept doc links | Point-don't-paste; "reads well to a human → too wordy for CLAUDE.md." |
| **Preserved** state-surface integrity rule + toolchain layered resolver verbatim-ish | These are exactly "architectural decisions / gotchas specific to your project" → INCLUDE. |
| **Trimmed** `ESM`/`strict:true`/`Node>=20` to a parenthetical | Derivable from `package.json`/`tsconfig` — cut what Claude can infer. |
| **Folded** standalone-CLI framing into the intro | Removes duplication between intro and Design Philosophy. |
| **Imperative mood** in Workflow Dispatch / Tooling | "Instructions, not documentation." |

**Net:** 62 → ~95 lines. The increase is entirely the new `Tooling` section (the requested capability); the existing content got *leaner*, not longer.

---

## 6. Recommended next step (escalation to implementation)

This was a discovery workflow — the deliverable is this report. Applying the rewrite is a small, single-file change:

1. **Apply §4 directly** (it's one file, low risk) — or
2. Run `/exarchos:oneshot "apply the CLAUDE.md rewrite from docs/research/2026-06-06-claude-md-best-practices-refactor.md"` if you want it tracked as a workflow with the diff/review gates.

### Open decisions for the reviewer

1. **Architecture depth** — the rewrite keeps 6 compressed bullets. If you want it even leaner (HumanLayer <60-line philosophy), the renderer/installer/orchestrate-handlers bullets could collapse into a single "see `docs/architecture/`" pointer. Trade-off: orientation speed vs. brevity.
2. **`Tooling` scope** — listed serena/sem/weave/context7/exa because they're installed and high-value here. If any are not reliably present for all contributors, drop or qualify them (stale tool references are themselves an anti-pattern).
3. **Hooks vs. prose** — the `skills-src` source-of-truth rule and the `rm` safety rules are currently prose. `skills:guard` already enforces the former as a CI hook; the safety rules could move to a `PreToolUse` hook for 100% enforcement (prose is ~80% adherence). Out of scope for this refactor but worth a follow-up.
4. **`.claude/rules/` split** — at 95 lines there's no need yet, but if the file grows, path-scoped rules (`.claude/rules/*.md` with `paths:`) are the context-cheap way to add conditional guidance.
