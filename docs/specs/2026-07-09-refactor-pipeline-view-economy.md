# Spec: Pipeline View Economy & Repo Scoping

**Date:** 2026-07-09 · **Feature:** `refactor-pipeline-view-economy` · **Depth:** standard
**Inputs:** refactor brief in workflow state (`refactor-pipeline-view-economy`); live-probe evidence 2026-07-09; gate-audit spin-offs #1656/#1657/#1658 (out of scope here)

> One unified artifact: `## Requirements` is the DR-N source; `## Tasks` maps tasks → DR-N within this same document.
> Heading levels here intentionally diverge from `spec-template.md` (h2 Requirements / h3 tasks) — the live `check_plan_coverage` / `check_provenance_chain` parsers reject the template's h3/h4 shape; see issue #1657.

## Design & Rationale

### Problem Statement

The default `exarchos_view pipeline` response is uneconomical and unscoped. Even with the v2.12 default item cap (50, PR #1642), a no-argument call costs ~4,400 tokens: every entry inlines an unbounded `tasksById` map that is redundant with the `taskCount`/`completedCount`/`failedCount` fields beside it; roughly 10 of the first 50 entries are phantom empties (`featureId: ""`, no phase, no timestamp) produced by folding streams that never saw a `workflow.started` event; and the results mix every repository sharing the global store (261 total, mostly other projects) because no repo identity exists anywhere in the data model — not on `events`, not on `workflow_state`, not on `streams`. An agent asking "what's in flight *here*" pays thousands of tokens to read other repos' history.

### Chosen Approach

Keep the single global store and the pure left-fold projection; fix the *view contract*. Three moves: (1) make the default page small and the default entry compact, with explicit paging metadata and an opt-in `detail` flag for the full task map; (2) exclude degenerate fold results from both the page and the total; (3) introduce repo identity as **event data** — an optional `repoRoot` on `workflow.started`, derived once at init from the caller's workspace and POSIX-normalized — and have the pipeline view filter to the caller's repo by default, with an explicit `scope: "all"` escape hatch that also covers legacy rows. No store partitioning, no event rewriting, no backfill.

### Technical Design

**Seams.** All behavior lands in the shared dispatch core (`views/tools.ts` `handleViewPipeline`), never the adapters. `views/composite.ts` threads the dispatch context (cwd) exactly as the `invariants_effective` action already does. The registry entry (`registry.ts` pipeline action) grows three optional schema fields — `detail: boolean`, `repoRoot: string`, `scope: enum['repo','all']` — and its output stays inside the `EnvelopeSchema(z.unknown())` carrier, so no output-schema registration change is needed.

**Repo key derivation.** New `deriveRepoKey(path)` in `servers/exarchos-mcp/src/utils/paths.ts` (beside `toPosix`): resolve the git common root (`git rev-parse --path-format=absolute --git-common-dir`, dirname of it) so main checkout and every worktree share one identity; fall back to the canonicalized input path outside a git repo; normalize with `toPosix` + native canonicalization (Windows 8.3 expansion precedent). Used at both write time (init emission) and read time (view filter), guaranteeing the two sides agree by construction. Spawns go through the existing command-runner (`runCommandSync`-family) per the Windows dynamic-spawn rule.

**Event flow.** `handleInit` (`workflow/tools.ts` ~line 190) adds `repoRoot: deriveRepoKey(ctx.cwd)` to `workflow.started` data when a cwd is available. `WorkflowStartedData` (`event-store/schemas.ts`) gains the optional field. The pipeline projection (`views/pipeline-view.ts`) copies it onto `PipelineViewState` during the `workflow.started` fold — the projection remains a pure left-fold; unknown stays `undefined`.

**View pipeline order.** Fold → phantom filter → scope filter → `total` computed → offset/limit window (pipeline-specific default 10; `DEFAULT_VIEW_ITEM_CAP` stays 50 for other views) → entry compaction (strip `tasksById` unless `detail`) → paging metadata + affordances. Summary branch computes its rollups from the same filtered set.

**Invariants preserved.** Event log stays append-only source of truth (identity enters as event data); CLI/MCP equivalence via the single handler + parity suite; inputs constrained at schema level; envelope carrier fixed; affordances via `next_actions`; behavior identical for every workflow type; paths POSIX-normalized for Windows.

### Integration Points

- `servers/exarchos-mcp/src/event-store/schemas.ts` — `WorkflowStartedData` + optional `repoRoot`.
- `servers/exarchos-mcp/src/workflow/tools.ts` — init emission populates `repoRoot`.
- `servers/exarchos-mcp/src/utils/paths.ts` — `deriveRepoKey` helper.
- `servers/exarchos-mcp/src/views/pipeline-view.ts` — projection carries `repoRoot`.
- `servers/exarchos-mcp/src/views/tools.ts` — filter/window/compaction/metadata in `handleViewPipeline`.
- `servers/exarchos-mcp/src/views/composite.ts` — thread ctx cwd default.
- `servers/exarchos-mcp/src/registry.ts` — pipeline input schema + description.
- `servers/exarchos-mcp/src/views/output-cap.ts` — pipeline-specific default window constant.

### Alternatives considered

- **Per-repo store partitioning** — one SQLite DB per repository. Rejected: migration burden for every existing consumer, breaks cross-repo telemetry/provenance views, and the event-sourcing frame already solves scoping with a projection filter.
- **Join on `workspace.resolved` events** — infer repo identity from the workspace-discovery event. Rejected: that event is only emitted when a dispatch omitted `featureId`, so coverage is sparse and identity would be probabilistic.
- **Clamping explicit `limit`** — cap even explicit requests. Rejected: explicit caller intent should be honored; the existing over-threshold summary fallback already guards against pathological payloads.
- **Backfilling `repoRoot` onto historical events** — rewrite old `workflow.started` rows. Rejected outright: violates the append-only event log.

### Open Questions

- Draining the ~261-row legacy inventory: the prune verb exists but hard-aborts without a topology file (#1545). **Deferred** — out of scope; scoping makes the legacy rows invisible by default, which removes the day-to-day pain.
- Whether other views (`tasks`, `workflow_status`, `worktrees`) should adopt the same repo scoping. **Deferred** — this spec establishes the identity field and the pattern; follow-on adoption is mechanical and better done per-view with its own oracle updates.

## Requirements

The DR-N identifiers below are the single source the decomposition traces against.

### DR-1: Compact default entries

By default, pipeline entries omit the per-task `tasksById` map and carry only summary fields (`featureId`, `workflowType`, `phase`, `taskCount`, `completedCount`, `failedCount`, `stackPositions`, `_asOf`, and the new `repoRoot`). A schema-level boolean `detail` parameter restores the full task map for callers that need it.

**Acceptance criteria:**
- Default call returns entries without `tasksById`; `detail: true` returns them with it.
- The `detail` flag is declared in the Zod input schema (auto-emits the CLI flag) — not a prose hint.
- Counts remain present and correct in both modes.

### DR-2: Small default window

When `limit` is omitted, the pipeline action returns at most 10 entries. An explicit `limit` is honored as today. The worktrees view's shared default cap is untouched.

**Acceptance criteria:**
- Omitted `limit` → ≤10 entries; explicit `limit: 50` → up to 50.
- Default no-argument call in a repo with many workflows costs well under 1,000 tokens.
- The over-threshold summary fallback (byPhase/byWorkflowType rollup) still functions.

### DR-3: Explicit paging metadata

The `data` payload reports `total`, `hasMore`, `offset`, and `limit` in **both** the detail branch and the summary branch, so a follow-up page is constructible without guesswork. The narrow `next_actions` paging affordance is retained.

**Acceptance criteria:**
- `data.total` reflects the filtered, scoped set; `data.hasMore === offset + workflows.length < total`.
- `offset` and `limit` echo the effective values applied (including the default limit when omitted).
- Envelope top-level keys are unchanged (`success`/`data`/`next_actions`/`_meta`/`_perf`).

### DR-4: Phantom exclusion

Fold results lacking a `workflow.started` foundation (empty `featureId`) never appear in the page and never count toward `total`, in any scope mode.

**Acceptance criteria:**
- Given a stream that produces an empty-`featureId` fold, the pipeline response contains no empty entry and `total` excludes it.
- Exclusion applies identically under `scope: "all"` and default scoping.

### DR-5: Repo identity recorded at init

`workflow.started` event data gains an **optional** `repoRoot` field: the POSIX-normalized repository identity of the workspace the init ran in, derived via a single `deriveRepoKey(cwd)` helper (git common-root so all worktrees of one repo share identity; falls back to normalized cwd outside git). Historical events without the field remain valid — the schema addition is backward-compatible, and no existing event is modified.

**Acceptance criteria:**
- New `init` calls emit `workflow.started` with `repoRoot` populated from the dispatch context.
- Events without `repoRoot` still parse (optional field); reducers treat them as unscoped.
- Identity is stable across git worktrees of the same repository and across Windows/POSIX path forms (`toPosix` + canonicalization).

### DR-6: Repo-scoped default view

The pipeline view filters to the caller's repo by default: entries whose `repoRoot` matches the caller's derived repo key. An explicit `repoRoot` parameter targets another repo; `scope: "all"` disables filtering and is the only mode that shows legacy rows lacking `repoRoot`.

**Acceptance criteria:**
- A workflow started in repo A does not appear in repo B's default pipeline view.
- `scope: "all"` reproduces today's cross-repo inventory (minus phantoms).
- Legacy rows (no `repoRoot`) are excluded by default and included under `scope: "all"`.
- Both parameters are schema-declared (CLI flags auto-emit); filtering happens in the shared handler so CLI and MCP behave identically.

### DR-7: Empty-scope affordance

When default scoping yields zero entries but the unscoped store is non-empty, the response publishes a `next_actions` hint pointing at `scope: "all"` (and the total unscoped count), so the narrowing is perceivable rather than silently confusing.

**Acceptance criteria:**
- Scoped-empty + unscoped-nonempty → `next_actions` carries the escape-hatch hint with the unscoped total.
- Scoped-nonempty → no such hint (normal paging affordance only).

### DR-8: Contract conformance preserved

CLI/MCP parity, envelope shape, and registry documentation stay conformant: the action description documents paging + scoping semantics, parity tests pass byte-identical, and intentional oracle changes to existing view tests are explicit.

**Acceptance criteria:**
- `views/parity.test.ts`, `cli/envelope-parity.test.ts`, `parity/readonly-cap-parity.test.ts` green.
- Registry `pipeline` action description updated; affordance hint strings match the new default limit.
- Changed assertions in `views/output-cap.test.ts` / `views/tools.pipeline.test.ts` are enumerated in the PR body as intentional behavior changes (oracle-integrity note).

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.

### Scope

**Target:** Full design
**Excluded:** None (legacy-inventory drain and other-view adoption are design-level deferrals, not decomposition gaps)

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Compact default entries | 005 |
| DR-2 | Small default window | 006 |
| DR-3 | Explicit paging metadata | 006 |
| DR-4 | Phantom exclusion | 004 |
| DR-5 | Repo identity recorded at init | 001, 002 |
| DR-6 | Repo-scoped default view | 003, 007 |
| DR-7 | Empty-scope affordance | 007 |
| DR-8 | Contract conformance preserved | 008, 009 |

## Tasks

Each task carries a `riskTier` stamp that selects its verification depth.
Tests are judged **test-after by adequacy** — the failing-test-first ordering ceremony is not required.

### Task 001: Record repo identity — optional repoRoot on WorkflowStartedData + deriveRepoKey helper

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-5
**Files:**
- `servers/exarchos-mcp/src/event-store/schemas.ts`
- `servers/exarchos-mcp/src/utils/paths.ts`
- `servers/exarchos-mcp/src/event-store/schemas.test.ts`
- `servers/exarchos-mcp/src/utils/paths.test.ts`
**Verification:** high — scoped tests + `check_test_adequacy` kill-probe + integration suite (schema surface). Tests: `WorkflowStartedData_WithRepoRoot_Parses`, `WorkflowStartedData_WithoutRepoRoot_StillParses` (backward compat), `DeriveRepoKey_WorktreePath_MatchesMainCheckoutKey`, `DeriveRepoKey_NonGitPath_FallsBackToNormalizedPath`, `DeriveRepoKey_WindowsSeparators_ReturnsPosix`.
**Dependencies:** None
**Parallelizable:** Yes (chain A head)

### Task 002: Populate repo identity at init emission

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-5
**Files:**
- `servers/exarchos-mcp/src/workflow/tools.ts`
- `servers/exarchos-mcp/src/workflow/tools.test.ts`
**Verification:** medium — scoped tests + kill-probe. Tests: `HandleInit_WithCwd_EmitsWorkflowStartedWithRepoRoot`, `HandleInit_NoCwdAvailable_EmitsWithoutRepoRoot`. Confirm idempotency key behavior unchanged.
**Dependencies:** 001
**Parallelizable:** No (chain A)

### Task 003: Pipeline projection carries repoRoot for the repo-scoped view

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-6
**Files:**
- `servers/exarchos-mcp/src/views/pipeline-view.ts`
- `servers/exarchos-mcp/src/views/pipeline-view.test.ts`
**Verification:** medium — scoped tests + kill-probe. Tests: `PipelineProjection_StartedWithRepoRoot_StateCarriesIt`, `PipelineProjection_StartedWithoutRepoRoot_StateUndefined`. Projection stays a pure fold (no lookups).
**Dependencies:** 002
**Parallelizable:** No (chain A)

### Task 004: Phantom entry exclusion from page and total

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-4
**Files:**
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/views/tools.pipeline.test.ts`
**Verification:** medium — scoped tests + kill-probe. Tests: `Pipeline_StreamWithoutStarted_ExcludedFromPageAndTotal`, `Pipeline_PhantomAndReal_TotalCountsOnlyReal`.
**Dependencies:** None
**Parallelizable:** Yes (chain B head)

### Task 005: Compact default entries + schema-level detail flag

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1
**Files:**
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/registry.ts`
- `servers/exarchos-mcp/src/views/tools.pipeline.test.ts`
**Verification:** high — scoped tests + kill-probe + integration suite (registry schema surface). Tests: `Pipeline_Default_OmitsTasksById`, `Pipeline_DetailTrue_IncludesTasksById`, `Pipeline_Default_CountsPresent`.
**Dependencies:** 004
**Parallelizable:** No (chain B, same file as 004)

### Task 006: Small default window + explicit paging metadata in both branches

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-2, DR-3
**Files:**
- `servers/exarchos-mcp/src/views/output-cap.ts`
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/views/output-cap.test.ts`
**Verification:** medium — scoped tests + kill-probe. Tests: `Pipeline_NoLimit_ReturnsAtMostTen`, `Pipeline_ExplicitLimit_Honored`, `Pipeline_Paging_HasMoreOffsetLimitEchoed`, `PipelineSummary_CarriesPagingMetadata`. Intentional oracle changes to existing cap assertions are enumerated (see DR-8 acceptance).
**Dependencies:** 005
**Parallelizable:** No (chain B)

### Task 007: Repo-scoped default view filtering + scope escape hatch + empty-scope affordance

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6, DR-7
**Files:**
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/views/composite.ts`
- `servers/exarchos-mcp/src/registry.ts`
- `servers/exarchos-mcp/src/views/tools.pipeline.test.ts`
**Verification:** high — scoped tests + kill-probe + integration suite. Tests: `Pipeline_DefaultScope_FiltersToCallerRepo`, `Pipeline_ScopeAll_IncludesLegacyUnscopedRows`, `Pipeline_ExplicitRepoRoot_TargetsThatRepo`, `Pipeline_ScopedEmptyUnscopedNonempty_EmitsEscapeHatchAffordance`, `Pipeline_ScopedNonempty_NoEscapeHatchHint`.
**Dependencies:** 003, 006
**Parallelizable:** No (join point)

### Task 008: Contract conformance preserved — parity + envelope sweep and registry description

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-8
**Files:**
- `servers/exarchos-mcp/src/registry.ts`
- `servers/exarchos-mcp/src/views/parity.test.ts`
**Verification:** medium — run `views/parity.test.ts`, `cli/envelope-parity.test.ts`, `parity/readonly-cap-parity.test.ts`; update the pipeline action description + affordance hint strings to the new defaults; fix any parity drift inside the shared core (never in adapters).
**Dependencies:** 007
**Parallelizable:** No

### Task 009: Documentation updates — contract conformance preserved in docs

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-8
**Files:**
- `docs/architecture/projections.md`
**Verification:** low — static analysis + `verify_doc_links`. Document the new projection field, paging contract, scoping semantics, and the legacy-row escape hatch.
**Dependencies:** 007
**Parallelizable:** Yes (with 008)

### Parallelization

Critical path: 001 → 002 → 003 → 007 → 008. Chain A (001→002→003, identity plumbing) and chain B (004→005→006, view economy) run in parallel worktrees; they touch disjoint files until the join at 007. 009 runs parallel with 008 after the join.

### Completion checklist

- [ ] Every DR-N in `## Requirements` maps to at least one task in the matrix
- [ ] Every task `Implements:` a DR-N that exists in this document
- [ ] Every task carries a `riskTier` stamp
- [ ] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [ ] Open questions are resolved OR explicitly deferred with rationale
- [ ] Ready for `plan-review`
