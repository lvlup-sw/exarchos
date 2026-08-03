# Toolchain & command resolution

Exarchos resolves a repository's **test / typecheck / install** commands — and,
since the verification ladder (epic #1515), the wider **mutation / lint** field
set via `resolveVerificationRuntime` — through a layered resolver. Universality
comes from the *strategy*, not from a baked-in list of languages: a built-in
convention table covers the common ecosystems, and two declaration tiers let any
toolchain work with zero changes to Exarchos.

Onboarding consumes the same resolver: `exarchos onboard` / `doctor --fix`
resolve the full verification field set and seed resolved-but-undeclared
`mutation:` / `lint:` commands into `.exarchos.yml` (commands only — the
verification *policy* is never written into consumer config; it resolves at
runtime, see [`exarchos-yml-verification.md`](exarchos-yml-verification.md)).
The `verification-toolchain` doctor check reports per-field resolvability.

## Precedence (highest wins, per field)

| # | Tier | Source | When it fires |
|---|------|--------|---------------|
| 1 | **override** | dispatch argument | a caller passes an explicit command |
| 2 | **config** | `.exarchos.yml` `test:` / `typecheck:` / `install:` / `mutation:` / `lint:` | you declare the command directly |
| 3 | **toolchain-config** | `.exarchos.yml` `toolchains:` | a user-declared toolchain's marker matches the repo |
| 4 | **task-runner** | `Taskfile.yml` · `justfile` · `mise.toml` · `Makefile` | a committed runner declares the conventional target |
| 5 | **detection** | built-in toolchain registry | a built-in marker matches (node, .NET, Rust, Go, Python, Java, Ruby, PHP, Elixir, Swift, C/C++) |
| — | unresolved | — | nothing matched → actionable remediation |

Resolution is **per field** across the whole verification surface — `test`,
`typecheck`, `install`, `mutation`, and `lint` each resolve through the same five
tiers independently: `test` may come from a task runner while `install` falls
through to the built-in registry, and `mutation` / `lint` follow the identical
precedence (a `.exarchos.yml` `mutation:` pin beats a task-runner target beats the
built-in registry default).

## Built-in toolchains (tier 5)

Zero-config detection. Identity (markers → toolchain) is the single source of truth
in `servers/exarchos-mcp/src/config/toolchains.ts`. .NET detects all three solution
formats — `*.csproj`, `*.sln`, **`*.slnx`** (the modern default).

Node package-manager selection (npm / pnpm / yarn / bun) reads lockfiles via a
table vendored from
[`package-manager-detector`](https://github.com/antfu-collective/package-manager-detector)
(see `src/config/vendor/package-manager-detector/README.md`).

Per package manager, the resolved `test` command is:

| PM    | gating script | resolved `test`          | fallback when script absent |
|-------|---------------|--------------------------|-----------------------------|
| npm   | `test:run`    | `npm run test:run`       | unresolved (add `test:run`) |
| pnpm  | `test`        | `pnpm test`              | unresolved (add `test`)     |
| yarn  | `test`        | `yarn test`              | unresolved (add `test`)     |
| bun   | `test:run`    | `bun run test:run`       | `bun test` (native runner)  |

Bun is the one runner that never resolves *unresolved-test*: it ships a
built-in `bun test`. But when a bun repo commits an explicit `test:run` script
(e.g. a vitest-on-bun project), the resolver honors it via `bun run test:run`
rather than shelling into Bun's native runner over vitest files — so a repo like
`servers/exarchos-mcp` (bun lockfile + `test:run: vitest run`) resolves the
**same** intended command family as the npm-managed repo root, keeping the two
supported workspaces on one runner and one timeout policy.

## Task-runner tier (tier 4) — language-agnostic

If your repo commits a standard task runner with a conventional `test` (or
`build` / `typecheck` → `check` / `install` → `deps`) target, Exarchos runs it —
regardless of language, with no configuration:

```yaml
# Taskfile.yml
tasks:
  test:
    cmds: [pytest -q]
```

→ resolves `test` to `task test`. The same works for `justfile` (`just test`),
`mise.toml` `[tasks]` (`mise run test`), and `Makefile` (`make test`). Exarchos
confirms the target actually exists before offering its command.

## User toolchains (tier 3) — declare anything

For a toolchain with no built-in support, declare it in `.exarchos.yml`. This is
the universal escape hatch — any language, zero code:

```yaml
toolchains:
  - id: zig
    projectType: Zig          # optional; defaults to the id
    markers: [build.zig]       # root filename(s) or "*.ext" glob(s)
    commands:
      test: zig build test
      typecheck: zig build      # optional
      install: zig build         # optional
```

A user toolchain is matched **before** the built-ins, so it also overrides a
built-in for the same marker. Commands are validated against the same
shell-metacharacter allowlist as `test:` / `typecheck:` / `install:`.

## Scaffolding (removed)

Earlier revisions exposed a `new_project` orchestrate action that scaffolded a
project's commands from a per-toolchain `scaffold` map. That greenfield surface
and the registry's `scaffold` field were **removed** (DR-3/DR-5, tasks
017/018): the resolver is detection- and resolution-only. `new_project` is
unregistered (asserted by `new-project-removed.test.ts`), and the registry
above carries `test` / `typecheck` / `install` commands only — no scaffold
tokens and no canonical toolchain.

## See also

- `servers/exarchos-mcp/src/config/toolchains.ts` — the toolchain registry (SoT).
- `servers/exarchos-mcp/src/config/task-runners.ts` — the task-runner tier.
- INV-6 (workload-agnosticism), INV-4 (platform-agnosticity) — the invariants this
  resolver upholds.
