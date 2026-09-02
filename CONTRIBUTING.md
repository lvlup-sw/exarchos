# Contributing to Exarchos

## Getting Started

```bash
git clone https://github.com/lvlup-sw/exarchos.git
cd exarchos
npm install
npm run build
npm run test:run
```

## Building the binary locally

For contributors debugging the bootstrap script (`tools/release/get-exarchos.sh` /
`tools/release/get-exarchos.ps1`) or the compiled-binary install path end-to-end,
produce a local binary instead of waiting for a release build in CI:

```bash
npm run build:binary                                # cross-compiles all 5 targets
bun run tools/release/build-binary.ts                     # host-platform binary only
bun run tools/release/build-binary.ts --target linux-x64  # single named target
```

The resulting artifacts land in `dist/bin/` as `exarchos-<os>-<arch>` (plus
`.exe` on Windows). Verify with:

```bash
dist/bin/exarchos-<os>-<arch> --version
```

The cross-compile target matrix and Bun `--compile` flags live in
[`tools/release/build-binary.ts`](tools/release/build-binary.ts). This is the same script
the release workflow invokes, so a local `build:binary` reproduces what the
bootstrap script will ultimately download from GitHub Releases — handy when
you need to iterate on bootstrap behavior without pushing tags.

## Branch Naming

Use these prefixes for branch names:

- `feat/` — new features
- `fix/` — bug fixes
- `refactor/` — code restructuring without behavior changes
- `chore/` — maintenance, tooling, CI, dependencies

## PR Process

1. Create a feature branch from `main` using the naming conventions above.
2. Write tests first (TDD) — co-located as `foo.test.ts` alongside `foo.ts`.
3. Implement your changes.
4. Ensure all tests pass: `npm run test:run`
5. Ensure types check: `npm run typecheck`
6. If your change touches skills, run `npm run build:skills` and commit both source and generated tree. Verify with `npm run skills:guard`.
7. Open a PR against `main`.

## Editing skills

Skill source lives at `content/<domain>/skills/<name>/SKILL.md`, where `<domain>` is one of
`design`, `delivery`, `review`, `synthesis`, `continuity`, `governance`, `remediation`, `harness`
or `_shared`. The `rendered/` tree is generated from it — don't edit those files directly; they get
overwritten on every build.

To add or change a skill:

1. Edit the `SKILL.md` (or anything under its `references/`).
2. Run `npm run build:skills` to regenerate the per-runtime variants.
3. Commit both the source and the regenerated `rendered/` tree.

CI runs `render:guard` on every push and fails your PR if `rendered/` is out of sync with
`content/`. That catches forgotten rebuilds and stale direct edits in one shot.

The placeholder vocabulary, how to add a runtime, and the structural-override
escape hatch are documented in `content/README.md` and in the renderer's own
module headers under `src/install/build-skills/`. The longer authoring guide
moved to the `lvlup-sw/docs` repository (`npm run docs:mount` to read it here).

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/) format:

- `feat:` — new feature
- `fix:` — bug fix
- `refactor:` — code restructuring
- `chore:` — maintenance tasks
- `docs:` — documentation changes

Example: `feat: add workflow status command`

## Exarchos Workflow

This project uses Exarchos for SDLC governance. The standard workflow is:

`/ideate` → `/plan` → `/delegate` → `/review` → `/synthesize`

Each phase is event-sourced and tracked. See the project skills for details.

## Code Style

- **ESM** — `"type": "module"` with NodeNext resolution
- **Strict TypeScript** — `strict: true`, no `any`, use `unknown` with type guards
- **Co-located tests** — `foo.test.ts` alongside `foo.ts`
- **Vitest** — `import { describe, it, expect, vi } from 'vitest'`
- **Node >= 20**
