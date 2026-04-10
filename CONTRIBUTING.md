# Contributing to Exarchos

## Getting Started

```bash
git clone https://github.com/lvlup-sw/exarchos.git
cd exarchos
npm install
npm run build
npm run test:run
```

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

Skill source lives at `skills-src/<name>/SKILL.md`. The `skills/<runtime>/...` tree is generated from it — don't edit those files directly; they get overwritten on every build.

To add or change a skill:

1. Edit `skills-src/<name>/SKILL.md` (or anything under `skills-src/<name>/references/`).
2. Run `npm run build:skills` to regenerate the per-runtime variants.
3. Commit both the source and the regenerated `skills/` tree.

CI runs `skills:guard` on every push and fails your PR if `skills/` is out of sync with `skills-src/`. That catches forgotten rebuilds and stale direct edits in one shot.

See [`docs/skills-authoring.md`](docs/skills-authoring.md) for the full workflow: placeholder vocabulary, adding a runtime, and the structural-override escape hatch.

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
