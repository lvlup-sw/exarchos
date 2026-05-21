# Implementation Plan — Invariants Catalog v2 (dev-invariants scope)

> **Design:** `docs/proposals/2026-05-20-invariants-catalog-v2-spec.md` (D5 from discover `workload-agnostic-runtime-invariants`)
> **Date:** 2026-05-20
> **Integration branch:** `feature/invariants-catalog-v2-implementation`
> **Closes:** v2 catalog migration axis under epic #1441
> **Iron Law:** No production code without a failing test first. Markdown research artifacts in Wave A are exempt (no executable surface); markdown catalog edits in Wave C are paired with `invariants-loader.test.ts` extensions per D5 §7.8.

---

## Wave map

| Wave | Tasks | Parallelizable | Notes |
|---|---|---|---|
| **A** (research closure) | A1, A2 | A1 ∥ A2 | Advisory; closes D5 open questions before code touches |
| **B** (gating mechanism) | B1, B2, B3 | B1 → B2 → B3 | Ships first; default-disabled gating must precede catalog-shape changes |
| **C** (catalog edits) | C1..C14 | mixed | Schema bump sequential; entry-add tasks parallel within sub-groups |
| **D** (loader scope filter) | D1, D2 | D1 → D2 | Sequential — both extend `invariants-loader.ts` |
| **E** (axiom:design pairing) | E1, E2 | E1 ∥ E2 | Independent files |
| **F** (Phase 0 directive + verification) | F1, F2 | F1 → F2 | F1 edits `commands/ideate.md`; F2 is manual smoketest |

**Dependency edges:**
- Wave A produces audit-final entries that Wave C consumes.
- Wave B must land before Wave C — gating is the safety boundary that lets v2 ship default-disabled.
- Wave C cannot start before Wave B lands (catalog with v2 schema entries would degrade Phase 0 if loaded without gating).
- Wave D extends the gated loader from Wave B — must follow Wave B.
- Wave E extends `axiom_overlap` field added in Wave C — must follow Wave C.
- Wave F's directive update needs Wave D's `scope: 'core'` filter — must follow Wave D.

**Total tasks: 23.**

---

## Wave A — Research closure

Branch: `feature/invariants-catalog-v2-implementation` (integration)

### Task A1: Backfill INV-9 with Harel statecharts citation

**Closes:** D5 §6 open question (INV-9 under-cited)
**Phase:** RESEARCH (no TDD — markdown research closure)

1. **[RESEARCH]** Web-fetch Harel 1987 *"Statecharts: A Visual Formalism for Complex Systems"* (Science of Computer Programming) abstract + intro. Confirm canonical citation: `Harel, D. (1987). Statecharts: A visual formalism for complex systems. Science of Computer Programming, 8(3), 231–274. https://doi.org/10.1016/0167-6423(87)90035-9`
2. **[EDIT]** Update `docs/proposals/2026-05-20-invariants-catalog-v2-spec.md` INV-9 entry — replace the Greg Young + Wolverine thin citations with: Harel 1987 (primary), Greg Young versioning (secondary), Wolverine [AggregateHandler] (tertiary). Confirm ≥3 citations.
3. **[VERIFY]** Reviewer confirms INV-9 entry has ≥3 distinct citations spanning academic primary source + industry implementation.

**Dependencies:** None
**Parallelizable:** With A2

---

### Task A2: Commit INV-14 disposition decision

**Closes:** D5 §6 open question (INV-14 catalog-vs-skill-body)
**Phase:** RESEARCH (no TDD — markdown decision closure)

1. **[RESEARCH]** Re-read D5 §6 INV-14 open question. Confirm recommendation: ship as v2 catalog entry initially (option A), demote to skill body if rarely cited after one release cycle.
2. **[EDIT]** Update `docs/proposals/2026-05-20-invariants-catalog-v2-spec.md` INV-14 entry — remove the "Open question" framing block; replace with a decision-recorded note ("Ships as catalog entry per discover recommendation; demotion criterion is `< 1 cross-reference per release after one release cycle`"). Leave citations as-is (ARIES CLR analog, Greg Young Bad Parts, git docs).
3. **[VERIFY]** Reviewer confirms INV-14 no longer reads as "open question."

**Dependencies:** None
**Parallelizable:** With A1

---

## Wave B — `.exarchos.yml` gating mechanism

Branch: `task/invariants-v2-b1-config-schema` → `task/invariants-v2-b2-loader-gating` → `task/invariants-v2-b3-config-docs`

### Task B1: Extend `ExarchosConfig` with `invariants.devCatalog` flag

**Closes:** D5 §7.0 step 1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `ExarchosConfig_AcceptsInvariantsDevCatalogFlag_PreservesEnumValues`
   - File: `servers/exarchos-mcp/src/config/config.test.ts` (extend) or `servers/exarchos-mcp/src/architecture/invariants-config.test.ts` (new co-located)
   - Asserts:
     - `parseExarchosConfig({ invariants: { devCatalog: 'enabled' } })` returns config with the flag preserved
     - `parseExarchosConfig({ invariants: { devCatalog: 'disabled' } })` likewise
     - `parseExarchosConfig({ invariants: { devCatalog: 'invalid' } })` throws / rejects per existing config validation pattern
     - `parseExarchosConfig({})` returns config with `invariants?.devCatalog` undefined (default-disabled semantics)
   - Expected failure: `ExarchosConfig` type does not yet include `invariants.devCatalog`

2. **[GREEN]** Extend the config type/schema in `servers/exarchos-mcp/src/config/config.ts` (or wherever `ExarchosConfig` is currently defined — likely `src/config/`). Add:
   ```ts
   invariants?: {
     devCatalog?: 'enabled' | 'disabled';
   };
   ```
   Update the corresponding Zod schema. No default value in the type (undefined === disabled by loader convention).

3. **[REFACTOR]** Co-locate the new sub-type with related config fields; one-line JSDoc.

**Dependencies:** None (independent from Wave A)
**Parallelizable:** No (single config file)

---

### Task B2: Gate `loadInvariants` on `devCatalog: enabled`

**Closes:** D5 §4.0 + §7.0 steps 2-3
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `LoadInvariants_WhenDevCatalogDisabled_ReturnsEmpty`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts:
     - `loadInvariants(doc, opts, { invariants: { devCatalog: 'disabled' } })` returns `[]` regardless of `opts.scope`
     - `loadInvariants(doc, opts, {})` (no invariants config) returns `[]` (default-disabled)
     - `loadInvariants(doc, opts, { invariants: {} })` (empty invariants subkey) returns `[]`
   - Companion test: `LoadInvariants_WhenDevCatalogEnabled_ReturnsEntriesPerScope`
     - Asserts: `loadInvariants(doc, { scope: 'all' }, { invariants: { devCatalog: 'enabled' } })` returns the full entry list
   - Expected failure: `loadInvariants` does not yet consult config; ignores the third argument

2. **[GREEN]** Extend `loadInvariants` signature in `servers/exarchos-mcp/src/architecture/invariants-loader.ts`:
   ```ts
   function loadInvariants(
     doc: InvariantsDoc,
     opts: { scope?: Scope } = {},
     config: ExarchosConfig = readConfig()
   ): InvariantEntry[] {
     if (config.invariants?.devCatalog !== 'enabled') {
       return [];
     }
     // ... existing scope filter logic
   }
   ```
   - Use `readConfig()` as the default for backwards compatibility with existing call sites.
   - The third argument is dependency-injectable for tests.

3. **[REFACTOR]** Co-locate the gating check; one-line JSDoc on `loadInvariants` documenting the gating behavior.

**Dependencies:** B1 (needs `ExarchosConfig.invariants.devCatalog` type)
**Parallelizable:** No (single loader file)

---

### Task B3: Document `.exarchos.yml` flag

**Closes:** D5 §7.0 step 4
**Phase:** EDIT (no TDD — documentation only)

1. **[EDIT]** Update `docs/configuration/exarchos-yml.md` (or wherever the canonical `.exarchos.yml` reference lives — find via `grep -rn ".exarchos.yml" docs/` if uncertain) with the new `invariants.devCatalog` section:
   - Field name, type (enum), default (`disabled`)
   - When to enable (working on Exarchos itself)
   - When to leave disabled (using Exarchos as a plugin in another project)
   - Cross-reference to `docs/proposals/2026-05-20-invariants-catalog-v2-spec.md` §1.1

2. **[EDIT]** Add `invariants.devCatalog: enabled` to the Exarchos repo's own `.exarchos.yml` (root of repo). This is the explicit-opt-in that lets contributors and internal consumers (eval #1442, vocabulary lint) see the catalog when working inside the repo.

3. **[VERIFY]** Manual: `grep -rn "devCatalog" .` shows three locations — config schema, loader code, root `.exarchos.yml`.

**Dependencies:** B2 (loader uses the flag)
**Parallelizable:** No (sequential after B2)

---

## Wave C — Catalog edits

Branch: `task/invariants-v2-cN-<topic>` per sub-task; merge into integration after each.

### Task C1: Bump schema-version + add `axis:` field to every entry

**Closes:** D5 §3 schema + §7.1 + §7.2 (partial)
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `Invariants_AfterSchemaV2Bump_EveryEntryHasAxisField`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts:
     - `doc.schemaVersion === 2`
     - Every entry has `entry.axis` matching one of `'substrate' | 'authoring'`
     - Schema rejects entries without `axis`
   - Expected failure: schemaVersion is 1; entries lack `axis` field

2. **[GREEN]** Edit `docs/architecture/invariants.md`:
   - Change frontmatter `schema-version: 1` → `schema-version: 2`
   - Add `axis: substrate` to all 17 existing substrate entries (INV-1..INV-6 + DIM-1..7 + basileus-boundary)
   - Add `axis: authoring` to DIM-8
   - Update loader type `InvariantEntry` to include `axis: 'substrate' | 'authoring'`
   - Update loader Zod schema for the entry shape

3. **[REFACTOR]** Confirm no consumer breakage: `npm run skills:guard`, `npm test -- invariants-loader`.

**Dependencies:** B3 (gating must be in place before catalog v2 surfaces enter the loader's universe)
**Parallelizable:** No

---

### Task C2: Add `citations:` field to substrate entries

**Closes:** D5 §3 schema + §7.2 (partial)
**Phase:** RED → GREEN

1. **[RED]** Write test: `Invariants_SubstrateAxisEntries_AcceptCitationsField`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts: `InvariantEntry` type accepts optional `citations: string[]`; loader parses it without error.
   - Note: per D5 §3 the *recommendation* is ≥3 citations for substrate entries, but this is enforced via soft assertion in C4..C11 (per-entry tests), not as a schema-level rule (DIM-* axiom-pointer entries are exempt).

2. **[GREEN]** Extend `InvariantEntry` type with `citations?: string[]`. Update Zod schema.

**Dependencies:** C1
**Parallelizable:** With C3

---

### Task C3: Add `axiom_overlap:` field to applicable entries

**Closes:** D5 §3 schema + Wave E preparation
**Phase:** RED → GREEN

1. **[RED]** Write test: `Invariants_SubstrateAxisEntries_AcceptAxiomOverlapField`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts: `InvariantEntry.axiomOverlap?: string` (matching `/^DIM-\d+$/` pattern); references an existing DIM-N entry.
   - Companion test: `Invariants_DeclaredAxiomOverlaps_ReferenceExistingDimensionEntries` — every declared `axiom_overlap: DIM-N` must match an existing entry's `id`.

2. **[GREEN]** Extend `InvariantEntry` type with `axiomOverlap?: string`. Update Zod schema with regex validation.

**Dependencies:** C1
**Parallelizable:** With C2

---

### Task C4: Split INV-1 → INV-1 (narrowed) + INV-7 + INV-8

**Closes:** D5 §5.1 + §6 (INV-7, INV-8 entries) + §7.2 (partial)
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `Invariants_INV1Split_ProducesINV1NarrowedPlusINV7PlusINV8`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts:
     - `INV-1` exists; its summary no longer contains substrate-serialization or idempotency claims
     - `INV-7` exists with `dimension: 'substrate-serialization'`, `axis: 'substrate'`, `cost-of-load: 'always-load'`, ≥3 citations including ARIES + Bernstein/Goodman
     - `INV-8` exists with `dimension: 'idempotency-at-the-boundary'`, `axis: 'substrate'`, `cost-of-load: 'always-load'`, ≥3 citations including Akka + Wolverine + Greg Young
   - Update `REQUIRED_INVARIANT_IDS` constant to include 'INV-7', 'INV-8'.

2. **[GREEN]** Edit `docs/architecture/invariants.md`:
   - Narrow INV-1 summary to "events as design authority + reducer purity" only (remove substrate-mechanism prose, remove idempotency prose); update `applies-to` to drop `event-store-internals` if present
   - Add INV-7 entry (verbatim from D5 §6 INV-7)
   - Add INV-8 entry (verbatim from D5 §6 INV-8)

3. **[REFACTOR]** Update loader test fixture if any tests reference INV-1's old summary text.

**Dependencies:** C1, C2, C3
**Parallelizable:** With C5

---

### Task C5: Split INV-5b → INV-5b (narrowed) + INV-12

**Closes:** D5 §5.1 + §6 (INV-12 entry) + §7.2 (partial)
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `Invariants_INV5bSplit_ProducesINV5bNarrowedPlusINV12`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts:
     - `INV-5b` exists; summary scoped to carrier-shape (next_actions field presence, _meta, _perf, error envelope shape)
     - `INV-12` exists with `dimension: 'next-actions-as-affordance'`, `axis: 'substrate'`, `cost-of-load: 'always-load'`, ≥3 citations including Norman 1999 + McGrenere/Ho 2000
   - Update `REQUIRED_INVARIANT_IDS` to include 'INV-12'.

2. **[GREEN]** Edit `docs/architecture/invariants.md`:
   - Narrow INV-5b summary (drop affordance-consumption prose; keep carrier-shape rules)
   - Add INV-12 entry (verbatim from D5 §6 INV-12)

3. **[REFACTOR]** Update INV-5b's `applies-to` to drop consumption-side surfaces if present.

**Dependencies:** C1, C2, C3
**Parallelizable:** With C4

---

### Task C6: Add INV-9 hsm-as-state-machine

**Closes:** D5 §5.2 + §6 (INV-9 entry)
**Phase:** RED → GREEN

1. **[RED]** Write test: `Invariants_INV9_ExistsWithHSMScope`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts: `INV-9` exists with `dimension: 'hsm-as-state-machine'`, `axis: 'substrate'`, `cost-of-load: 'reference-only'`, citations including Harel 1987 (post-A1 backfill).
   - Update `REQUIRED_INVARIANT_IDS` to include 'INV-9'.

2. **[GREEN]** Edit `docs/architecture/invariants.md` — add INV-9 entry per D5 §6 INV-9 (with A1's Harel citation backfill applied).

**Dependencies:** A1, C1, C2, C3
**Parallelizable:** With C7..C11 (each new entry is independent)

---

### Task C7: Add INV-10 liveness-event-protocol

**Closes:** D5 §5.2 + §6 (INV-10 entry)
**Phase:** RED → GREEN

1. **[RED]** Write test: `Invariants_INV10_ExistsWithLivenessProtocolScope`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts: `INV-10` exists with `dimension: 'liveness-event-protocol'`, `axis: 'substrate'`, `cost-of-load: 'reference-only'`, citations.
   - Update `REQUIRED_INVARIANT_IDS`.

2. **[GREEN]** Edit `docs/architecture/invariants.md` — add INV-10 entry per D5 §6 INV-10.

**Dependencies:** C1, C2, C3
**Parallelizable:** With C6, C8..C11

---

### Task C8: Add INV-11 posture-declared-capabilities

**Closes:** D5 §5.1 + §6 (INV-11 entry)
**Phase:** RED → GREEN

1. **[RED]** Write test: `Invariants_INV11_ExistsWithPostureScope`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts: `INV-11` exists with `dimension: 'posture-declared-capabilities'`, `axis: 'substrate'`, `cost-of-load: 'always-load'`, ≥4 citations including Miller *Robust Composition* + POLA + anip-protocol.
   - Update `REQUIRED_INVARIANT_IDS`.

2. **[GREEN]** Edit `docs/architecture/invariants.md` — add INV-11 entry per D5 §6 INV-11.

**Dependencies:** C1, C2, C3
**Parallelizable:** With C6, C7, C9..C11

---

### Task C9: Add INV-13 process-manager-two-event-split

**Closes:** D5 §5.2 + §6 (INV-13 entry)
**Phase:** RED → GREEN

1. **[RED]** Write test: `Invariants_INV13_ExistsWithProcessManagerScope`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts: `INV-13` exists with `dimension: 'process-manager-two-event-split'`, `axis: 'substrate'`, `cost-of-load: 'reference-only'`, ≥3 citations including Akka + Wolverine + Greg Young.
   - Update `REQUIRED_INVARIANT_IDS`.

2. **[GREEN]** Edit `docs/architecture/invariants.md` — add INV-13 entry per D5 §6 INV-13.

**Dependencies:** C1, C2, C3
**Parallelizable:** With C6..C8, C10, C11

---

### Task C10: Add INV-14 native-primitive-first-recovery

**Closes:** D5 §5.2 + §6 (INV-14 entry, A2 disposition applied)
**Phase:** RED → GREEN

1. **[RED]** Write test: `Invariants_INV14_ExistsWithRecoveryPostureScope`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts: `INV-14` exists with `dimension: 'native-primitive-first-recovery'`, `axis: 'substrate'`, `cost-of-load: 'reference-only'`.
   - Update `REQUIRED_INVARIANT_IDS`.

2. **[GREEN]** Edit `docs/architecture/invariants.md` — add INV-14 entry per D5 §6 INV-14 (post-A2 disposition: shipped as catalog entry, not skill body).

**Dependencies:** A2, C1, C2, C3
**Parallelizable:** With C6..C9, C11

---

### Task C11: Add INV-15 single-machine-frame

**Closes:** D5 §5.1 + §6 (INV-15 entry)
**Phase:** RED → GREEN

1. **[RED]** Write test: `Invariants_INV15_ExistsWithSingleMachineFrameScope`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts: `INV-15` exists with `dimension: 'single-machine-frame'`, `axis: 'substrate'`, `cost-of-load: 'always-load'`, citations including Microsoft SAS + Saga + Clemens Vasters.
   - Update `REQUIRED_INVARIANT_IDS`.

2. **[GREEN]** Edit `docs/architecture/invariants.md` — add INV-15 entry per D5 §6 INV-15.

**Dependencies:** C1, C2, C3
**Parallelizable:** With C6..C10

---

### Task C12: Sharpen INV-6 to primary workload-agnosticism statement

**Closes:** D5 §5.1 + §6 (INV-6 sharpening)
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `Invariants_INV6Sharpened_PrimaryStatementNotGrepOnly`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts:
     - INV-6's `cost-of-load === 'always-load'` (was reference-only in v1)
     - INV-6 summary contains "no assumption about which workload" or equivalent primary-statement language
     - INV-6 summary still references `scripts/lint-inv6.mjs` as the operational projection
     - INV-6 `applies-to` includes `runtime-substrate` and `topology` (broader than v1's skills-src + playbooks)
   - Expected failure: v1 INV-6 is reference-only with grep-scoped summary.

2. **[GREEN]** Edit `docs/architecture/invariants.md` INV-6 entry per D5 §6 INV-6 (verbatim).

3. **[REFACTOR]** Also update `.claude/skills/design-invariants/references/INV-6-workflow-agnosticism.md` to reflect the elevated statement (the operational projection file should not contradict the catalog).

**Dependencies:** C1
**Parallelizable:** With C13, C14

---

### Task C13: Sharpen INV-1 wording post-split

**Closes:** D5 §5.1 (post-split scope narrowing)
**Phase:** EDIT (no new test — C4 already asserts the narrowing)

1. **[EDIT]** Confirm INV-1's narrowed summary (set by C4) reads coherently as a standalone entry. Sharpen prose if needed; ensure `applies-to` is tight (`event-store`, `projections`, `reducers`, `workflow-state-projection`).
2. **[VERIFY]** `npm test -- invariants-loader` clean.

**Dependencies:** C4
**Parallelizable:** With C12, C14

---

### Task C14: Clarify INV-4 platform-axis vs INV-6 workload-axis

**Closes:** D5 §5.1 (INV-4 sharpening)
**Phase:** EDIT (no new test — prose only)

1. **[EDIT]** Edit `docs/architecture/invariants.md` INV-4 — add a clarifying sentence: "INV-4 owns the *platform* axis (6 runtimes); INV-6 owns the orthogonal *workload* axis (workflow types)." Update `applies-to` if needed.
2. **[VERIFY]** `npm test -- invariants-loader` clean; no regression in INV-4 references.

**Dependencies:** C1, C12 (INV-6 must be sharpened before INV-4 can reference it)
**Parallelizable:** No (sequential after C12)

---

## Wave D — Loader scope filter

Branch: `task/invariants-v2-dN-loader-scope`

### Task D1: Add `scope: 'core' | 'substrate' | 'authoring' | 'all'` filter

**Closes:** D5 §4.1 + §4.2 + §7.4
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `LoadInvariants_WithScopeCore_ReturnsSubstrateAndAlwaysLoad`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts (with `devCatalog: 'enabled'`):
     - `loadInvariants(doc, { scope: 'core' })` returns entries where `axis === 'substrate' AND cost-of-load === 'always-load'`
     - `loadInvariants(doc, { scope: 'substrate' })` returns all `axis === 'substrate'`
     - `loadInvariants(doc, { scope: 'authoring' })` returns all `axis === 'authoring'` (= DIM-8 only)
     - `loadInvariants(doc, { scope: 'all' })` returns the full set
     - `loadInvariants(doc)` (no scope) defaults to `'all'` for backwards compat
   - Expected failure: existing scope filter only supports `'core' | 'all'`; doesn't intersect with axis.

2. **[GREEN]** Update `Scope` type union to `'core' | 'substrate' | 'authoring' | 'all'`. Implement the new filter branches per D5 §7.4 sketch.

3. **[REFACTOR]** Co-locate scope-filter logic; one-line JSDoc per scope variant.

**Dependencies:** B2 (gating), C1 (axis field exists)
**Parallelizable:** No

---

### Task D2: Verify scope-filter regression against v1 fixtures

**Closes:** D5 §7.8 regression coverage
**Phase:** RED → GREEN

1. **[RED]** Write test: `LoadInvariants_V1FixtureWithScopeCore_StillReturnsExpectedEntries`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts: a fixture matching v1's catalog structure (no `axis` field) parses with a default `axis: 'substrate'` fallback OR throws cleanly (loud failure) — D4 §2 decision. Recommend: throw if `axis` field absent (no silent fallback); test asserts the throw with descriptive message naming the entry ID.

2. **[GREEN]** Add fail-loud handling for missing `axis` field in `parseInvariantEntry`. Error message: `"Invariant entry '<id>' is missing required 'axis' field (schema-version: 2 requires explicit substrate|authoring)"`.

**Dependencies:** D1
**Parallelizable:** No

---

## Wave E — `/axiom:design` pairing-discovery fix

Branch: `task/invariants-v2-eN-axiom-pairing`

### Task E1: Update `design-invariants/SKILL.md` `pairs-with` slot

**Closes:** D5 §4.3 + §7.6 step 1
**Phase:** EDIT (no TDD — frontmatter slot change)

1. **[EDIT]** Edit `.claude/skills/design-invariants/SKILL.md` frontmatter:
   - Change `pairs-with: axiom:backend-quality` → `pairs-with: axiom:design`
   - Confirm: this is the slot axiom:design's pairing-discovery scans. If multi-value is supported by the contract (per `@skills/backend-quality/references/pairing-contract.md` in axiom repo), include both: `pairs-with: [axiom:design, axiom:backend-quality]`. If single-value, prefer `axiom:design`.
2. **[VERIFY]** `npm run build:skills` clean (no rendering breakage — design-invariants is project-internal, but the SKILL.md is parsed by axiom:design's discovery).

**Dependencies:** None (independent of Wave C — the frontmatter slot doesn't depend on catalog entries)
**Parallelizable:** With E2

---

### Task E2: Verify `axiom_overlap` declarations are consistent

**Closes:** D5 §7.6 step 2 + Wave E acceptance
**Phase:** VERIFY (no new code; assertion test)

1. **[RED]** Write test: `Invariants_AxiomOverlapDeclarations_AreConsistentWithDesignInvariantsSkillBody`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts: for each entry with `axiom_overlap: DIM-N` declared, the `.claude/skills/design-invariants/SKILL.md` complementarity matrix (lines 90-104 in current version) lists the entry's ID alongside the same DIM-N. Cross-checks the catalog-skill consistency.
   - Note: this is a soft check; the matrix is hand-maintained. Where catalog and matrix disagree, the test fails with the conflicting pair — the fix is updating the matrix to match the catalog.

2. **[GREEN]** Update `.claude/skills/design-invariants/SKILL.md` complementarity matrix to reflect new INV-7..INV-15 + axiom_overlap declarations. Add rows where missing.

**Dependencies:** C3 (axiom_overlap field exists), C4..C11 (new entries with declarations)
**Parallelizable:** With E1

---

## Wave F — Phase 0 directive + verification

Branch: `task/invariants-v2-fN-phase0`

### Task F1: Update `/ideate` Phase 0 directive

**Closes:** D5 §7.5
**Phase:** EDIT (no automated TDD — directive change; manual smoketest)

1. **[EDIT]** Edit `commands/ideate.md` Phase 0 directive — confirm it uses `loadInvariants(...)` with `scope: 'core'` (matching the v2 filter). The current directive (post-#1455) likely uses `scope: 'core'`; verify no change needed OR add explicit `scope: 'core'` parameter if absent.
2. **[EDIT]** Add a one-line callout to the Phase 0 section: "Dev-invariants only surface when `.exarchos.yml: invariants.devCatalog: enabled`. Consumers using Exarchos as a plugin see no entries by default."
3. **[VERIFY]** `npm run build:skills` clean; `commands/ideate.md` Phase 0 change preserved.

**Dependencies:** D1 (scope: 'core' filter exists)
**Parallelizable:** No

---

### Task F2: Manual Phase 0 smoketest + vocabulary lint regression

**Closes:** D5 acceptance criterion (Phase 0 verification) + §7.7 (vocabulary lint recognizes new IDs)
**Phase:** VERIFY (manual test)

1. **[VERIFY]** With `invariants.devCatalog: enabled` in `.exarchos.yml`: invoke `/exarchos:ideate` with a sample CLI-shaped prompt. Confirm Phase 0 surfaces:
   - INV-1, INV-2, INV-5a, INV-5b, INV-6 (sharpened), INV-7, INV-8, INV-11, INV-12, INV-15 — the 10 substrate always-load entries
   - DOES NOT surface DIM-8 (authoring axis)
   - DOES NOT surface reference-only entries (INV-3, INV-4, INV-5c, INV-5d, INV-9, INV-10, INV-13, INV-14, DIM-1..7)
2. **[VERIFY]** With `invariants.devCatalog: disabled` (or unset): invoke `/exarchos:ideate` with the same prompt. Confirm Phase 0 surfaces NO entries.
3. **[VERIFY]** Run `npm run lint:invariants` — confirms vocabulary lint recognizes all new IDs (INV-7..INV-15, INV-12) without false positives. Closes D5 §7.7 implicitly (lint reads catalog at runtime; this verification confirms the runtime recognition works).
4. **[VERIFY]** Document smoketest result in PR description.

**Dependencies:** F1, D1, B2
**Parallelizable:** No (last task)

---

## Parallelization summary

```
A:  A1 ∥ A2
B:  B1 → B2 → B3
C:  C1 → {C2 ∥ C3} → {C4 ∥ C5} → {C6 ∥ C7 ∥ C8 ∥ C9 ∥ C10 ∥ C11} → C12 → {C13 ∥ C14}
D:  D1 → D2
E:  E1 ∥ E2
F:  F1 → F2

Cross-wave:
  Wave A unblocks tasks C6 (needs A1) and C10 (needs A2)
  Wave B unblocks Wave C entirely
  Wave C unblocks Wave D (need axis field for scope filter) and Wave E (need axiom_overlap declarations)
  Wave D unblocks Wave F (Phase 0 needs scope: 'core' filter)
```

**Parallel-safe dispatch groups (recommended for `/exarchos:delegate`):**

- Group 1 (Wave A): `A1`, `A2` — independent markdown research
- Group 2 (Wave B): `B1` solo → `B2` solo → `B3` solo (config + loader + docs sequential)
- Group 3 (Wave C schema): `C1` solo → `C2 ∥ C3` (parallel: independent schema fields)
- Group 4 (Wave C splits): `C4 ∥ C5` (parallel: independent splits)
- Group 5 (Wave C new entries): `C6, C7, C8, C9, C10, C11` all parallel (independent entries)
- Group 6 (Wave C sharpenings): `C12` solo → `C13 ∥ C14` (C13/C14 independent)
- Group 7 (Wave D): `D1` solo → `D2` solo
- Group 8 (Wave E): `E1 ∥ E2`
- Group 9 (Wave F): `F1` solo → `F2` solo

Estimated wall-clock with full parallelism: ~6 hours of agent time (vs ~20+ hours sequential).

## Branch + merge sequence

1. Create `feature/invariants-catalog-v2-implementation` off `main` as integration parent.
2. Dispatch Wave A tasks (`A1`, `A2`) onto `task/invariants-v2-a*` branches; merge into integration.
3. Dispatch Wave B tasks sequentially onto `task/invariants-v2-b*` branches; merge into integration after each.
4. Dispatch Wave C tasks per Group 3 → Group 4 → Group 5 → Group 6 ordering; merge into integration.
5. Dispatch Wave D, then Wave E (parallel), then Wave F.
6. Open PR from `feature/invariants-catalog-v2-implementation` against `main`.
7. CodeRabbit + `/exarchos:review` → merge.

**Stack discipline:** This is a single integration branch, not a stacked-PR pattern (per [memory: feedback_stacked_pr_auto_merge_collapses_granularity], stacked PRs are reserved for cases where intermediate PRs ship independent value). v2 catalog is one cohesive change; stack would only add bookkeeping overhead.

## Total task count

- **Concrete tasks**: 23 (2 + 3 + 14 + 2 + 2 + 2 = 25; wait — recounting: A=2, B=3, C=14, D=2, E=2, F=2 = 25)
- Wave A (research): 2 (A1, A2)
- Wave B (gating): 3 (B1, B2, B3)
- Wave C (catalog): 14 (C1..C14)
- Wave D (loader): 2 (D1, D2)
- Wave E (axiom pairing): 2 (E1, E2)
- Wave F (Phase 0): 2 (F1, F2)
- **Total: 25 tasks**

## References

- Design: [`docs/proposals/2026-05-20-invariants-catalog-v2-spec.md`](../proposals/2026-05-20-invariants-catalog-v2-spec.md)
- Discover deliverables (D1–D4): `docs/research/2026-05-20-runtime-invariants-*.md`
- Discover PR: [#1458](https://github.com/lvlup-sw/exarchos/pull/1458)
- v1 catalog: [`docs/architecture/invariants.md`](../architecture/invariants.md)
- Predecessor audit pair PRs: #1455, #1457
- Epic: [#1441](https://github.com/lvlup-sw/exarchos/issues/1441)
- Memory: [[project_invariants_dev_vs_consumer_catalog]], [[project_review_contract_sot]]
