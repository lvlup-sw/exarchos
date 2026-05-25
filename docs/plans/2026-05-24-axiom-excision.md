# Implementation Plan: Fully retire and excise axiom (#1477)

- **Design:** `docs/designs/2026-05-24-axiom-excision.md`
- **Feature ID:** `axiom-excision`
- **Date:** 2026-05-24
- **DIM decision:** Option 1 (excise DIM-* entirely) — locked in design.

## TDD shape for an excision change

This is a deletion change, so the Iron Law maps to **assert-absence-first**: the RED step flips an existing guard test (which currently asserts axiom *presence*) to assert the end-state *absence* — it fails against the current tree. The GREEN step removes the code/config/catalog, turning the assertion green. REFACTOR removes now-dead test scaffolding. Three end-state gates back the unit tests: `npm run typecheck`, `npm run skills:guard`, `npm run lint:invariants`.

## Trap-ordering constraints (from design §"Three excision traps")

1. `.exarchos.yml` `enabled: false` **before** removing the yml key; remove the schema field **before** the yml key (trap 2 → forces config edits into one compile unit, Task 1).
2. Strip `axiom_overlap` fields **in the same edit** as removing DIM-* entries and the loader integrity check (trap 3 → Task 2 is atomic).
3. Catalog DIM-* tokens must be gone (Task 2) **before** `vocabulary-lint` can pass on de-axiom'd skills-src (Task 3).

## Task graph

```
Task 1 (config+review) ─┐
                        ├─► Task 4 (sweep + docs + reconcile)
Task 2 (loader+catalog) ─┼─► Task 3 (skills) ─┘
        (keystone)       │
Task 1 ∥ Task 2 (disjoint files, parallel-safe)
Task 3 depends on Task 2 (vocab-lint needs catalog clean)
Task 4 depends on 1,2,3
```

**High-blast gate (memory: TDD per-task scope too narrow for type/schema reshapes):** Tasks 1 and 2 both reshape broadly consumed contracts (config types; the invariants catalog). Run a full `npm run test:run` + `npm run typecheck` between their merges into the integration branch, not just the per-task scoped suite.

---

### Task 1: Excise axiom from config schema, resolver, and review path
**Phase:** RED → GREEN → REFACTOR
**Phases covered:** Design Phase 1 (disable) + Phase 3 (config + review). Merged into one task because removing the `axiom` field from `ResolvedPluginConfig`/`PluginsConfig` breaks `prepare-review.ts` compilation in the same unit (trap 2).

1. [RED] Flip assertions to expect-absence:
   - `servers/exarchos-mcp/src/config/yaml-schema.test.ts` — `PluginsConfig_WithAxiomKey_Rejected` (strict schema rejects `plugins.axiom`).
   - `servers/exarchos-mcp/src/config/resolve.test.ts` — `ResolveConfig_NoAxiomField_Omitted` (resolved config has no `axiom`).
   - `servers/exarchos-mcp/src/orchestrate/prepare-review.test.ts` — `PrepareReview_PluginStatus_OmitsAxiom`.
   - Expected failure: axiom field/key still present.

2. [GREEN] Apply trap-ordered edits:
   - `.exarchos.yml`: set `plugins.axiom.enabled: false` (trap 1 prep).
   - Remove `axiom` from `config/yaml-schema.ts:115` (PluginsConfig).
   - Remove `axiom` from `config/resolve.ts:54` (type), `:129` (DEFAULTS), `:283` (read), `:309` (output).
   - Remove `pluginStatus.axiom` from `orchestrate/prepare-review.ts:71-74` + `FINDING_FORMAT` comment `:25`.
   - **Then** remove the `plugins.axiom` block from `.exarchos.yml` (trap 2: schema field gone first).
   - Rewrite axiom assertions in `review-verdict.test.ts:364`, `registry.test.ts:1541/1558`.

3. [REFACTOR] Remove dead `DEFAULTS.plugins.axiom` references and any axiom-only test fixtures.

**Files:** `config/yaml-schema.ts`, `config/resolve.ts`, `orchestrate/prepare-review.ts`, `.exarchos.yml`, + 5 test files.
**Dependencies:** None
**Parallelizable:** Yes (disjoint from Task 2)

---

### Task 2: Excise axiom from invariants loader + catalog (DIM-* Option 1) — KEYSTONE
**Phase:** RED → GREEN → REFACTOR
**Phases covered:** Design Phase 4. Atomic edit (trap 3): `axiom_overlap` fields, DIM-* entries, and the loader integrity check must go together or the loader throws.

1. [RED] Flip assertions to expect-absence:
   - `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (Wave C3) — `LoadInvariants_NoAxiomOverlapField_Parsed` + `LoadInvariants_NoDimEntries_CatalogHas19`.
   - `servers/exarchos-mcp/src/architecture/dev-catalog-content.test.ts:75` — drop DIM-* count expectation; assert 19 entries.
   - `servers/exarchos-mcp/src/architecture/invariant-schema.test.ts:48` — `InvariantSchema_NoAxiomOverlap_Accepted`.
   - Expected failure: DIM-* entries + `axiom_overlap` fields + `axiomOverlap` parsing still present.

2. [GREEN] Atomic excision:
   - `architecture/invariants-loader.ts`: remove `axiomOverlap` from `InvariantEntry` type, the parse path in `parseEntry`, and the referential-integrity block `:508-522`.
   - `docs/architecture/invariants.md`: remove the 11 `axiom_overlap` fields, the 8 `DIM-*` entries (`:560-707`), and the `axiom_overlap` schema-doc table row `:745`. Catalog → 19 entries.

3. [REFACTOR] Remove `axiomOverlap`-related helpers/imports; confirm `audit-prompt.ts` (gate prompt generator) compiles with the 19-entry catalog.

**Files:** `architecture/invariants-loader.ts`, `docs/architecture/invariants.md`, + 3 test files.
**Dependencies:** None
**Parallelizable:** Yes (disjoint from Task 1)
**Gate after merge:** full `npm run test:run` + `exarchos_view invariants_effective` smoke (no throw).

---

### Task 3: Excise axiom from skills/commands + regenerate runtime variants
**Phase:** RED → GREEN → REFACTOR
**Phases covered:** Design Phase 2.

1. [RED] Lint-as-test:
   - `npm run lint:invariants` (vocabulary-lint) — must report zero `DIM-\d+` tokens in `skills-src/`/`commands/`/`docs/`. Fails while skills-src still names DIM-*.
   - `npm run skills:guard` — fails after source edits until `build:skills` is re-run (INV-4 drift gate proves regeneration happened).

2. [GREEN] Source-of-truth edits (never touch `skills/<runtime>/**` directly — INV-4):
   - Delete `skills-src/quality-review/references/axiom-integration.md`.
   - Edit `skills-src/quality-review/SKILL.md:337` (drop axiom integration ref).
   - Edit `skills-src/brainstorming/SKILL.md`: Phase-0 selection table rows ~40-42/71-73 (drop `DIM-*` parentheticals, keep INV-* pairing); render template lines ~54/85 (drop `DIM-1: <summary>` line).
   - Edit `commands/review.md` (axiom:audit `Skill({...})` block) and `commands/ideate.md:34`.
   - Run `npm run build:skills` to regenerate all 6 runtime copies.

3. [REFACTOR] None expected.

**Files:** `skills-src/quality-review/SKILL.md`, `skills-src/brainstorming/SKILL.md`, `commands/review.md`, `commands/ideate.md`, deleted `axiom-integration.md`, + regenerated `skills/**`.
**Dependencies:** Task 2 (catalog DIM-* must be gone for vocabulary-lint to pass).
**Parallelizable:** No

---

### Task 4: Instruction rewrite, plan reconcile, historical docs, final grep sweep
**Phase:** RED → GREEN → REFACTOR
**Phases covered:** Design Phases 6, 7, 8.

1. [RED] Sweep-as-test:
   - Add `servers/exarchos-mcp/src/architecture/axiom-retirement.test.ts` — `WorkingTree_NoFunctionalAxiomRefs_GrepClean`: greps the working tree (excluding `.worktrees`, `dist`, `.git`, and the allow-listed historical dirs `docs/research/`, `docs/rca/`, `docs/contexts/`, and citation strings) for `axiom`, `axiom_overlap`, `axiomOverlap`, `axiom:audit`, `pluginStatus.axiom`. Asserts zero. Fails while residue remains.

2. [GREEN]
   - Rewrite `CLAUDE.md:55` → "Validate all designs against the invariants catalog (`docs/architecture/invariants.md`) / Aspire / roadmap conventions".
   - Re-scope `docs/plans/2026-05-24-invariants-dev-catalog-v3-content.md` to the 19-entry catalog (drop DIM-4/5/6/8 axiom acceptance criteria) so #1478 inherits a consistent target.
   - Drop the stale `axiom:scaffold-invariants → retired design-invariants` pointer.
   - Clear any remaining functional tokens surfaced by the sweep.

3. [REFACTOR] Confirm the allow-list in the sweep test matches the design's Phase-8 decision (historical record preserved).

**Files:** `CLAUDE.md`, `docs/plans/2026-05-24-invariants-dev-catalog-v3-content.md`, `axiom:scaffold-invariants` skill pointer, new `axiom-retirement.test.ts`.
**Dependencies:** Tasks 1, 2, 3.
**Parallelizable:** No (integration gate)

---

## Final acceptance gates (run on integration branch before synthesize)

- `cd servers/exarchos-mcp && npm run test:run` — green.
- root `npm run test:run` — green.
- `npm run typecheck` — clean (no dangling `axiom`/`axiomOverlap` types).
- `npm run build:skills && npm run skills:guard` — clean.
- `npm run lint:invariants` — clean (no orphaned DIM-* tokens).
- `exarchos_view { action: "invariants_effective", phase: "ideate", workflowType: "feature" }` — loads, 19 + SDLC entries, no DIM-*.
- Grep sweep (Task 4 test) — zero functional axiom references outside the allow-list.
