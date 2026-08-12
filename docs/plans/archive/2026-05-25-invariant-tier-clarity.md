# Plan — Invariant tier clarity (dev vs user) — issue #1489

**Workflow:** `refactor-invariant-tier-clarity` (overhaul track)
**Branch:** `refactor/invariant-tier-clarity`

## Problem

The `authoring-invariants` skill frames invariant tiers as `user` vs `dev`
without surfacing that `dev`/`INV-N` is exarchos's **own reserved substrate
namespace**. A consumer reasonably misreads `dev` as "for my project's
developers" and picks it, silently colliding their `INV-N` ids with exarchos's
built-in `INV-1..6` in the merged `invariants_effective` projection. The
`doctor` `invariants-catalog` check only flags `INV-*` ids in a catalog
registered as **user** tier, so a consumer who self-declares `tier: dev` evades
detection entirely.

## Approach

Single cohesive change implemented directly in one isolated worktree (TDD),
not fanned out to subagents — the change is ~7 files with documented
subagent-worktree-isolation hazards (#1301, stash collisions, stale worktrees)
that aren't worth incurring at this size. Overhaul rigor preserved:
plan-review checkpoint → review → doc-link verify → synthesize → merge checkpoint.

## Design — the guardrail

New shared module `servers/exarchos-mcp/src/verbs/invariants/reserved-tier-guard.ts`:

- `export const EXARCHOS_PACKAGE_NAME = '@lvlup-sw/exarchos'`
- `isExarchosRepo(repoRoot, deps): boolean` — reads `<repoRoot>/package.json`
  via injected `ScaffoldDeps`; returns `true` iff parseable and `name ===
  EXARCHOS_PACKAGE_NAME`. Missing / unreadable / unparseable / mismatched name
  ⇒ `false` (treat "unknown" as "not exarchos" — `dev` is almost always a
  mistake outside exarchos).
- `assertDevTierAllowed({ tier, repoRoot, allowReservedTier }, deps): ToolResult | null`
  — returns `null` (proceed) unless `tier === 'dev'` AND `!allowReservedTier`
  AND `!isExarchosRepo(...)`. In that case returns an INV-5b carrier-shape
  error: `code: 'RESERVED_TIER'`, a message explaining `dev`/`INV-N` is
  exarchos's reserved substrate namespace and would collide with its built-in
  `INV-*`, `suggestedFix` redirecting to `tier: 'user'`, and a note that
  `allowReservedTier: true` overrides for a genuine exarchos fork.

Wiring:

- `handleScaffold` / `handleAdd`: call `assertDevTierAllowed` at entry, before
  any fs mutation. Fires regardless of `dryRun` (so a dry-run preview never
  even renders a dev-tier entry).
- Add `allowReservedTier?: boolean` to `HandleScaffoldArgs` and `HandleAddArgs`.
- `registry.ts`: add `allowReservedTier: z.boolean().optional()` to both the
  `invariants_scaffold` and `invariants_add` Zod schemas (auto-emits the CLI
  `--allow-reserved-tier` flag — schema-driven).
- `composite.ts`: thread `allowReservedTier` through both arg constructions.

## Tasks (TDD-ordered, sequential)

1. **T1 — guardrail module + tests (RED→GREEN).**
   Write `reserved-tier-guard.test.ts` covering: non-exarchos + `dev` → blocked
   (RESERVED_TIER, suggestedFix=user); exarchos repo + `dev` → null;
   `allowReservedTier: true` + `dev` → null; `tier: user` → null regardless;
   missing/unparseable `package.json` → treated as non-exarchos (blocked).
   Then implement `reserved-tier-guard.ts` to green.

2. **T2 — wire into handlers + schemas.**
   Add `allowReservedTier` to both arg interfaces, call `assertDevTierAllowed`
   at the top of `handleScaffold` and `handleAdd`. Add the field to both Zod
   schemas in `registry.ts` and thread through `composite.ts`. Extend
   `scaffold.test.ts` / `add.test.ts` for the blocked-vs-allowed dispatch path.

3. **T3 — docs reframe.**
   - `skills-src/authoring-invariants/SKILL.md` step 3 (Weight): reframe
     `integrity-class` as `user`/`U-N` = every consumer's default; `dev`/`INV-N`
     = exarchos's own reserved substrate (only inside the exarchos repo;
     authoring as a consumer collides). Touch the Number step + tool-invocation
     prose where `dev`/`INV-N` is mentioned.
   - `references/worked-example.md` step 3: one-line clarification.
   - `docs/guides/authoring-invariants.md`: same reframe + document the
     guardrail + `allowReservedTier` override.
   - `scaffold.ts` `renderStarterCatalog()` comment: one line —
     "Consumers always use `user`/`U-N`; `dev`/`INV-N` is exarchos-internal."

4. **T4 — regenerate + verify.**
   `npm run build:skills`; `npm run typecheck && npm run build && npm run
   test:run`; `cd servers/exarchos-mcp && npm run test:run`; `npm run
   skills:guard`. Doc-link verify in update-docs phase.

## Out of scope

- Changing the `doctor` `invariants-catalog` check (it already flags `INV-*` in
  user catalogs; the gap is the self-declared-dev path, which the guardrail
  closes at authoring time).
- Renaming tiers or namespaces; changing the merge/projection semantics.
