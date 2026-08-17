# CLAUDE.md

Exarchos is local agent governance for Claude Code — event-sourced SDLC workflows with
agent-team coordination. It ships as a **standalone CLI** with an optional `mcp` subcommand and
plugin packaging (lvlup-sw marketplace) — not as a plugin-with-MCP-tools-only. This file orients
agents working **on the Exarchos codebase**.

## Build & Test

```bash
npm run build          # tsc + bun → dist/ (MCP server + CLI bundles)
npm run test:run       # the `unit` project ONLY — not the whole root suite
npx vitest run         # every root project (unit + process + outcome + conformance)
npm run test:conformance   # just the extracted conformance suite (tools/conformance/)
npm run typecheck      # tsc --noEmit, root AND tools/conformance
npm run build:skills   # render content/ → rendered/
npm run render:guard   # CI: fails if rendered/ drifts from content/
```

## Tooling (use the plugins/MCP available in this repo)

Global tooling (rtk/sem/weave/serena, context7/exa research) is covered by USER-CONTEXT — not repeated here. Exarchos-specific note:

- **Dogfood Exarchos itself.** Drive non-trivial features through the workflow commands
  (`/exarchos:ideate` → `/plan` → `/delegate` → `/review` → `/synthesize`); the `exarchos` MCP
  server (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`) is the
  state surface. Run `/exarchos:dogfood` to triage tool failures into code/doc/user-error.
- For serena symbol tools, call `activate_project` with project `exarchos` first (it errors otherwise).

## Architecture

Orientation only. Each of the six top-level directories has a `README.md`
saying what belongs in it and what does not, and the layer model is asserted
from the live tree by `tools/audit/layer-map.json` +
`tests/architecture/layer-map.test.ts` — read those rather than a prose copy
that nothing compares against the tree.

The accumulated designs, plans, guides and RCAs now live in the `lvlup-sw/docs`
repository; `npm run docs:mount` symlinks them back into `docs/` if you want
them locally.

- **Installer** — `tools/release/get-exarchos.{sh,ps1}` download the single-file binary from GitHub
  Releases; `.claude-plugin/` packaging registers commands/skills/rules/agents + the `exarchos`
  MCP server.
- **Content layers** — Skills, commands and rules are authored under `content/<domain>/`
  (`{{TOKEN}}` placeholders + `references/`) and rendered per-runtime into `rendered/`. Structured
  Markdown, not executable code.
- **Skills renderer** (`src/install/build-skills/`) — `npm run build:skills` substitutes
  placeholders from `content/harness/runtimes/<name>.yaml`, copies `references/` verbatim into
  every variant, honors `SKILL.<runtime>.md` overrides, and emits canonical command aliases for
  runtimes declaring `canonicalCommandAliases`. `npm run render:guard` re-renders and fails CI on
  any drift in `rendered/`.
- **Tool surface** — 4 visible composite tools + 1 hidden `exarchos_sync`, over
  `@modelcontextprotocol/sdk` + `zod` on stdio. Actions are DECLARED once in `src/registry/`;
  the MCP registration, the CLI verb tree, `describe` and the compiled contract are all
  projections of those declarations. Handlers are typed TS returning structured `ToolResult` —
  no bash dependency.
- **Toolchain resolution** — `src/config/toolchains.ts` is the single source of truth for toolchain
  *identity*; consumers (`test-runtime-resolver.ts`, `static-analysis.ts`) hold no
  independent marker/command lists. `resolveTestRuntime` is a synchronous, per-field **layered
  resolver**: override > `.exarchos.yml` direct > user `toolchains:` > task-runner > built-in
  registry > unresolved. The resolver's own header states the layer order.
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

- **All tests live in `tests/`** — never beside their subject. Pick the tier by what the
  test *is*, then let the tier decide its runtime policy: `acceptance`, `architecture`,
  `benchmarks`, `core`, `e2e`, `evals`, `helpers`, `integration`, `migration`, `outcome`,
  `process`, `scripts`, `smoke`, `support`, `unit`. Vitest
  (`import { describe, it, expect, vi } from 'vitest'`); shell suites are `*.test.sh`.
  Tier → vitest project is declared in `tests/architecture/test-tree-contract.test.ts`, which
  fails if a tier is collected by no project or by two.
- **Strict TypeScript** — no `any`; use `unknown` + type guards. (ESM / NodeNext / Node ≥20 per `package.json` + `tsconfig.json`.)
- **Content is source-of-truth at `content/`** — edit there, run `npm run build:skills`, commit
  both the source and the regenerated `rendered/` tree. Direct edits under `rendered/**` fail
  `render:guard`.
- **Skill frontmatter** — `name` (kebab-case), `description` (≤1,024 chars), `metadata`. Skills that
  invoke Exarchos MCP tools MUST set `metadata.mcp-server: exarchos`; utility/standards skills are exempt.
- **Reference files** (`content/<domain>/skills/<name>/references/*.md`) MUST NOT carry YAML
  frontmatter — frontmatter is reserved for entry points (`SKILL.md`, commands, rules).
- **No directory holds more than 25 non-test files at its own level** — exemptions exist but each
  names a reason and pins its count (`tests/architecture/locality.test.ts`).
- **Comments name no planning ordinal** — no `DR-<n>`, `task <n>`, `INV-<n>`, `wave <n>`, or
  `docs/specs/…` path. State the constraint in words; the policy and its rationale are in
  `.exarchos/comment-policy.json`.

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
