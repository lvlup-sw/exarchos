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
| 2 | **config** | `.exarchos.yml` `test:` / `typecheck:` / `install:` | you declare the command directly |
| 3 | **toolchain-config** | `.exarchos.yml` `toolchains:` | a user-declared toolchain's marker matches the repo |
| 4 | **task-runner** | `Taskfile.yml` · `justfile` · `mise.toml` · `Makefile` | a committed runner declares the conventional target |
| 5 | **detection** | built-in toolchain registry | a built-in marker matches (node, .NET, Rust, Go, Python, Java, Ruby, PHP, Elixir, Swift, C/C++) |
| — | unresolved | — | nothing matched → actionable remediation |

Resolution is **per field**: `test` may come from a task runner while `install`
falls through to the built-in registry.

## Built-in toolchains (tier 5)

Zero-config detection. Identity (markers → toolchain) is the single source of truth
in `servers/exarchos-mcp/src/config/toolchains.ts`. .NET detects all three solution
formats — `*.csproj`, `*.sln`, **`*.slnx`** (the modern default).

Node package-manager selection (npm / pnpm / yarn / bun) reads lockfiles via a
table vendored from
[`package-manager-detector`](https://github.com/antfu-collective/package-manager-detector)
(see `src/config/vendor/package-manager-detector/README.md`).

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

## Scaffolding

`new_project` scaffolds a project's commands from the same registry (each
toolchain's `scaffold` map), so no toolchain is treated as canonical. Adding a
scaffoldable language is a registry entry, not a special case.

## See also

- `servers/exarchos-mcp/src/config/toolchains.ts` — the toolchain registry (SoT).
- `servers/exarchos-mcp/src/config/task-runners.ts` — the task-runner tier.
- INV-6 (workload-agnosticism), INV-4 (platform-agnosticity) — the invariants this
  resolver upholds.
