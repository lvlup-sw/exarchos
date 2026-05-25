# Implementation Plan: Author v3 Dev-Catalog Content (#1466)

> **⚠️ Partially superseded by #1477 (axiom excision), 2026-05-24.** The DIM-*
> and `axiom_overlap` portions of this plan are obsolete: #1477 excised all 8
> `DIM-*` entries and the `axiom_overlap` field/loader machinery from the
> catalog (Option 1). Specifically **void**: Task 8 (Coverage-closure —
> DIM-4/5/6/8 `coverage: n/a`), every CR/acceptance line referencing
> `axiom_overlap` or coverage-closure, and the REFACTOR step asserting the
> `axiom_overlap` accessor is intact. The `schema-version: 2 → 3` bump already
> landed on `main`. The catalog is now **19 entries** (18 INV-* +
> `basileus-boundary`). #1478 (catalog content-complete) inherits the 19-entry
> target — not the DIM-bearing one this plan assumed.

> **Design:** [`docs/designs/2026-05-24-invariants-dev-catalog-v3-content.md`](../designs/2026-05-24-invariants-dev-catalog-v3-content.md)
> **Stacks on:** PR #1465 (`feature/invariants-projection-extensibility`)
> **Iron law:** no catalog content lands without a failing test first (loader / projection / gate / lint).

## Nature of this work

The "production code" is **YAML content** in `docs/architecture/invariants.md`. TDD applies literally: each task writes a failing test (loader back-compat, fixture-diff bite, projection assertion, or coverage-closure lint) **first**, then authors the catalog content that turns it green. The machinery (schema, evaluator, gate, lint) is already shipped by #1465 and is read-only here.

**Single-file contention:** nearly every task edits the one file `docs/architecture/invariants.md`. Worktree-parallel dispatch would collide on that file, so the content tasks run **sequentially on one branch**. Test files differ per task and could be authored in parallel, but since RED must precede the shared-file GREEN, the chain is serial. This is an honest constraint, not a missed parallelization.

**Calibrate-on-HEAD rule (applies to every `mode: check` task):** after authoring a check tree, run `check_invariant_conformance` against the *current clean tree* and confirm **zero findings**. Only a deliberately-seeded fixture diff may produce a finding. This is the bootstrap-hazard guard.

---

### Task 1: Schema-version bump + v3 loader back-compat
**Phase:** RED → GREEN → REFACTOR
**Maps:** CR-1

1. [RED] Extend `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts`
   - Test: `loadInvariants_liveCatalogAtV3_parsesEveryEntryWithNoError`
   - Test: `loadInvariants_entryWithoutAffinities_resolvesAllPhasesAllTypes`
   - Expected failure: live catalog is `schema-version: 2`; the v3 assertion on the frontmatter version fails.

2. [GREEN] Edit `docs/architecture/invariants.md` frontmatter: `schema-version: 2` → `3`. **No other change.** Do *not* rename `axiom_overlap` (design Problem-Statement #1).

3. [REFACTOR] Confirm `npm run lint:invariants` coverage-closure still green (proves the `axiom_overlap` accessor is intact post-bump).

**Dependencies:** None
**Parallelizable:** No (touches the shared catalog file)

---

### Task 2: INV-6 `mode: check` (workflow-typed-literal grep)
**Phase:** RED → GREEN → REFACTOR
**Maps:** CR-2 (check #1)

1. [RED] Add to `servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.test.ts`
   - Test: `gate_diffWithWorkflowTypedLiteralInSkillsSrc_emitsInv6Finding`
   - Test: `gate_cleanDiff_inv6ProducesNoFinding`
   - Expected failure: INV-6 has no `enforcement` block, so no finding on the seeded violating diff.

2. [GREEN] Author INV-6 `enforcement: { mode: check, check: <grep tree> }` in `invariants.md`, reusing the `scripts/lint-inv6.mjs` literal set (`feature/`, `featureId`, workflow-type names) scoped to `fileGlob: skills-src/**`. Use a `not(scope(...))` arm to exclude legitimate `featureId` field references if calibration requires.

3. [REFACTOR] **Calibrate-on-HEAD:** run the gate on clean tree → assert zero INV-6 findings; tighten the pattern/`not` arm until green.

**Dependencies:** Task 1
**Parallelizable:** No

---

### Task 3: INV-5d + INV-5a `mode: check` (visible-tool-count structural)
**Phase:** RED → GREEN → REFACTOR
**Maps:** CR-2 (check #2, #3)

1. [RED] Add to `check-invariant-conformance.test.ts`
   - Test: `gate_diffRegisteringFifthCompositeTool_emitsInv5dFinding`
   - Test: `gate_cleanDiff_inv5dInv5aProduceNoFinding`
   - Expected failure: no enforcement block on INV-5d/INV-5a.

2. [GREEN] Author `structural` check leaves: INV-5d → composite-tool registration count > 4 in `registry.ts`; INV-5a → visible-tool count ≥ 15. Use a shared pattern constant duplicated across both entries (DSL has no cross-entry reference — design OQ #3).

3. [REFACTOR] Calibrate-on-HEAD: current count is 4 composite / under 15 visible → zero findings.

**Dependencies:** Task 1
**Parallelizable:** No

---

### Task 4: INV-4 `mode: check` (generated-skills direct-edit grep)
**Phase:** RED → GREEN → REFACTOR
**Maps:** CR-2 (check #4)

1. [RED] Add to `check-invariant-conformance.test.ts`
   - Test: `gate_diffEditingGeneratedSkillsRuntimeFile_emitsInv4Finding`
   - Test: `gate_diffEditingSkillsSrcOnly_inv4ProducesNoFinding`
   - Expected failure: no enforcement block on INV-4.

2. [GREEN] Author `grep` check: hunk headers touching `skills/<runtime>/**` (generated output) flagged as a source-of-truth violation, scoped to exclude `skills-src/**`.

3. [REFACTOR] Calibrate-on-HEAD (this PR touches no `skills/**` → zero findings).

**Dependencies:** Task 1
**Parallelizable:** No

---

### Task 5: INV-2 `mode: check` heuristic (adapter-carries-behavior) — with audit fallback
**Phase:** RED → GREEN → REFACTOR
**Maps:** CR-2 (check #5), design OQ #1

1. [RED] Add to `check-invariant-conformance.test.ts`
   - Test: `gate_diffAddingLogicToCliAdapter_emitsInv2AdvisoryFinding`
   - Expected failure: no enforcement block on INV-2.

2. [GREEN] Author `grep` (scoped to `adapters/{cli,mcp}.ts`) for behavior keywords beyond presentation, `severity: { default: advisory }`. **Decision gate:** if calibration on HEAD cannot reach zero findings without an over-broad `not(...)` exclusion list, **demote INV-2 to `mode: audit`** (the Approach-B fallback) rather than ship a noisy check.

3. [REFACTOR] Calibrate-on-HEAD; record the check-vs-audit decision in the task notes.

**Dependencies:** Task 1
**Parallelizable:** No

---

### Task 6: `mode: audit` prompts — INV-1 / INV-11 / INV-3 / INV-13 / INV-14
**Phase:** RED → GREEN → REFACTOR
**Maps:** CR-2 (audit), DR-4

1. [RED] Extend `servers/exarchos-mcp/src/architecture/audit-prompt.test.ts`
   - Test: `renderAuditPrompt_inv11Authored_containsAuditPromptVerbatim`
   - Test: `renderAuditPrompt_noMcpLocalPresumption_inv3PromptIsTransportNeutral` (INV-3 guard)
   - Expected failure: no `audit-prompt` on these entries.

2. [GREEN] Author `enforcement: { mode: audit, audit-prompt: "..." }` for INV-1 (reducer purity / side-database), INV-11 (unrepresentable-by-construction), INV-3 (no MCP-local presumption — transport-neutral phrasing), INV-13/14 (two-event-split / recovery-primitive ordering).

3. [REFACTOR] Verify rendered prompt carries no `INV-*`-specific branching in the runner (INV-6 — runner stays workflow-agnostic).

**Dependencies:** Task 1
**Parallelizable:** No

---

### Task 7: Projection metadata — affinity + severity + integrity-class
**Phase:** RED → GREEN → REFACTOR
**Maps:** CR-3, DR-5 §6 table

1. [RED] Extend `servers/exarchos-mcp/src/architecture/project-catalog.test.ts`
   - Test: `projectCatalog_workflowDiscoverPhaseReview_excludesCodeAxisInvariants`
   - Test: `projectCatalog_workflowOneshot_downgradesSeverityToAdvisory`
   - Expected failure: entries lack `workflow-affinity` / `severity.by-workflow`.

2. [GREEN] Author per-entry `phase-affinity` (`[review]` for enforcement-bearing; `+[ideate,plan]` for design-time), `workflow-affinity` (code-axis excludes `discover`), `severity` (`default: blocking`, `by-workflow: { oneshot: advisory }`), `integrity-class` (`substrate` for INV-*, `authoring` for DIM-8). INV-2 keeps `default: advisory`.

3. [REFACTOR] Spot-check the live-catalog projection snapshot for unintended exclusions.

**Dependencies:** Tasks 2–6 (entries must exist before metadata is layered)
**Parallelizable:** No

---

### Task 8: Coverage-closure — DIM-4/5/6/8 `coverage: n/a`
**Phase:** RED → GREEN → REFACTOR
**Maps:** CR-4, DR-8

1. [RED] Extend `servers/exarchos-mcp/src/architecture/vocabulary-lint.test.ts`
   - Test: `coverageClosure_dim4Through8WithoutSpecializingInv_areExemptedByNaMarker`
   - Expected failure: DIM-4/5/6/8 have neither a specializing INV nor an `n/a` marker → coverage-gap findings.

2. [GREEN] Add `coverage: n/a` to DIM-4/5/6/8 entries in `invariants.md`, each with a one-line axiom cross-reference (`/axiom:verify`, `/axiom:distill`, `/axiom:critique`, `/axiom:humanize`). Confirm DIM-1/2/3/7 stay covered via existing `axiom_overlap`.

3. [REFACTOR] `npm run lint:invariants` exits zero.

**Dependencies:** Task 1
**Parallelizable:** No

---

### Task 9: End-to-end gate bite + INV-2 facade parity
**Phase:** RED → GREEN → REFACTOR
**Maps:** CR-5, INV-2/5b

1. [RED] Add a parity test (reuse `servers/exarchos-mcp/src/__tests__/parity-harness.ts`)
   - Test: `checkInvariantConformance_authoredCatalog_cliAndMcpReturnIdenticalToolResult`
   - Test: `checkInvariantConformance_seededViolation_emitsGateExecutedWithInvariantId`
   - Expected failure (pre-content) / regression guard (post-content).

2. [GREEN] Content already authored (Tasks 2–7); this task verifies the authored catalog produces byte/schema-identical `ToolResult` across both adapters and that a clean diff returns `APPROVED` + a `gate.executed` event (INV-10).

3. [REFACTOR] Full suites: `cd servers/exarchos-mcp && npm run test:run`; root `npm run test:run`; `npm run typecheck`; `npm run skills:guard`; `npm run lint:invariants`. All green.

**Dependencies:** Tasks 1–8
**Parallelizable:** No

---

## Execution order (single serial chain)

```
Task 1 (bump)
  ├─▶ Task 2 (INV-6 check)
  ├─▶ Task 3 (INV-5d/5a check)
  ├─▶ Task 4 (INV-4 check)
  ├─▶ Task 5 (INV-2 check/audit)
  ├─▶ Task 6 (audit prompts)
  └─▶ Task 8 (coverage-closure)
            │
            ▼
        Task 7 (metadata — needs entries from 2–6)
            │
            ▼
        Task 9 (e2e parity + suites)
```

Tasks 2–6 + 8 are *logically* independent but **serialized on the shared `invariants.md` file**. Task 7 layers metadata onto the authored entries; Task 9 is the final verification gate.

## Definition of done (acceptance roll-up)

- [ ] `invariants.md` at `schema-version: 3`; loader back-compat green; `axiom_overlap` untouched (CR-1).
- [ ] ≥1 `mode: check` + ≥1 `mode: audit` authored and exercised by `check_invariant_conformance` against a fixture diff; every check calibrated to zero findings on HEAD (CR-2).
- [ ] `phase-affinity` / `workflow-affinity` / `severity` / `integrity-class` populated; discover-exclusion + oneshot-downgrade proven (CR-3).
- [ ] DIM-4/5/6/8 `coverage: n/a`; `lint:invariants` exits zero (CR-4).
- [ ] INV-2 CLI↔MCP parity green; full MCP + root suites green; `tsc --noEmit` clean; `skills:guard` exit 0 (CR-5).
