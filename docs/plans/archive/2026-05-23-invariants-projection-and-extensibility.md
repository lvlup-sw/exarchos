# Implementation Plan: Invariants — Projection Model & User Extensibility

> **Design:** [`docs/designs/2026-05-23-invariants-projection-and-extensibility.md`](../designs/2026-05-23-invariants-projection-and-extensibility.md)
> **Date:** 2026-05-23
> **Workflow:** `invariants-projection-extensibility`
> **Scope:** Full §11 arc (Approach C — contract-shaped seam). All 10 DRs.

## Iron Law

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST**

## Scope Declaration

**Full coverage.** Every DR-1…DR-10 maps to ≥1 task. Forward dependencies (#1125 TypeSpec generation, #1275 MCP Resource facade) are explicitly *out of scope* and realized as documented seams only (DR-7, DR-10). The shipped `SDLC-*` catalog *content* is deferred to a follow-on `/exarchos:discover` (design Open Question #2) — this plan ships the *mechanism* (`integrity-class: sdlc` layer + merge + override floor), not the authored sdlc invariants themselves.

## Traceability Matrix

| DR | Requirement | Tasks |
|---|---|---|
| DR-1 | v3 additive schema, contract-shaped | T-01, T-02, T-03 |
| DR-2 | `enforcement` combinator DSL + evaluator | T-04, T-05, T-06, T-07 |
| DR-3 | `check_invariant_conformance` gate | T-12, T-13, T-14, T-15 |
| DR-4 | Audit-prompt runner; retire `design-invariants` | T-16, T-17, T-23 |
| DR-5 | Projection model | T-10, T-11 |
| DR-6 | Layered catalogs + override floor | T-08, T-09, T-18 |
| DR-7 | Dual-facade effective catalog | T-19, T-20 |
| DR-8 | Coverage-closure lint + axiom graduation | T-21 |
| DR-9 | Error handling / failure modes | T-22 |
| DR-10 | Strategos contract-seam discipline | T-24, T-25 |

## Architecture Map

```
invariant-schema.ts (v3 Zod, seam-commented)  ◀─ T-01..T-03 (DR-1)
check-evaluator.ts  (all-of/any-of/not/scope) ◀─ T-04..T-07 (DR-2)
catalog-merge.ts    (dev/sdlc/user + floors)  ◀─ T-08..T-09 (DR-6)
project-catalog.ts  (phase×wf×files)          ◀─ T-10..T-11 (DR-5)
resolve-effective-catalog.ts (core fn)        ◀─ T-19      (DR-7)
orchestrate/check-invariant-conformance.ts    ◀─ T-12..T-15 (DR-3)
architecture/audit-prompt.ts                  ◀─ T-16..T-17 (DR-4)
config/exarchos-config-schema.ts (+keys)      ◀─ T-18      (DR-6)
vocabulary-lint.ts (+coverage closure)        ◀─ T-21      (DR-8)
CLI export facade + view wiring               ◀─ T-20      (DR-7)
```

---

## Tasks

## Group A — Schema foundation (DR-1)

### Task T-01: v3 schema Zod types
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-1
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `InvariantSchemaV3_AllFieldsOptional_ParsesMinimalEntry`
   - File: `servers/exarchos-mcp/src/architecture/invariant-schema.test.ts`
   - Expected failure: `invariant-schema.ts` does not exist.
2. [GREEN] Define `InvariantEntryV3Schema` (Zod) adding `phaseAffinity?`, `workflowAffinity?`, `stateAffinity?`, `enforcement?`, `severity?`, `integrityClass?` — all optional. Export inferred type.
   - File: `servers/exarchos-mcp/src/architecture/invariant-schema.ts`
3. [REFACTOR] Add `// contract-shaped: <TypeSpec model>` seam comment per top-level type.

**Dependencies:** None
**Parallelizable:** No (foundation)

### Task T-02: Loader accepts schema-version 2 and 3
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-1
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `LoadInvariants_SchemaVersion3_Accepted` and `LoadInvariants_SchemaVersion2_StillAccepted`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts`
   - Expected failure: loader hard-rejects version != 2.
2. [GREEN] Widen the version guard to accept `2 | 3`; project v3 fields via `InvariantEntryV3Schema` when present.
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.ts`
3. [REFACTOR] Extract version constant.

**Dependencies:** T-01
**Parallelizable:** No

### Task T-03: Live-catalog back-compat fixture
**Phase:** RED → GREEN
**Implements:** DR-1
**testingStrategy:** characterization | propertyTests: no | benchmarks: no

1. [RED] `LoadInvariants_LiveV2Catalog_ZeroDiffUnderV3Loader`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts`
   - Expected failure: no fixture asserting parity between pre/post loader output on the live catalog.
2. [GREEN] Snapshot the resolved entries from `docs/architecture/invariants.md`; assert v3 loader yields identical resolved entries (absent affinities ⇒ undefined, no error).

**Dependencies:** T-02
**Parallelizable:** No

## Group B — Combinator DSL + evaluator (DR-2)

### Task T-04: Combinator tree schema (enforcement — mechanizable checks + declarative combinator DSL)
**Phase:** RED → GREEN
**Implements:** DR-2
The `enforcement` field carries the mechanizable-checks combinator DSL (all-of/any-of/not/scope).
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `EnforcementSchema_CheckMode_AcceptsCombinatorTree` and `EnforcementSchema_RejectsEmbeddedExecutable`
   - File: `servers/exarchos-mcp/src/architecture/invariant-schema.test.ts`
   - Expected failure: no `enforcement` union defined.
2. [GREEN] Add `EnforcementSchema` = discriminated union on `mode`: `check` (recursive `CheckNode` = leaf `{kind: grep|structural|heuristic, pattern, fileGlob, threshold?}` | `{all-of: CheckNode[]}` | `{any-of: CheckNode[]}` | `{not: CheckNode}` | `{scope: {fileGlob?, phase?}, node: CheckNode}`) | `audit` (`{auditPrompt: string}`). `.strict()` so unknown fields (embedded code) fail.
   - File: `servers/exarchos-mcp/src/architecture/invariant-schema.ts`

**Dependencies:** T-01
**Parallelizable:** Yes (with Group A done)

### Task T-05: Leaf evaluation reuses check-catalog
**Phase:** RED → GREEN
**Implements:** DR-2
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `EvaluateLeaf_GrepKind_DelegatesToCheckCatalogExecution`
   - File: `servers/exarchos-mcp/src/architecture/check-evaluator.test.ts`
   - Expected failure: `check-evaluator.ts` absent.
2. [GREEN] `evaluateLeaf(leaf, diff)` reusing `review/check-catalog.ts` leaf execution; returns `PluginFinding[]`.
   - File: `servers/exarchos-mcp/src/architecture/check-evaluator.ts`

**Dependencies:** T-04
**Parallelizable:** No

### Task T-06: Combinator truth-table
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-2
**testingStrategy:** unit | propertyTests: yes | benchmarks: no

1. [RED] `EvaluateTree_AllOf_PassesOnlyWhenAllChildrenPass`, `_AnyOf_`, `_Not_Inverts`, `_Scope_NarrowsFileGlob`
   - File: `servers/exarchos-mcp/src/architecture/check-evaluator.test.ts`
   - Expected failure: no tree walker.
2. [GREEN] `evaluateTree(node, diff)` walking all combinator kinds.
3. [REFACTOR] Property test: random boolean tree vs. reference boolean eval agree.

**Dependencies:** T-05
**Parallelizable:** No

### Task T-07: Total-function fail-closed
**Phase:** RED → GREEN
**Implements:** DR-2, DR-9
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `EvaluateTree_UnknownKind_ThrowsAtLoadNotEval`
   - File: `servers/exarchos-mcp/src/architecture/check-evaluator.test.ts`
   - Expected failure: unknown kind silently ignored.
2. [GREEN] Schema validation throws typed `UnknownCheckKindError` at load; evaluator asserts exhaustive `never` switch.

**Dependencies:** T-06
**Parallelizable:** No

## Group C — Layered merge + override (DR-6)

### Task T-08: Layered catalog merge
**Phase:** RED → GREEN
**Implements:** DR-6
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `MergeCatalogs_DevSdlcUser_PreservesLayerOrigin` and `MergeCatalogs_UserReservedId_FailsValidation`
   - File: `servers/exarchos-mcp/src/architecture/catalog-merge.test.ts`
   - Expected failure: `catalog-merge.ts` absent.
2. [GREEN] `mergeCatalogs({dev, sdlc, user})` → entries tagged with `integrityClass`; reject `INV-*`/`SDLC-*` ids in the user layer.
   - File: `servers/exarchos-mcp/src/architecture/catalog-merge.ts`

**Dependencies:** T-02
**Parallelizable:** Yes (parallel with Group B)

### Task T-09: Override floor clamp
**Phase:** RED → GREEN
**Implements:** DR-6
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `ApplyOverrides_DisableBelowFloor_ClampsToAdvisoryWithWarning`, `ApplyOverrides_DevSubstrate_NotPresentWhenDevCatalogDisabled`
   - File: `servers/exarchos-mcp/src/architecture/catalog-merge.test.ts`
   - Expected failure: no override resolver.
2. [GREEN] `applyOverrides(merged, overrides)`: honor per-invariant `overrideFloor` (default `advisory` for sdlc); clamp `enabled:false` → advisory + warning when floor is advisory; dev-substrate entries absent under `devCatalog: disabled` proven by merge.

**Dependencies:** T-08
**Parallelizable:** No

## Group D — Projection (DR-5)

### Task T-10: projectCatalog by key
**Phase:** RED → GREEN
**Implements:** DR-5
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `ProjectCatalog_PhaseReview_ExcludesIdeateOnlyEntries`, `ProjectCatalog_DiscoverWorkflow_ExcludesCodeAxisInvariants`
   - File: `servers/exarchos-mcp/src/architecture/project-catalog.test.ts`
   - Expected failure: `project-catalog.ts` absent.
2. [GREEN] `projectCatalog({phase, workflowType, touchedFiles})` pure left-fold over merged catalog filtering by affinity.
   - File: `servers/exarchos-mcp/src/architecture/project-catalog.ts`

**Dependencies:** T-09
**Parallelizable:** No

### Task T-11: File-scoped delegate injection
**Phase:** RED → GREEN
**Implements:** DR-5
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `ProjectCatalog_DelegateDocsOnlyTask_NoCodeInvariantInjection`
   - File: `servers/exarchos-mcp/src/architecture/project-catalog.test.ts`
   - Expected failure: `applies-to ∩ task.files` filter not applied.
2. [GREEN] Add `touchedFiles` intersection filter for the delegate projection.

**Dependencies:** T-10
**Parallelizable:** No

## Group E — Gate (DR-3)

### Task T-12: Gate handler skeleton + outputSchema
**Phase:** RED → GREEN
**Implements:** DR-3
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `CheckInvariantConformance_EmptyCatalog_ApprovedZeroFindings`
   - File: `servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.test.ts`
   - Expected failure: handler absent.
2. [GREEN] `handleCheckInvariantConformance(args, stateDir, eventStore)` → resolve→project→evaluate; empty ⇒ APPROVED + emit `gate.executed`.
   - File: `servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts`

**Dependencies:** T-07, T-11
**Parallelizable:** No

### Task T-13: Register action (registry + composite)
**Phase:** RED → GREEN
**Implements:** DR-3
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `Registry_CheckInvariantConformance_RegisteredReadOnlyUnder15Tools`
   - File: `servers/exarchos-mcp/src/registry.test.ts` (or co-located)
   - Expected failure: action not in registry.
2. [GREEN] Add registry entry (Zod schema → CLI flags, `annotations: readOnly`, `gate: {blocking:false}`, `outputSchema`, `autoEmits: gate.executed`); wire in `composite.ts` via `adaptWithEventStore`.
   - Files: `servers/exarchos-mcp/src/registry.ts`, `composite.ts`

**Dependencies:** T-12
**Parallelizable:** No

### Task T-14: Fold findings into review-verdict severity
**Phase:** RED → GREEN
**Implements:** DR-3
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `CheckInvariantConformance_BlockingViolation_FoldsToNeedsFixes`
   - File: `servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.test.ts`
   - Expected failure: severity fold not wired.
2. [GREEN] Map evaluator findings + audit `pluginFindings` to `PluginFinding[]` keyed by context-resolved `severity`; feed `check_review_verdict` merge path.

**Dependencies:** T-13
**Parallelizable:** No

### Task T-15: Facade parity (INV-2)
**Phase:** RED → GREEN
**Implements:** DR-3
**testingStrategy:** parity | propertyTests: no | benchmarks: no

1. [RED] `CheckInvariantConformance_CliVsMcp_IdenticalToolResult`
   - File: `servers/exarchos-mcp/src/__tests__/parity-harness.test.ts` (extend) or co-located parity test
   - Expected failure: action not in parity harness.
2. [GREEN] Add action to the parity harness; assert byte/schema-identical `ToolResult` across adapters.

**Dependencies:** T-14
**Parallelizable:** No

## Group F — Audit prompt + skill retirement (DR-4)

### Task T-16: Audit-prompt renderer
**Phase:** RED → GREEN
**Implements:** DR-4
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `RenderAuditPrompt_AuditModeInvariants_EmitsPromptVerbatim`
   - File: `servers/exarchos-mcp/src/architecture/audit-prompt.test.ts`
   - Expected failure: `audit-prompt.ts` absent.
2. [GREEN] `renderAuditPrompt(invariants)` concatenating `summary` + `auditPrompt` for applicable `mode: audit` entries; workflow-agnostic (no `INV-*` branching).
   - File: `servers/exarchos-mcp/src/architecture/audit-prompt.ts`

**Dependencies:** T-02
**Parallelizable:** Yes (parallel with Groups C–E foundations)

### Task T-17: Gate wires audit prompt into subagent path
**Phase:** RED → GREEN
**Implements:** DR-4
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `CheckInvariantConformance_AuditInvariant_RendersPromptInResult`
   - File: `servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.test.ts`
   - Expected failure: audit prompt not surfaced.
2. [GREEN] Gate result carries rendered audit prompt block for the review subagent; collected findings re-enter as `pluginFindings`.

**Dependencies:** T-15, T-16
**Parallelizable:** No

## Group G — Config keys (DR-6)

### Task T-18: Additive `.exarchos.yml` invariants keys
**Phase:** RED → GREEN
**Implements:** DR-6
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `InvariantsConfigSchema_NewKeys_ParseAndStrictReject`
   - File: `servers/exarchos-mcp/src/config/exarchos-config-schema.test.ts`
   - Expected failure: `catalogs`/`overrides`/`enforcement` not in schema.
2. [GREEN] Extend `InvariantsConfigSchema`: `catalogs: string[]?`, `overrides: Record<id,{severity?,enabled?}>?`, `enforcement: {review: 'blocking'|'advisory'}?`. Keep `.strict()`.
   - File: `servers/exarchos-mcp/src/config/exarchos-config-schema.ts`

**Dependencies:** None
**Parallelizable:** Yes (independent)

## Group H — Dual-facade exposure (DR-7)

### Task T-19: resolveEffectiveCatalog core fn
**Phase:** RED → GREEN
**Implements:** DR-7
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `ResolveEffectiveCatalog_DevSdlcUser_ReturnsMergedProjectedPayload`
   - File: `servers/exarchos-mcp/src/architecture/resolve-effective-catalog.test.ts`
   - Expected failure: fn absent.
2. [GREEN] `resolveEffectiveCatalog(ctx)` composing load→merge→override→project; single source for both facades.
   - File: `servers/exarchos-mcp/src/architecture/resolve-effective-catalog.ts`

**Dependencies:** T-10, T-18
**Parallelizable:** No

### Task T-20: CLI/view export facade
**Phase:** RED → GREEN
**Implements:** DR-7
**testingStrategy:** parity | propertyTests: no | benchmarks: no

1. [RED] `ViewInvariants_Export_ReturnsSamePayloadAsCoreFn`
   - File: co-located view/export test
   - Expected failure: no export verb.
2. [GREEN] Add an `exarchos_view` invariants query / CLI `--json` export calling `resolveEffectiveCatalog`; assert byte-identical payload. Add seam comment marking the future `resources/exarchos-invariants/effective` facade (no `resources/*` registration today).

**Dependencies:** T-19
**Parallelizable:** No

## Group I — Coverage lint + seam discipline (DR-8, DR-10)

### Task T-21: Coverage-closure lint check
**Phase:** RED → GREEN
**Implements:** DR-8
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `VocabularyLint_DimWithoutSpecializingInv_EmitsCoverageGap`
   - File: `servers/exarchos-mcp/src/architecture/vocabulary-lint.test.ts`
   - Expected failure: no coverage-closure check.
2. [GREEN] Add a check to `vocabulary-lint.ts`: every `DIM-*` must have ≥1 `INV-*` with matching `axiom_overlap` or an explicit N/A marker; else non-zero-exit finding.
   - File: `servers/exarchos-mcp/src/architecture/vocabulary-lint.ts`

**Dependencies:** None
**Parallelizable:** Yes (independent)

### Task T-22: Failure-mode degradation (DR-9)
**Phase:** RED → GREEN
**Implements:** DR-9
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `CheckInvariantConformance_MalformedUserCatalog_DegradesToShippedLayersAdvisory`, `_LeafThrows_CapturedAsLowFinding`
   - File: `servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.test.ts`
   - Expected failure: malformed catalog aborts the gate.
2. [GREEN] Wrap user-catalog load: on failure evaluate only valid shipped layers + emit advisory finding naming file/id (no silent swallow, INV-1). Per-leaf throw → `LOW` finding, not gate abort.

**Dependencies:** T-17
**Parallelizable:** No

### Task T-23: Retire design-invariants skill
**Phase:** RED → GREEN
**Implements:** DR-4
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `DesignInvariantsSkill_Removed_NoVocabularyInSkillBodies`
   - File: a guard test (e.g. `servers/exarchos-mcp/src/architecture/skill-retirement.test.ts`)
   - Expected failure: skill dir still present.
2. [GREEN] Remove `.claude/skills/design-invariants/`; update `review-contract.ts` / review playbooks to reference the gate; ensure `rg "design-invariants"` returns only doc/historical refs; `skills:guard` passes.

**Dependencies:** T-17
**Parallelizable:** No

### Task T-24: Contract-seam doc
**Phase:** RED → GREEN
**Implements:** DR-10
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `ContractSeamDoc_EnumeratesEveryV3Type`
   - File: `servers/exarchos-mcp/src/architecture/contract-seam.test.ts`
   - Expected failure: doc absent.
2. [GREEN] Author `docs/architecture/invariants-v3-contract-seam.md` mapping each v3 Zod type ↔ target TypeSpec model. Test asserts every exported v3 type appears in the doc.

**Dependencies:** T-04
**Parallelizable:** Yes (after T-04)

### Task T-25: Seam-comment lint
**Phase:** RED → GREEN
**Implements:** DR-10
**testingStrategy:** unit | propertyTests: no | benchmarks: no

1. [RED] `SeamLint_V3TypeMissingSeamComment_Fails`
   - File: `servers/exarchos-mcp/src/architecture/contract-seam.test.ts`
   - Expected failure: no seam-comment enforcement.
2. [GREEN] Lint asserting every v3 top-level type carries a `// contract-shaped:` comment; no runtime dependency on Strategos.Contracts introduced.

**Dependencies:** T-24
**Parallelizable:** No

---

## Parallelization Plan

```
Wave 1 (foundation, sequential):  T-01 → T-02 → T-03
Wave 2 (parallel after T-02):     [T-04→T-05→T-06→T-07] ∥ [T-08→T-09] ∥ T-16 ∥ T-18 ∥ T-21
Wave 3 (projection):              T-10 → T-11        (needs T-09)
Wave 4 (gate chain):              T-12 → T-13 → T-14 → T-15 → T-17  (needs T-07, T-11, T-16)
Wave 5 (exposure):                T-19 → T-20         (needs T-10, T-18)
Wave 6 (closeout, parallel):      T-22 ∥ T-23 ∥ [T-24→T-25]
```

Parallel-safe groups never touch the same file. The gate chain (Wave 4) is strictly sequential — each task builds on the prior handler state.

## Testing Strategy Summary

- **Property tests:** T-06 (combinator boolean-algebra equivalence).
- **Parity tests:** T-15, T-20 (INV-2 facade equivalence — the load-bearing constraint).
- **Characterization:** T-03 (live-catalog back-compat snapshot).
- **No benchmarks** — this is declarative-config + gate logic, not a hot path.

## Open Questions (carried from design, resolve during implementation)

1. `state-affinity` → `topology.yaml` binding: soft reference resolved at projection time (T-10), not a hard import (INV-6). Confirm at delegate.
2. `SDLC-*` catalog *content* deferred to follow-on `/exarchos:discover`. This plan ships the mechanism only.
3. Catalog discovery stays explicit (`catalogs:` listing, no auto-detect) — v2 precedent.
