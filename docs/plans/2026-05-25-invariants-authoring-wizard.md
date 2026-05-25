# Implementation Plan — Invariants Authoring Wizard + dev-catalog migration

- **Design:** `docs/designs/2026-05-25-invariants-authoring-wizard.md`
- **Feature id:** `invariants-catalog-wizard`
- **Date:** 2026-05-25
- **Iron Law:** NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST. Every task is RED → GREEN → REFACTOR.

## Strategy

Four phases mapping to design §6. **P1 (migration refactor) ships first and is a pure refactor** — every existing gate/view/parity test must stay green — so the wizard (P2/P3) has a single registered-catalog path to target. All paths are under `servers/exarchos-mcp/src/`; run scoped tests with `cd servers/exarchos-mcp && npm run test:run`.

### Parallelization map

- **P1** is a sequential chain: T0 (characterization guard) → T1 → T2 → T3 → T4 → T5 (each builds on the prior signature change). T0 pins the legacy behavior the refactor must preserve.
- **P2** depends on P1 complete. T6/T7 (scaffold) and T8/T9/T10/T11 (add) are two parallel-safe sub-chains; T12 (parity) depends on both.
- **P3** depends on P2. T13/T14 author content (parallel), T15 (render+guard) depends on both.
- **P4** depends on P3. T16/T17/T18 are parallel-safe.

---

## Phase 1 — Registered-catalog refactor (migration)

### Task 0: Characterization guard — pin current dev-catalog behavior
**Phase:** RED → GREEN (characterization; no production change)
**File (impl):** none (behavior-pinning test only)
**File (test):** `architecture/resolve-effective-catalog.characterization.test.ts` (new)

Establishes the load-bearing safety net for the whole migration **before** any refactor commit: the effective catalog produced by today's `devCatalog: enabled` path is captured as the golden expectation that T3/T4 must preserve.

1. [RED] `resolveEffectiveCatalog_DevCatalogEnabled_GoldenSnapshot` — with `{ invariants: { devCatalog: 'enabled' } }` against the real repo `invariants.md`, snapshot the resolved INV-* entry ids + tags. Fails initially only because the snapshot does not exist.
2. [GREEN] Commit the captured snapshot — this is now the invariant T3/T4 must not break.
3. [REFACTOR] None. (Later, T16.1 asserts the *desugared explicit registration* resolves to this same golden snapshot.)

**Dependencies:** None — runs first, before T1.
**Parallelizable:** No (foundation guard)
**testingStrategy:** characterization; propertyTests: no; benchmarks: no

### Task 1: `catalogs` accepts `{ path, tier }` registration objects
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `config/exarchos-config-schema.ts`
**File (test):** `config/exarchos-config-schema.test.ts`

1. [RED] `InvariantsConfigSchema_CatalogObject_ParsesPathAndTier` — assert `catalogs` accepts `[{ path: 'x.yml', tier: 'dev' }]` and a bare `'x.yml'` string in the same array.
   - Expected failure: current schema is `z.array(z.string())`; object element rejected.
2. [RED] `InvariantsConfigSchema_CatalogTier_RejectsUnknownTier` — `tier: 'bogus'` fails; valid tiers are `dev | user`.
3. [GREEN] Change `catalogs` to `z.array(z.union([z.string(), z.object({ path: z.string(), tier: z.enum(['dev','user']).optional() }).strict()]))`.
4. [REFACTOR] Export a `CatalogRegistration` type alias.

**Dependencies:** None
**Parallelizable:** No (foundation)
**testingStrategy:** unit; propertyTests: no; benchmarks: no

### Task 2: Normalize registrations + desugar `devCatalog`
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `architecture/catalog-sources.ts` (new)
**File (test):** `architecture/catalog-sources.test.ts` (new)

1. [RED] `resolveCatalogSources_BareString_DefaultsUserTier` — a `'x.yml'` entry normalizes to `{ path: 'x.yml', tier: 'user' }`.
   - Expected failure: module does not exist.
2. [RED] `resolveCatalogSources_DevCatalogEnabled_RegistersDevSource` — `{ devCatalog: 'enabled' }` (no explicit dev entry) yields a `{ path: 'docs/architecture/invariants.md', tier: 'dev' }` source.
3. [RED] `resolveCatalogSources_DevCatalogDisabled_OmitsDevSource` — disabled/absent yields no dev source.
4. [RED] `resolveCatalogSources_NoDuplicateDevSource` — `devCatalog: enabled` AND an explicit `{ path: invariants.md, tier: dev }` produce exactly one dev source.
5. [GREEN] Implement `resolveCatalogSources(config): CatalogSource[]` (`{ path, tier }`).
6. [REFACTOR] Document the desugaring contract in the module header.

**Dependencies:** T1
**Parallelizable:** No
**testingStrategy:** unit; propertyTests: no; benchmarks: no

### Task 3: `resolveEffectiveCatalog` iterates registered sources (collapse Layers 1+3)
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `architecture/resolve-effective-catalog.ts`
**File (test):** `architecture/resolve-effective-catalog.test.ts`

1. [RED] `resolveEffectiveCatalog_DevViaRegistration_LoadsDevLayer` — with a `tier:dev` source registered, INV-* entries appear in the dev layer (no hardcoded-path branch).
   - Expected failure: resolver still keys the dev layer off the hardcoded path + `devCatalog` boolean only.
2. [RED] `resolveEffectiveCatalog_MissingDevSource_DegradesWithWarning` — a registered dev source whose file is missing produces a load warning, not a throw (parity with the existing user-catalog DR-9 behavior).
3. [RED] `resolveEffectiveCatalog_SdlcLayer_Unaffected` — sdlc inline layer still present and unchanged.
4. [GREEN] Replace the bespoke Layer-1 block with a loop over `resolveCatalogSources(config)`; load each file source via `loadInvariants`, tag by `tier`; keep `loadSdlcCatalog()` as Layer 2.
5. [REFACTOR] Fold dev + user degradation into the single `loadWarnings` path; delete the now-dead hardcoded `devCatalogPath` branch.

**Dependencies:** T2
**Parallelizable:** No
**testingStrategy:** unit; propertyTests: no; benchmarks: no

### Task 4: Reserved-namespace check keyed off source tier
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `architecture/catalog-merge.ts`
**File (test):** `architecture/catalog-merge.test.ts`

1. [RED] `mergeCatalogs_InvIdInDevTier_Accepted` — an `INV-*` id carried by a `tier:dev`-tagged entry merges without `ReservedNamespaceError`.
2. [RED] `mergeCatalogs_InvIdInUserTier_Rejected` — `INV-*`/`SDLC-*` in a user-tier entry still throws `ReservedNamespaceError`.
3. [RED] `mergeCatalogs_SdlcId_ReservedOutsideBuiltin` — `SDLC-*` in any non-builtin source rejected.
4. [GREEN] Thread each entry's source `tier` into `mergeCatalogs`; gate `isReservedUserId` on tier (allow `INV-*` only for `dev`, `SDLC-*` only for the inline sdlc layer).
5. [REFACTOR] Update the function/JSDoc to describe tier-keyed reservation.

**Dependencies:** T3
**Parallelizable:** No
**testingStrategy:** unit; propertyTests: no; benchmarks: no

### Task 5: `doctor` advisory for non-builtin source claiming reserved namespace
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `orchestrate/doctor/` (the `invariants-catalog` check)
**File (test):** `orchestrate/doctor/*.test.ts`

1. [RED] `DoctorInvariantsCatalog_UserSourceReservedId_EmitsAdvisory` — a user-tier catalog with an `INV-*` id surfaces a named advisory (not a crash).
   - Expected failure: check does not yet inspect tier-keyed reservation.
2. [GREEN] Catch `ReservedNamespaceError` in the check and emit a Warning naming the offending file + id.
3. [REFACTOR] Share the message string with `mergeCatalogs`' error text.

**Dependencies:** T4
**Parallelizable:** No
**testingStrategy:** unit; propertyTests: no; benchmarks: no

---

## Phase 2 — Authoring verbs

### Task 6: `invariants_scaffold` handler — create starter file, idempotent
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `orchestrate/invariants/scaffold.ts` (new)
**File (test):** `orchestrate/invariants/scaffold.test.ts` (new)

1. [RED] `handleScaffold_NewCatalog_WritesStarterFile` — writes a v3-shaped starter catalog at the target path with a worked-example commented entry.
2. [RED] `handleScaffold_ExistingFile_NoOverwrite` — returns `reason: 'already-exists'`, does not write (mirror `seedExarchosConfig`).
3. [RED] `handleScaffold_RegistersInExarchosYml` — appends `{ path, tier }` to `invariants.catalogs` when absent; idempotent when present.
4. [GREEN] Implement `handleScaffold(args, deps)` with injected fs hooks.
5. [REFACTOR] Reuse the `.exarchos.yml` read/append helper with T10.

**Dependencies:** P1 complete
**Parallelizable:** Yes (with T8 chain)
**testingStrategy:** unit; propertyTests: no; benchmarks: no

### Task 7: Register `invariants_scaffold` action + dispatch
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `registry.ts`, `orchestrate/composite.ts`
**File (test):** `orchestrate/composite.test.ts`, `registry.test.ts`

1. [RED] `Composite_InvariantsScaffold_Dispatches` — dispatching `action: 'invariants_scaffold'` reaches `handleScaffold`.
2. [RED] `Registry_InvariantsScaffold_HasOutputSchemaAndAnnotations` — action declares `EnvelopeSchema`, `LOCAL_MUTATION` annotations, and a `when-NOT-to-use` clause in its description (INV-5a).
3. [GREEN] Add the registry entry (schema: `{ tier?, path?, repoRoot? }`) + wire dispatch; do **not** add a 5th visible tool (INV-5d).
4. [REFACTOR] Ensure CLI flags auto-emit from the Zod schema (no hand-added flags).

**Dependencies:** T6
**Parallelizable:** No (after T6)
**testingStrategy:** unit; propertyTests: no; benchmarks: no

### Task 8: `invariants_add` — validate entry, dry-run default
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `orchestrate/invariants/add.ts` (new)
**File (test):** `orchestrate/invariants/add.test.ts` (new)

1. [RED] `handleAdd_ValidEntry_DryRunReturnsRenderedDiff` — `--dry-run` (default) returns the rendered YAML entry + file diff and writes nothing.
2. [RED] `handleAdd_CheckModeWithExecField_Rejected` — a `mode: check` entry carrying an embedded `script`/`exec` key fails via the `.strict()` enforcement DSL (INV-4); error carries `expectedShape`/`suggestedFix`.
3. [RED] `handleAdd_UnknownLeafKind_Rejected` — `kind: 'shell'` rejected at validation (`UnknownCheckKindError`).
4. [GREEN] Implement validation through `InvariantEntryV3Schema`; render via `yaml.stringify`; dry-run returns without writing.
5. [REFACTOR] Map ZodError → `{ validTargets, expectedShape, suggestedFix }` envelope (INV-5b).

**Dependencies:** P1 complete
**Parallelizable:** Yes (with T6 chain)
**testingStrategy:** unit; propertyTests: no; benchmarks: no

### Task 9: `invariants_add` write path + id auto-assignment
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `orchestrate/invariants/add.ts`
**File (test):** `orchestrate/invariants/add.test.ts`

1. [RED] `handleAdd_Commit_AppendsEntryToCatalog` — with `dryRun:false`, appends the entry to the target catalog's `invariants:` list.
2. [RED] `handleAdd_AutoId_NextFreeInNamespace` — auto-assigns `U-3` when `U-1`,`U-2` exist (and `INV-N` for a dev-tier target).
3. [GREEN] Implement append + namespace-aware id allocation (scan existing ids).
4. [REFACTOR] Extract id-allocator into a tested pure helper.

**Dependencies:** T8
**Parallelizable:** No
**testingStrategy:** unit; propertyTests: no; benchmarks: no

### Task 10: `invariants_add` wires `.exarchos.yml` if catalog unregistered
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `orchestrate/invariants/exarchos-yml-writer.ts` (new, shared with T6)
**File (test):** `orchestrate/invariants/exarchos-yml-writer.test.ts` (new)

1. [RED] `WireCatalog_UnregisteredPath_AppendsRegistration` — adds `{ path, tier }` to `invariants.catalogs`.
2. [RED] `WireCatalog_AlreadyRegistered_NoChange` — idempotent.
3. [RED] `WireCatalog_PreservesComments` — does not clobber the seeded onboarding comment stanza (round-trip-safe edit).
4. [GREEN] Implement comment-preserving append (use `yaml` `Document` API).
5. [REFACTOR] Have T6 scaffold reuse this writer.

**Dependencies:** T8 (writer consumed by T6 + T9)
**Parallelizable:** No
**testingStrategy:** unit; propertyTests: no; benchmarks: no

### Task 11: Register `invariants_add` action + event emission
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `registry.ts`, `orchestrate/composite.ts`
**File (test):** `orchestrate/composite.test.ts`, `check-event-emissions.test.ts`

1. [RED] `Composite_InvariantsAdd_EmitsInvariantAuthored` — committing emits `invariant.authored`; first registration of a catalog emits `catalog.registered` (INV-1).
2. [RED] `Registry_InvariantsAdd_DryRunDefault` — schema defaults `dryRun` true (INV-5c).
3. [GREEN] Register the action (context-needing → explicit dispatch branch like `init`); declare `autoEmits`.
4. [REFACTOR] Confirm `next_actions` includes `doctor` + `view invariants_effective` (INV-12).

**Dependencies:** T9, T10
**Parallelizable:** No
**testingStrategy:** unit; propertyTests: no; benchmarks: no

### Task 12: Facade parity — CLI ⟷ MCP byte-identical
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `adapters/cli.ts` (only if flag wiring needs it)
**File (test):** `orchestrate/invariants/parity.test.ts` (new)

1. [RED] `InvariantsScaffold_Parity_CliEqualsMcp` — CLI `--json` payload byte-identical to the MCP `structuredContent` (INV-2).
2. [RED] `InvariantsAdd_Parity_CliEqualsMcp` — same for `invariants_add`.
3. [GREEN] Fix any divergence (likely none if flags auto-emit from schema).
4. [REFACTOR] Fold into the existing parity-suite harness.

**Dependencies:** T7, T11
**Parallelizable:** No
**testingStrategy:** unit; propertyTests: no; benchmarks: no

---

## Phase 3 — Skill + command

### Task 13: `authoring-invariants` skill (the interview)
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `skills-src/authoring-invariants/SKILL.md` (new) + `references/`
**File (test):** N/A (content); validated by skills:guard + vocabulary lint

1. [RED] Run `npm run build:skills` — fails the vocabulary pre-flight / guard until the skill is well-formed (frontmatter `name`, `description`, `metadata.mcp-server: exarchos`).
2. [GREEN] Author SKILL.md encoding the 6-step interview (elicit → locate → weight → enforce → number → commit), audit-first with `check` opt-in; all mutations go through `invariants_add --dry-run` then confirm.
3. [REFACTOR] Add `references/worked-example.md` (one `U-*` entry authored end-to-end).

**Dependencies:** P2 complete
**Parallelizable:** Yes (with T14)
**testingStrategy:** content-lint; propertyTests: no; benchmarks: no

### Task 14: `/exarchos:invariants` command
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `commands/invariants.md` (new)
**File (test):** command-validation test if present

1. [RED] Command-frontmatter validator fails until `commands/invariants.md` exists with required frontmatter.
2. [GREEN] Author the thin command that invokes the `authoring-invariants` skill.
3. [REFACTOR] Cross-link the authoring guide.

**Dependencies:** P2 complete
**Parallelizable:** Yes (with T13)
**testingStrategy:** content-lint; propertyTests: no; benchmarks: no

### Task 15: Render skills + `skills:guard` green
**Phase:** RED → GREEN → REFACTOR
**File (impl):** generated `skills/<runtime>/authoring-invariants/**`

1. [RED] `npm run skills:guard` fails (generated tree out of sync).
2. [GREEN] `npm run build:skills`; commit source + regenerated tree.
3. [REFACTOR] Confirm `git diff skills/` clean.

**Dependencies:** T13, T14
**Parallelizable:** No
**testingStrategy:** ci-guard; propertyTests: no; benchmarks: no

---

## Phase 4 — Dogfood + docs

### Task 16: Migrate this repo's `.exarchos.yml` (dogfood)
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `.exarchos.yml`
**File (test):** `architecture/resolve-effective-catalog.test.ts` (repo-config fixture)

1. [RED] `RepoConfig_DesugaredDevSource_MatchesGoldenSnapshot` — assert the effective catalog from an explicit `{ path: invariants.md, tier: dev }` registration equals **the T0 golden snapshot** (and equals the `devCatalog: enabled` path). This closes the loop: T0 pinned the legacy behavior; this proves the desugared/explicit form is identical.
2. [GREEN] Keep `devCatalog: enabled` (back-compat sugar verified) OR switch to explicit registration — chosen per the test outcome.
3. [REFACTOR] Update the `.exarchos.yml` header comment to reference the registered-catalog pattern.

**Dependencies:** T0 (golden snapshot), P1 complete (placed last to avoid churn)
**Parallelizable:** Yes
**testingStrategy:** unit; propertyTests: no; benchmarks: no

### Task 17: Update `authoring-invariants.md` to lead with the wizard
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `docs/guides/authoring-invariants.md`

1. [RED] N/A (docs) — covered by humanize/markdown lint if wired.
2. [GREEN] Add a "Quickstart: the wizard" section pointing at `/exarchos:invariants` + the new verbs; demote hand-authoring to "advanced/manual."
3. [REFACTOR] Link the design + plan.

**Dependencies:** T13
**Parallelizable:** Yes
**testingStrategy:** content-lint; propertyTests: no; benchmarks: no

### Task 18: `check`-mode opt-in guidance in the skill
**Phase:** RED → GREEN → REFACTOR
**File (impl):** `skills-src/authoring-invariants/references/check-mode.md` (new)

1. [RED] skills:guard fails until reference rendered.
2. [GREEN] Document the combinator-tree opt-in flow: agent proposes tree → validate via `invariants_add --dry-run` → confirm. Reinforce INV-4 (no exec).
3. [REFACTOR] Render + guard green.

**Dependencies:** T13, T15
**Parallelizable:** Yes
**testingStrategy:** content-lint; propertyTests: no; benchmarks: no

---

## Verification gates (post-implementation)

- `check_tdd_compliance` per task branch (RED-before-GREEN in git history).
- `npm run test:run` (root + `servers/exarchos-mcp`), `npm run typecheck`, `npm run skills:guard`.
- `check_invariant_conformance` at review — the dev catalog (now a registered source) must still resolve and gate this very PR (dogfood proof).
- Facade parity suite (T12) green.

## Deferred / explicit non-goals (design §2, §7)

- No SDLC-* re-homing (stays inline).
- No consumer authoring of SDLC-* content.
- Hard replacement of the `devCatalog` flag is **not** chosen — desugaring keeps back-compat (design §4.3).
