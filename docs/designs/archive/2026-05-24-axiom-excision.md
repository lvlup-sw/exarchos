# Design: Fully retire and excise axiom (#1477)

- **Date:** 2026-05-24
- **Feature ID:** `axiom-excision`
- **Milestone:** v2.10.0 — Agent Output Contract
- **Issue:** [#1477](https://github.com/lvlup-sw/exarchos/issues/1477)
- **Discovery input:** `docs/research/2026-05-24-hooks-templating-and-invariants-onboarding.md` (Round 2 §Directive C + §"The cross-cutting decision")
- **Cohort:** gates #1478 (catalog content-complete); independent of #1476, #1479, #1470

## Problem

`axiom` is an external plugin (`axiom@lvlup-sw`) that Exarchos took a hard dependency on for design-time and review-time quality dimensions. That dependency is now load-bearing in four places — config resolution, the review orchestrator, the invariants loader, and ~10 tests — and it must be **excised, not merely disabled**. "Leave nothing lingering" is the directive: no dead config keys that silently re-enable, no orphaned loader machinery, no skill text invoking retired skills.

The change is high-leverage because it is the **keystone of the v2.10.0 GA cohort**: it carries the DIM-1..8 decision that gates #1478's catalog content-completeness. Until that decision is made and applied, the catalog cannot be finalized.

## The keystone decision: DIM-1..DIM-8 — **Option 1 (Excise)**

The 8 `DIM-*` catalog entries are simultaneously (a) axiom-dimension pointers whose summaries name `/axiom:critique`, `/axiom:harden`, etc. as the "canonical check", and (b) the targets of 11 `axiom_overlap` referential-integrity links carried by INV-* entries.

**Who consumes `axiom_overlap`?** Exactly one machinery path: the loader's referential-integrity check (`invariants-loader.ts:508-522`), which exists to keep `axiom_overlap → DIM-N` pointers valid for **`/axiom:design`'s pairing-discovery**. `/axiom:design` is itself an axiom-plugin skill retired by this issue. **The sole consumer of the DIM-* machinery disappears in the same change.**

**Decision: Option 1 — excise DIM-* entirely.**

- Remove all 8 `DIM-*` entries from `docs/architecture/invariants.md`.
- Remove all 11 `axiom_overlap` fields from the INV-* entries.
- Remove the `axiomOverlap` type, parse path, and referential-integrity check from `invariants-loader.ts` (and the schema doc row at `invariants.md:745`).
- Catalog drops from 27 → 19 entries (18 INV-* + `basileus-boundary`).

**Why not Option 2 (adopt DIM-* as native vocabulary)?** It would leave 8 entries whose summaries still say "axiom-owned, see `/axiom:X`" pointing at a retired plugin, force a rename (`axiom_overlap → dimension_overlap`) of a field with **no remaining consumer**, and contradict the "fully excise" directive. The taxonomy's only live use is 3 parenthetical rows in the brainstorming Phase-0 selection table — thin justification for a schema field + loader machinery + integrity check + 8 entries.

**Cost of Option 1** (bounded, mechanical): `skills-src/brainstorming/SKILL.md` uses the DIM taxonomy in two spots — the Phase-0 selection table (lines ~40-42 / 71-73, where each DIM is already paired with an INV-*) and the constraint-anchoring render template (lines ~54 / 85, `- DIM-1: <summary>`). The table rows lose their `DIM-*` parenthetical (the INV-* pairing stays); the render template's DIM line is dropped. Re-run `npm run build:skills` to propagate to all 6 runtime copies.

## Three excision traps (order is load-bearing)

Verified against source:

1. **Deleting the `plugins.axiom` key re-enables axiom.** `resolve.ts:283` defaults `axiomEnabled` to `true` when the key is absent (`?? DEFAULTS.plugins.axiom.enabled`, and `DEFAULTS` at `:129` is `{ enabled: true }`). → Set `enabled: false` first; remove the key only **after** the schema field is gone.
2. **Removing `axiom` from the strict Zod schema before the yml → runtime crash.** `PluginsConfig` (`yaml-schema.ts:114-117`) is `.strict()`; any `.exarchos.yml` still carrying `plugins.axiom` throws on parse once the field is removed. → Remove from yml first, schema second.
3. **Removing DIM-* before stripping `axiom_overlap` → loader throws.** The integrity check (`invariants-loader.ts:508-522`) throws for every dangling `axiom_overlap`, breaking `/ideate` Phase 0, `invariants_effective`, and the conformance gate. → Strip `axiom_overlap` fields **in the same edit** as removing DIM-* entries; remove the integrity check with them.

## End-state contracts

- `.exarchos.yml` has **no** `plugins.axiom` block; `PluginsConfig` no longer declares `axiom`; `resolve.ts` no longer has an `axiom` field, default, or read. The `impeccable` plugin path is untouched.
- `prepare-review.ts` no longer returns a `pluginStatus.axiom` entry; `commands/review.md` no longer invokes `Skill({skill:"axiom:audit"})`; the Tier-3 spec `skills-src/quality-review/references/axiom-integration.md` is deleted; `skills-src/quality-review/SKILL.md` no longer references it. Review verdict path uses the invariants catalog + conformance gate as its design-validation source.
- `docs/architecture/invariants.md` is schema-version 3, 19 entries, **no** `axiom_overlap` fields, **no** DIM-* entries, **no** `axiom_overlap` schema row. `invariants_effective` for `phase=ideate, workflowType=feature` loads with no throw.
- `invariants-loader.ts` has no `axiomOverlap` type/parse/integrity-check; `InvariantEntry` drops the field.
- `CLAUDE.md:55` rewritten: "Validate all designs against the invariants catalog (`docs/architecture/invariants.md`) / Aspire / roadmap conventions" (drops "axiom").
- Grep sweep across the working tree (excluding `.worktrees`, `dist`, git history) returns **zero** functional references to `axiom`, `axiom_overlap`, `axiomOverlap`, `axiom:audit`, `pluginStatus.axiom`. (Historical `docs/` mentions and citations may remain by explicit allowance — see Phase 8.)

## Ordered plan (8 phases, derived from the issue checklist + traps)

1. **Disable** — `.exarchos.yml`: `plugins.axiom.enabled: false` (trap 1: do **not** delete the key yet).
2. **Skills/commands + regenerate** — delete `axiom-integration.md`; edit `quality-review/SKILL.md`, `brainstorming/SKILL.md` (Phase-0 table + render template, per the DIM Option-1 cost above), `commands/review.md`, `commands/ideate.md`; run `npm run build:skills` to clear all 6 runtime copies.
3. **Config schema + resolver** — remove `axiom` from `yaml-schema.ts:115`, `resolve.ts:54/129/283/309`, `prepare-review.ts:71-74` + the `FINDING_FORMAT` comment at `:25`; **then** remove the `plugins.axiom` block from `.exarchos.yml` (trap 2: schema field gone before yml key).
4. **Loader + catalog** — remove `axiomOverlap` type/parse/integrity from `invariants-loader.ts`; in the **same edit** remove the 11 `axiom_overlap` fields, the 8 DIM-* entries, and the schema-doc row (trap 3).
5. **Tests** — delete/rewrite axiom assertions: `invariants-loader.test.ts` (Wave C3), `dev-catalog-content.test.ts:75`, `invariant-schema.test.ts:48`, `prepare-review.test.ts`, `yaml-schema.test.ts`, `resolve.test.ts`, `review-verdict.test.ts:364`, `registry.test.ts:1541/1558`.
6. **Instruction** — rewrite `CLAUDE.md:55`.
7. **Reconcile active plan** — `docs/plans/2026-05-24-invariants-dev-catalog-v3-content.md` bakes DIM-4/5/6/8 axiom cross-refs into acceptance criteria; re-scope it to the 19-entry catalog so #1478 inherits a consistent target.
8. **Historical docs** — low priority; drop the stale `axiom:scaffold-invariants → retired design-invariants` pointer at minimum. Decide allow-list for historical `docs/` mentions vs. the grep sweep (recommend: exclude `docs/research/`, `docs/rca/`, `docs/contexts/`, and citation strings from the "zero references" bar — they are historical record).

## Invariant & dimension constraints (Phase 0 + /axiom:design)

- **INV-4 (platform-agnosticity):** Phase 2 edits `skills-src/` source-of-truth only; `skills/<runtime>/**` is regenerated via `build:skills`. Never hand-edit generated output — `skills:guard` (INV-4 mode:`check`) fails on drift.
- **INV-2 (facade-equivalence):** `prepare-review.ts` is shared dispatch core, not an adapter — removing the axiom field there keeps CLI↔MCP parity by construction. No adapter behavior changes.
- **DIM-5 (hygiene) — primary axis:** this is a deletion change; success is measured by *absence* (the grep sweep). Excising DIM-* + `axiomOverlap` removes machinery whose consumer is gone.
- **DIM-6 (solid-coupling):** removes Exarchos's outward dependency on an external plugin's vocabulary; the invariants catalog becomes self-contained.
- **DIM-3 (contracts):** the catalog is a contract consumed by the loader, the conformance gate, and `vocabulary-lint`. Phase 4 must keep the loader, the gate's audit-prompt generator (`audit-prompt.ts`), and `vocabulary-lint` (which scans for `DIM-\d+` tokens) mutually consistent — after excision, a lingering `DIM-N` reference anywhere in `docs/`, `skills-src/`, or `commands/` will fail the enforcing vocabulary lint. Phase 2 + Phase 8 must clear those tokens.
- **DIM-2 (observability):** no silent degradation introduced; the loader throw being removed is replaced by *fewer* entries, not a swallowed error.

## Test Plan

- `cd servers/exarchos-mcp && npm run test:run` and root `npm run test:run` — green after Phase 5 test excision.
- `npm run typecheck` — clean; no dangling `axiom`/`axiomOverlap` types.
- `npm run build:skills && npm run skills:guard` — clean (generated tree matches de-axiom'd source).
- `npm run lint:invariants` (vocabulary-lint) — clean; zero `DIM-\d+` tokens resolve to removed entries.
- `exarchos_view { action: "invariants_effective", phase: "ideate", workflowType: "feature" }` — loads without throw; returns 19 + SDLC entries (no DIM-*).
- Grep sweep (working tree, excluding `.worktrees`/`dist`/git history/allow-listed historical docs): zero functional references to `axiom`, `axiom_overlap`, `axiomOverlap`, `axiom:audit`, `pluginStatus.axiom`.

## Out of scope / deferred

- #1478 (catalog content-complete — 4 broken refs + citations) consumes this issue's DIM decision but is a separate PR.
- #1476 observer-hooks, #1479 init/doctor scaffold, #1470 npm-template are independent cohort members.
- Uninstalling the axiom plugin from the user's environment is not required — Exarchos simply stops depending on it.
