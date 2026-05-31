# Plan — Universal Layered Toolchain Resolver (Bundle B: #1508 + #1507)

**Workflow:** `refactor-v2-10-1-bundles` · overhaul track
**Date:** 2026-05-31
**Integration branch:** `refactor/toolchain-registry-b` (off `main`)

## Goal

Replace the duplicated, drift-prone, enumeration-limited encoding of *toolchain identity +
commands* (today spread across three surfaces) with **one layered resolution strategy** whose
universality comes from *declaration + task-runner conventions + an escape hatch* — not from a
longer baked-in list. `.slnx` detection (#1507) and the npm-canonical scaffolder rewrite
(#1508) fall out as **consequences** of the consolidation.

## Why "a bigger registry" is not the fix (research-grounded)

There is **no industry standard** mapping a repo → build/test commands (no `.well-known`, no
manifest spec, no RFC). The Linguist family detects *language*, never a command — every
polyglot tool (devcontainers, Nixpacks, Netlify build-info, Nx/moon, Aider) **owns its own
ecosystem table** and wraps it in the same cascade: *declaration-first → convention-fallback →
escape-hatch-always*. Aider, the most agent-shaped reference, deliberately leans on
`--test-cmd` over auto-detection. Universality is a **strategy**, and the enumerable table is
only its bottom convenience tier.

## Target architecture — the layered resolver

```
resolve(repoRoot, kind ∈ {test, typecheck, install, build}):
  1. explicit override (dispatch arg)                              ✅ exists
  2. .exarchos.yml  test:/typecheck:/install:  (direct)            ✅ exists   ← escape hatch
  3. .exarchos.yml  toolchains:  (user marker→commands)            ❌ NEW      ← any toolchain, zero code
  4. repo TASK-RUNNER declaration (language-agnostic)              ❌ NEW      ← truly universal
       Taskfile.yml → task <t> · justfile → just <t>
       · mise.toml [tasks] → mise run <t> · Makefile → make <t>
  5. built-in ecosystem registry (convention table)               ◑ EXPAND   ← zero-config convenience
       node (via package-manager-detector) · dotnet(*.csproj|*.sln|*.slnx)
       · cargo · python · go · java(gradle|maven) · ruby · php · elixir · swift · cmake
  6. unresolved → remediation                                     ✅ exists
```

**Per-field precedence:** override > yml-direct > user-`toolchains:` > task-runner > registry >
unresolved. Exarchos already owns tiers 1–2 and 6; this plan adds tiers 3–4 and deepens tier 5,
which removes the enumeration ceiling entirely (tier 4 covers any language whose repo uses a
standard runner with zero config; tier 3 covers anything the operator declares).

### Dependency decision (approved)

Adopt **`package-manager-detector`** (antfu-collective; **zero deps**, MIT, 15.4M wk DLs — the
`@antfu/ni` engine) for npm/pnpm/yarn/bun/deno resolution. Deletes the hand-rolled
`detectNodePackageManager` / `isYarnBerry` logic; gains `devEngines` / `packageManager`-field /
upward-crawl handling. Lives in `servers/exarchos-mcp/` (already has deps), **not** the dep-free
root installer. Declined: `linguist-*` language detection (advisory only, never yields a
command; `linguist-js` does a runtime network fetch — unfit for a sandboxed agent).

### Stability boundary (blast-radius control)

Refactor is internals + additive layers behind **preserved public contracts** so the 8 resolver
consumers and 4 static-analysis consumers need zero changes:
- `resolveTestRuntime(repoRoot, options): ResolvedRuntime` — signature preserved; `ResolutionSource`
  enum **widened** with `'toolchain-config'` (tier 3) and `'task-runner'` (tier 4). The
  `command.resolved` event `source` enum widens in lockstep (INV-1 contract change — see T5).
- `runStaticAnalysis(input): StaticAnalysisResult` — signature + `projectType` string values preserved.
- `handleNewProject(args): ToolResult` — signature + behavior preserved; only command *source* changes.

## Task breakdown (TDD, sequential on one worktree)

> **Execution model — sequential, NOT parallel fan-out.** Tiers/consumers depend on the registry
> (T1). Native worktree isolation bases subagents on `main` (#1509/#1501, deferred this pass), so
> a delegated "consume the registry" task would boot without it and self-block. Tasks run
> sequentially on the single integration branch (orchestrator-inline TDD, or one base-pinned
> implementer), committing each before the next — sidestepping the exact hazard Bundle A fixes.

### T0 — Characterization baseline (Feathers; GREEN vs current code)
Pin current `resolveTestRuntime` (node npm/pnpm/yarn/bun, dotnet `.csproj`, rust, python,
unresolved), `runStaticAnalysis` (detection + SKIP message per type), and
`applyLanguageCustomizations` (ts, csharp) outputs. Guards the refactor.

### T1 — Registry SoT `config/toolchains.ts` (additive; tier 5 data)
`Toolchain { id, projectType, markers (exact + ext-glob, priority-ordered), commands{test,
testCoverage, typecheck, install} }` + `detectToolchain(repoRoot, extraEntries?)`. Built-in
entries incl. dotnet `*.csproj|*.sln|*.slnx`, plus java(gradle|maven), ruby, php, elixir, swift,
cmake. Unit tests incl. `.slnx`/`.sln` → dotnet (RED→GREEN). No consumers yet.

### T2 — Adopt `package-manager-detector` for node PM
Add dep to `servers/exarchos-mcp/package.json`. Resolve node pm + commands via the lib’s
`detect` + `resolveCommand`; delete `detectNodePackageManager`/`isYarnBerry`. Wire into the
registry’s node entry (script-existence checks for `test`/`test:run` retained). Node
characterization (T0) stays green.

### T3 — Task-runner tier `config/task-runners.ts` (tier 4; pure)
Detect `Taskfile.yml|.yaml`, `justfile|Justfile|.justfile`, `mise.toml|.mise.toml|mise/config.toml`,
`Makefile|makefile|GNUmakefile`; confirm the conventional target exists (YAML/TOML parse, justfile
+ Makefile regex `^<target>:`); map kind→`task|just|mise run|make <target>`. Target candidates per
kind (test→[test], typecheck→[typecheck,check], install→[install,deps], build→[build]). Tested in
isolation.

### T4 — Config-extensible `toolchains:` (tier 3)
Extend `exarchos-config-schema.ts`: `toolchains?: Array<{ id, markers: string[], commands:{test?,
typecheck?, install?, testCoverage?} }>` with the existing SAFE_COMMAND_PATTERN guard. Loader
merges user entries into `detectToolchain` (user id overrides built-in; user entries matched first).

### T5 — Unified layered resolver in `test-runtime-resolver.ts`
Wire precedence override > yml-direct > user-`toolchains:` > task-runner > registry > unresolved,
per field. Widen `ResolutionSource` + the `command.resolved` event `source` enum (INV-1: update the
event zod schema + any parity/snapshot tests atomically). Preserve `ResolvedRuntime` shape +
remediation semantics. T0 resolver characterization green + new per-tier tests (user toolchain wins
over registry; Taskfile `test` wins over `cargo test`; `.slnx`→`dotnet test`).

### T6 — static-analysis consumes registry
`detectProjectType` → `detectToolchain` (map `Toolchain.projectType`); SKIP message lists registry
markers (incl. `*.slnx`). Check-runners unchanged; toolchains without a runner SKIP honestly. T0
static-analysis green + `.slnx` no-false-SKIP test.

### T7 — new-project consumes registry
Replace `applyLanguageCustomizations` rewrite with composition from `registry[toolchain].commands`
keyed off `language`. npm-canonical asymmetry deleted. T0 new-project green + “commands sourced from
registry, not rewrite” test.

### T8 — Sweep + docs + invariant verification
Grep three surfaces for residual marker/command literals (all flow from `toolchains.ts`/resolver).
`npm run typecheck`, full `npm run test:run` (root + `servers/exarchos-mcp`), `npm run lint:invariants`,
`check_invariant_conformance` (INV-6/4/2/1). Docs: configuration guide gains the `toolchains:` key +
resolution-precedence section; CLAUDE.md architecture note on the layered resolver.

## Invariants applied (devCatalog enabled)

- **INV-6 workload-agnosticism** — the layered strategy is maximally toolchain-agnostic; closes the
  #1470 residue and removes the enumeration ceiling.
- **INV-4 platform-agnosticity** — single source of truth; surfaces derived; new tiers harness-neutral.
- **INV-2 facade-equivalence** — resolution behavior in the shared core; resolver/static-analysis/
  new-project stay thin consumers.
- **INV-1 event-sourcing-integrity** — `command.resolved` contract preserved; `source` enum widening
  done atomically with its schema + tests.

## Success criteria

1. Three surfaces contain no independent marker lists or command literals — all from `toolchains.ts`.
2. Any toolchain resolvable with **zero code**: via a standard task runner (tier 4) or a user
   `.exarchos.yml toolchains:` entry (tier 3).
3. `.slnx`/root-`.sln` .NET repos detect in both `check_static_analysis` and `test-runtime-resolver`
   (#1507); `new-project` derives non-npm commands from the registry, not a rewrite (#1508).
4. `package-manager-detector` adopted; hand-rolled node PM logic deleted.
5. All tests green; characterization + per-tier + `.slnx` tests added; typecheck + invariant lint clean;
   `skills:guard` unaffected; docs updated.

## Out of scope (this pass)

- Bundle A (#1509/#1501 worktree base), Bundle C (#1472/#1471 cross-harness), Bundle D
  (#1485/#1473 events/hooks) — re-planned after B lands.
- New static-analysis *check runners* for java/ruby/php/etc. (detection lands now; runners are a
  follow-up — those toolchains SKIP honestly until then).
- Widening `new-project`’s `language` arg union beyond ts/csharp (registry makes it trivial later).
