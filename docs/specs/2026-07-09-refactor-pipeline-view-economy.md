# Spec: Pipeline View Economy & Repo Scoping

**Date:** 2026-07-09 · **Feature:** `refactor-pipeline-view-economy` · **Depth:** standard · **Revision:** 2
**Inputs:** refactor brief in workflow state (`refactor-pipeline-view-economy`); live-probe evidence 2026-07-09; adversarial plan-review rounds 1 + 2 (2 voters each, refuted — all gaps addressed below); gate-audit spin-offs #1656/#1657/#1658 (out of scope here)

> One unified artifact: `## Requirements` is the DR-N source; `## Tasks` maps tasks → DR-N within this same document.
> Heading levels here intentionally diverge from `spec-template.md` (h2 Requirements / h3 tasks) — the live `check_plan_coverage` / `check_provenance_chain` parsers reject the template's h3/h4 shape; see issue #1657.

## Design & Rationale

### Problem Statement

The default `exarchos_view pipeline` response is uneconomical and unscoped. Even with the v2.12 default item cap (50, PR #1642), a no-argument call costs ~4,400 tokens: every entry inlines an unbounded `tasksById` map that is redundant with the `taskCount`/`completedCount`/`failedCount` fields beside it; roughly 10 of the first 50 entries are phantom empties (`featureId: ""`, no phase, no timestamp) produced by folding streams that never saw a `workflow.started` event; and the results mix every repository sharing the global store (261 total, mostly other projects) because no repo identity exists anywhere in the data model — not on `events`, not on `workflow_state`, not on `streams`. An agent asking "what's in flight *here*" pays thousands of tokens to read other repos' history.

### Chosen Approach

Keep the single global store and the pure left-fold projection; fix the *view contract*. Three moves: (1) make the default page small and the default entry compact, with an explicit `page` metadata object and an opt-in `detail` flag for the full task map; (2) exclude degenerate fold results from both the page and the total; (3) introduce repo identity as **event data** — an optional `repoRoot` on `workflow.started`, derived from the serving process's working directory (see Technical Design for the honest identity-source statement) and POSIX-normalized — and have the *composite layer* supply the caller's repo key so the pipeline view filters to the caller's repo by default, with a `scope: "all"` escape hatch and **always-present** scope metadata so hidden rows are perceivable, never silent. No store partitioning, no event rewriting, no backfill.

### Revision 1 changes (plan-review round 1)

Both adversarial voters refuted revision 0. Every gap is resolved in this revision:

- **Unwired identity source (HIGH):** revision 0 claimed `handleInit` reads `ctx.cwd`, but no context reaches `handleInit` (`workflow/composite.ts` init arm threads only input/stateDir/eventStore) and production adapters never populate `DispatchContext.cwd`. Now: the composite layers compute a memoized caller repo key from `ctx.cwd ?? process.cwd()` and thread it explicitly — `workflow/composite.ts` is in Task 002's files, `views/composite.ts` in Task 007's. The identity source is stated honestly below.
- **Undefined scope default / oracle blast radius (HIGH):** handler-level semantics pinned — no supplied key ⇒ **unscoped** (direct handler calls in existing tests keep today's behavior by construction); default `repo` scoping is a composite-layer contract shared by both adapters. Every known pinned oracle is enumerated in DR-8 and owned by a task: `views/composite.test.ts` (pins the handler call signature), `views/handlers.test.ts`, `src/__tests__/views/handlers.test.ts`, `views/materializer.sentinel-skip.test.ts`, both parity fixture suites, `__tests__/integration/perf-validation.test.ts`.
- **Legacy rows vanishing silently (HIGH):** perceivability is now always-on, not empty-only — `data.scope` and `data.unscopedTotal` ride on every response, and the scope-all affordance fires whenever `unscopedTotal > page.total` (mixed steady state included). New DR-9 + Task 010 update the skill flows that discover workflows via the pipeline view (shepherd stale-discovery, rehydrate, cleanup).
- **Snapshot re-fold gap (MEDIUM):** `EVENT_SCHEMA_VERSION` is bumped `'1.0' → '1.1'` so on-disk view snapshots written by pre-upgrade readers invalidate and re-fold, guaranteeing `repoRoot` reaches every projection after upgrade (Task 003, with a stale-snapshot test).
- **`hasMore` name collision + summary-branch paging (MEDIUM):** page-level paging lives in a new `data.page = { total, offset, limit, hasMore }` object in **both** branches; the per-entry `hasMore` (stack-position eviction flag) is retained untouched in compact entries; `summary.firstPage` rows are compacted and `page.hasMore = page.total > firstPage.length` there. Legacy `data.total` is kept as an alias for one release.
- **Hot-path git spawn (MEDIUM):** `deriveRepoKey` memoizes per input path (module-level map); the read side computes the key once per dispatch via the composite layer, so steady-state pipeline calls pay a map lookup, not a subprocess.
- **Explicit `repoRoot` normalization, token-budget test, spawn timeouts, ordering (LOW):** the explicit `repoRoot` argument passes through `deriveRepoKey` before comparison (worktree/Windows-form inputs match); a `estimateOutputTokens(...) < 1000` assertion operationalizes the economy criterion; git-spawning tests carry explicit per-test timeouts (repo memory: vitest 5s default flakes under load); page ordering is deterministic — `_asOf` descending, ties by `featureId` ascending.

### Revision 2 changes (plan-review round 2)

Both round-2 voters refuted revision 1, converging on one root cause plus enumeration gaps:

- **Snapshot mechanism replaced (HIGH, both voters):** revision 1 bumped the global `EVENT_SCHEMA_VERSION` to force snapshot re-folds. That constant is the *event payload* schema version driving the read-time upcasting/migration seam — events are stamped `'1.0'` by `event-factory.ts` and the Zod default in `event-store/schemas.ts`, a pinned test asserts the constant is `'1.0'`, and a bump either hollows the migration guard (all events below "current" with no registered path) or destroys the identity fast path. Worse, in the shared global store, servers on mixed plugin versions would *perpetually* invalidate each other's snapshots. Replaced with a **pipeline-view-scoped snapshot lineage**: the pipeline projection's snapshots move to a versioned snapshot name (v2), so pre-upgrade snapshot files are simply ignored by new servers and old servers keep their own lineage — no shared-file contention, no event-migration involvement, `EVENT_SCHEMA_VERSION` stays `'1.0'` (a test pins that it is untouched).
- **Skill-flow enumeration completed (MEDIUM, both voters):** checkpoint, dogfood, and prune skills also discover workflows via the pipeline view, and the checkpoint tool-reference documents the action's contract — all added to DR-9/Task 010. Prune's candidate observation switches to `scope: "all"` (stale legacy rows are exactly what default scoping hides, and prune exists to drain them).
- **CLI render snapshot owned (MEDIUM):** `__tests__/integration/cli-table-tree-regression.test.ts` snapshots the full `vw ls` output and its tree-vs-JSON branch inference flips on the new nested `page` object — added to DR-8 and Task 008.
- **`scope: "repo"` without a key pinned (LOW):** a direct handler call requesting `scope: "repo"` with neither an explicit `repoRoot` nor a composite-supplied key now returns a structured error (`suggestedFix`: pass `repoRoot` or use `scope: "all"`) instead of silently returning unscoped results.
- **Description budget owned (LOW):** the registry description update in Task 008 must stay inside the 280-token per-action budget enforced by `architecture/description-budget.test.ts` — listed in its verification.
- **Enumeration honesty (LOW):** `src/__tests__/views/pipeline-view.test.ts` and `views/composite.envelope.test.ts` were inspected and survive (non-strict equality / mocked handlers); they are listed as verified-surviving rather than claiming the enumeration was already complete. One round-2 claim was checked and discarded: `src/parity/readonly-cap-parity.test.ts` does exist at the listed path.

### Technical Design

**Identity source (stated honestly).** Production adapters do not populate `DispatchContext.cwd`; per `core/dispatch.ts` it defaults to `process.cwd()` of the long-lived server process. For a project-scoped server (the normal plugin/CLI arrangement) that is the repo the server was launched in, and `deriveRepoKey` collapses main checkout and all worktrees to one key, so write-time and read-time identities agree by construction. A future client that does thread a real `ctx.cwd` (e.g. via MCP roots) gets more precise identity through the same seam with no further change. This is the deliberate, documented v1 semantics — not an accident.

**Seams.** All behavior lands in the shared dispatch core (`views/tools.ts` `handleViewPipeline`), never the adapters. The **composite layers** own caller-identity: `workflow/composite.ts` threads `deriveRepoKey(ctx.cwd ?? process.cwd())` into `handleInit` (new optional parameter; absent ⇒ event carries no `repoRoot`, exactly today's behavior); `views/composite.ts` threads the same memoized key into `handleViewPipeline` (new optional parameter; absent ⇒ unscoped). Note the `invariants_effective` arm is **not** the precedent revision 0 claimed — it resolves `repoRoot` handler-internally via `process.cwd()`; we deliberately thread at the composite layer instead so direct handler calls (tests) stay unscoped and the contract is adapter-independent. The registry entry (`registry.ts` pipeline action) grows three optional schema fields — `detail: boolean`, `repoRoot: string`, `scope: enum['repo','all']` — and output stays inside the `EnvelopeSchema(z.unknown())` carrier, so no output-schema registration change is needed.

**Repo key derivation.** New `deriveRepoKey(path)` in `servers/exarchos-mcp/src/utils/paths.ts` (beside `toPosix`): resolve the git common root (`git rev-parse --path-format=absolute --git-common-dir`, dirname of it) so main checkout and every worktree share one identity; fall back to the canonicalized input path outside a git repo; normalize with `toPosix` + native canonicalization (Windows 8.3 expansion precedent). **Memoized** per input path in a module-level map (the server process's key is computed once). Spawns go through the existing command-runner (`runCommandSync`-family) per the Windows dynamic-spawn rule; tests that exercise the git path stamp explicit per-test timeouts.

**Event flow.** `handleInit` (`workflow/tools.ts`) accepts an optional repo key and, when present, adds `repoRoot` to `workflow.started` data. `WorkflowStartedData` (`event-store/schemas.ts`) gains the optional field. The pipeline projection (`views/pipeline-view.ts`) copies it onto `PipelineViewState` during the `workflow.started` fold — the projection remains a pure left-fold; unknown stays `undefined`.

**Snapshot lineage (projection versioning, view-scoped).** Pre-upgrade on-disk snapshots cache pipeline folds *without* `repoRoot`, and the materializer folds only delta events past the snapshot high-water mark — so without intervention the new field never reaches materialized state for old streams. Fix: the pipeline projection's snapshot identity moves to a **versioned name** (v2) at its registration seam, so new servers read/write `<streamId>.<pipeline-v2-name>.snapshot.json` and simply ignore the old files; old servers keep their own lineage untouched. This avoids the two failure modes of a version-*check* change: (a) the event-migration machinery (`EVENT_SCHEMA_VERSION`, event stamps, `assertMigrationCoverage`, the identity fast path) is completely untouched — a test pins `EVENT_SCHEMA_VERSION === '1.0'` stays as-is; (b) mixed-version servers sharing the global store cannot thrash each other's snapshots, because the two lineages use different filenames. Orphaned v1 pipeline snapshot files are inert JSON; opportunistic cleanup is deferred. First post-upgrade read pays one full re-fold per stream for this view only.

**View pipeline order.** Fold → phantom filter → terminal-phase filter (`includeCompleted`, unchanged — stays ahead of the totals exactly as today) → `unscopedTotal` computed (**pinned: post-phantom, post-terminal-filter, pre-scope-filter** — so the escape hatch never mis-attributes `includeCompleted`-hidden rows to repo scoping) → scope filter (see semantics below) → `page.total` computed → deterministic sort (`_asOf` desc, ties `featureId` asc) → offset/limit window (pipeline-specific default 10; `DEFAULT_VIEW_ITEM_CAP` stays 50 for other views) → entry compaction (strip `tasksById` unless `detail: true`; per-entry `hasMore` eviction flag retained) → `data.page` + `data.scope` + `data.unscopedTotal` + affordances. Summary branch computes its rollups from the same filtered, sorted set and compacts `firstPage` identically (via a local compact entry type in `views/tools.ts` — the `PipelineSummary`/`PipelineViewState` declarations in `views/pipeline-view.ts` stay chain-A-owned).

**Scope semantics (pinned).** Effective scope resolution inside the handler: explicit `scope: "all"` ⇒ no filter; explicit `repoRoot` ⇒ filter to `deriveRepoKey(repoRoot)`; else caller key supplied by composite ⇒ filter to it; else (direct call, no key, no explicit scope) ⇒ **unscoped**. Explicit `scope: "repo"` with neither an explicit `repoRoot` nor a caller key is a **structured error** (`suggestedFix`: supply `repoRoot` or use `scope: "all"`) — never a silent unscoped result. Legacy rows (`repoRoot === undefined`) match only the unscoped/`"all"` modes. `data.scope` reports which mode was effective (`"repo"` or `"all"`).

**Invariants preserved.** Event log stays append-only source of truth (identity enters as event data); CLI/MCP equivalence via the single handler + composite + parity suite; inputs constrained at schema level; envelope carrier fixed; affordances via `next_actions`; behavior identical for every workflow type; paths POSIX-normalized for Windows.

### Integration Points

- `servers/exarchos-mcp/src/event-store/schemas.ts` — `WorkflowStartedData` + optional `repoRoot`.
- `servers/exarchos-mcp/src/views/snapshot-store.ts` (or the projection-registration seam in `views/tools.ts`) — versioned snapshot lineage for the pipeline view.
- `servers/exarchos-mcp/src/workflow/tools.ts` + `servers/exarchos-mcp/src/workflow/composite.ts` — init emission wiring (composite computes + threads the key).
- `servers/exarchos-mcp/src/utils/paths.ts` — memoized `deriveRepoKey` helper.
- `servers/exarchos-mcp/src/views/pipeline-view.ts` — projection carries `repoRoot`.
- `servers/exarchos-mcp/src/views/tools.ts` — filter/sort/window/compaction/metadata in `handleViewPipeline`.
- `servers/exarchos-mcp/src/views/composite.ts` — thread memoized caller key.
- `servers/exarchos-mcp/src/registry.ts` — pipeline input schema + description.
- `servers/exarchos-mcp/src/views/output-cap.ts` — pipeline-specific default window constant.
- `skills-src/shepherd/SKILL.md`, `skills-src/rehydrate/SKILL.md`, `skills-src/cleanup/SKILL.md`, `skills-src/checkpoint/SKILL.md`, `skills-src/dogfood/SKILL.md`, `skills-src/prune/SKILL.md`, `skills-src/checkpoint/references/mcp-tool-reference.md` — pipeline-discovery flows learn the scoping contract.

### Alternatives considered

- **Per-repo store partitioning** — one SQLite DB per repository. Rejected: migration burden for every existing consumer, breaks cross-repo telemetry/provenance views, and the event-sourcing frame already solves scoping with a projection filter.
- **Join on `workspace.resolved` events** — infer repo identity from the workspace-discovery event. Rejected: that event is only emitted when a dispatch omitted `featureId`, so coverage is sparse and identity would be probabilistic.
- **Handler-internal `process.cwd()` fallback** (the `invariants_effective` pattern) — rejected for scoping: it would silently scope-filter every direct handler call in existing test suites and make the default adapter-dependent; composite-threading keeps direct calls unscoped and the contract uniform.
- **Clamping explicit `limit`** — rejected: explicit caller intent should be honored; the existing over-threshold summary fallback already guards against pathological payloads.
- **Backfilling `repoRoot` onto historical events** — rejected outright: violates the append-only event log.

### Open Questions

- Draining the ~261-row legacy inventory: the prune verb exists but hard-aborts without a topology file (#1545). **Deferred** — scoping plus the always-on `unscopedTotal` signal removes the day-to-day pain while keeping the legacy set discoverable via `scope: "all"`.
- Whether other views (`tasks`, `workflow_status`, `worktrees`) should adopt the same repo scoping. **Deferred** — this spec establishes the identity field, the composite-threading seam, and the pattern; follow-on adoption is mechanical and better done per-view with its own oracle updates.

## Requirements

The DR-N identifiers below are the single source the decomposition traces against.

### DR-1: Compact default entries

By default, pipeline entries omit the per-task `tasksById` map and carry only summary fields: `featureId`, `workflowType`, `phase`, `taskCount`, `completedCount`, `failedCount`, `stackPositions`, `hasMore` (the existing per-entry stack-position eviction flag — retained, unrelated to paging), `_asOf`, and the new optional `repoRoot`. A schema-level boolean `detail` parameter restores the full task map.

**Acceptance criteria:**
- Default call returns entries without `tasksById`; `detail: true` returns them with it.
- The per-entry `hasMore` eviction flag survives compaction (pinned by existing pipeline-view tests).
- The `detail` flag is declared in the Zod input schema (auto-emits the CLI flag) — not a prose hint.
- Counts remain present and correct in both modes; `summary.firstPage` rows are compacted identically.

### DR-2: Small default window

When `limit` is omitted, the pipeline action returns at most 10 entries. An explicit `limit` is honored as today. The worktrees view's shared default cap is untouched.

**Acceptance criteria:**
- Omitted `limit` → ≤10 entries; explicit `limit: 50` → up to 50.
- Economy is operationalized: a test asserts `estimateOutputTokens` of the default-call payload (seeded with representative many-task workflows) stays under 1,000.
- The over-threshold summary fallback (byPhase/byWorkflowType rollup) still functions.

### DR-3: Explicit paging metadata

The `data` payload carries a `page` object — `{ total, offset, limit, hasMore }` — in **both** the detail branch and the summary branch, namespaced so it cannot collide with the per-entry `hasMore` eviction flag. Ordering is deterministic so pages are stable: `_asOf` descending, ties by `featureId` ascending. Legacy `data.total` stays as an alias this release. The narrow `next_actions` paging affordance is retained.

**Acceptance criteria:**
- Detail branch: `page.total` reflects the filtered, scoped set; `page.hasMore === offset + workflows.length < page.total`; `offset`/`limit` echo effective values (including the default limit when omitted).
- Summary branch: same `page` object; `page.hasMore === page.total > firstPage.length`.
- Two consecutive calls with `offset: 0` and `offset: 10` partition the same sorted sequence (deterministic-order test).
- Envelope top-level keys are unchanged (`success`/`data`/`next_actions`/`_meta`/`_perf`).

### DR-4: Phantom exclusion

Fold results lacking a `workflow.started` foundation (empty `featureId`) never appear in the page and never count toward `page.total` or `unscopedTotal`, in any scope mode.

**Acceptance criteria:**
- Given a stream that produces an empty-`featureId` fold, the pipeline response contains no empty entry and no total counts it.
- Exclusion applies identically under `scope: "all"` and default scoping.

### DR-5: Repo identity recorded at init

`workflow.started` event data gains an **optional** `repoRoot` field, populated when the composite layer supplies a repo key: `workflow/composite.ts` computes `deriveRepoKey(ctx.cwd ?? process.cwd())` (the documented `DispatchContext.cwd` default — the serving process's directory; see Technical Design identity-source statement) and threads it into `handleInit` as a new optional parameter. `deriveRepoKey` uses the git common root so all worktrees of one repo share identity, falls back to the canonicalized path outside git, is POSIX-normalized, and is memoized. Historical events remain valid; no existing event is modified. The pipeline view's materialized state picks the field up via the versioned snapshot lineage (v2 snapshot name); the event-migration machinery and `EVENT_SCHEMA_VERSION` stay untouched.

**Acceptance criteria:**
- Production path proven end-to-end: a composite-level `init` dispatch (not a direct `handleInit` call) emits `workflow.started` with `repoRoot` — a test exercises the composite arm.
- Direct `handleInit` calls without the new parameter emit exactly today's event shape.
- Events without `repoRoot` still parse (optional field); reducers treat them as unscoped.
- Identity is stable across git worktrees of the same repository and across Windows/POSIX path forms.
- A pre-upgrade pipeline snapshot (v1 lineage) is ignored and the stream fully re-folded under the v2 lineage (stale-snapshot test); `EVENT_SCHEMA_VERSION` remains `'1.0'` (pinned test untouched) and no event-migration code changes.

### DR-6: Repo-scoped default view

Scope resolution in the shared handler, pinned: explicit `scope: "all"` ⇒ unfiltered; explicit `repoRoot` param ⇒ filter to `deriveRepoKey(repoRoot)` (normalized before comparison); else composite-supplied caller key ⇒ filter to it; else (direct handler call, no key) ⇒ unscoped. Legacy rows (no `repoRoot`) appear only in unfiltered modes. Default scoping is therefore a composite-layer contract shared identically by CLI and MCP.

**Acceptance criteria:**
- A workflow started in repo A does not appear in repo B's default (composite-dispatched) pipeline view.
- `scope: "all"` reproduces the full cross-repo inventory (minus phantoms).
- An explicit `repoRoot` given as a worktree path or Windows-form path still matches (normalization test).
- Direct handler calls without a caller key and without explicit scope return unscoped results (existing suites' semantics preserved by construction).
- Explicit `scope: "repo"` with no resolvable key returns a structured error with a `suggestedFix`, never silent unscoped results.
- Both parameters are schema-declared (CLI flags auto-emit).

### DR-7: Always-on scope perceivability

Every pipeline response reports `data.scope` (effective mode) and `data.unscopedTotal` (**post-phantom, post-terminal-filter, pre-scope-filter** count — completed/cancelled rows hidden by `includeCompleted` are never attributed to scoping). Whenever `unscopedTotal > page.total` — scoped-empty **and** mixed steady state alike — `next_actions` carries a scope-all escape-hatch hint including the hidden count. Hidden rows are never silent.

**Acceptance criteria:**
- Scoped-empty + unscoped-nonempty → escape-hatch hint with count.
- Scoped-nonempty with additional hidden rows → hint still present (mixed-state test).
- `scope: "all"` → no escape-hatch hint (nothing hidden); normal paging affordance only — and this test seeds **completed** workflows to prove terminal-filtered rows don't trigger the hint (ordering guard).

### DR-8: Contract conformance preserved

CLI/MCP parity, envelope shape, pinned oracles, and registry documentation stay conformant. The known pinned suites — verified across two adversarial review rounds — are owned by tasks: `views/output-cap.test.ts`, `views/tools.pipeline.test.ts`, `views/pipeline-view.test.ts`, `views/composite.test.ts` (pins the `handleViewPipeline` call signature), `views/handlers.test.ts`, `src/__tests__/views/handlers.test.ts`, `views/materializer.sentinel-skip.test.ts`, `views/parity.test.ts`, `parity/readonly-cap-parity.test.ts`, `cli/envelope-parity.test.ts`, `__tests__/integration/perf-validation.test.ts` (105-call median budget — verifies the memoized key adds no per-call spawn), `__tests__/integration/cli-table-tree-regression.test.ts` + its `.snap` (full `vw ls` render snapshot whose tree-vs-JSON inference flips on the nested `page` object). Verified-surviving without edits: `src/__tests__/views/pipeline-view.test.ts` (non-strict equality), `views/composite.envelope.test.ts` (mocked handlers), `__tests__/integration/cli-parity.test.ts` (normalized envelope comparison carries the new fields symmetrically on both arms), `__tests__/mcp-tools.integration.test.ts` (`data.total` alias retained; its in-process init/view key symmetry is additionally pinned by `Pipeline_CompositeDispatch_FiltersToCallerRepo`). `views/materializer.bench.ts` consumes the `PIPELINE_VIEW` constant and tracks it automatically (benchmark baselines pin no pipeline entries).

**Acceptance criteria:**
- All suites above green post-change; parity byte-identical between CLI and MCP.
- Registry `pipeline` action description documents paging + scoping within the 280-token per-action budget enforced by `architecture/description-budget.test.ts`; affordance hint strings match the new defaults.
- Intentional oracle changes are enumerated in the PR body (oracle-integrity note), never silent.

### DR-9: Skill flows updated for scoped discovery

The skill flows that discover workflows through the pipeline view learn the new contract: shepherd's stale-workflow discovery and prune's candidate observation (both of which must see *legacy* rows — precisely the hidden ones) use `scope: "all"`; rehydrate, cleanup, checkpoint, and dogfood discovery prose documents default repo scoping and the `unscopedTotal` signal; the checkpoint tool-reference documents the action's new parameters and `page`/`scope` payload fields.

**Acceptance criteria:**
- `skills-src/shepherd/SKILL.md`, `skills-src/rehydrate/SKILL.md`, `skills-src/cleanup/SKILL.md`, `skills-src/checkpoint/SKILL.md`, `skills-src/dogfood/SKILL.md`, `skills-src/prune/SKILL.md`, `skills-src/checkpoint/references/mcp-tool-reference.md` updated; `npm run build:skills` output committed; `npm run skills:guard` green.
- Skill-snapshot baselines updated per the dual-baseline procedure.

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
| DR-5 | Repo identity recorded at init | 001, 002, 003 |
| DR-6 | Repo-scoped default view | 003, 007 |
| DR-7 | Always-on scope perceivability | 007 |
| DR-8 | Contract conformance preserved | 008, 009 |
| DR-9 | Skill flows updated for scoped discovery | 010 |

## Tasks

Each task carries a `riskTier` stamp that selects its verification depth.
Tests are judged **test-after by adequacy** — the failing-test-first ordering ceremony is not required.

### Task 001: Record repo identity — optional repoRoot on WorkflowStartedData + memoized deriveRepoKey helper

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-5
**Files:**
- `servers/exarchos-mcp/src/event-store/schemas.ts`
- `servers/exarchos-mcp/src/utils/paths.ts`
- `servers/exarchos-mcp/src/event-store/schemas.test.ts`
- `servers/exarchos-mcp/src/utils/paths.test.ts`
**Verification:** high — scoped tests + `check_test_adequacy` kill-probe + integration suite (schema surface). Tests: `WorkflowStartedData_WithRepoRoot_Parses`, `WorkflowStartedData_WithoutRepoRoot_StillParses`, `DeriveRepoKey_WorktreePath_MatchesMainCheckoutKey`, `DeriveRepoKey_NonGitPath_FallsBackToNormalizedPath`, `DeriveRepoKey_WindowsSeparators_ReturnsPosix`, `DeriveRepoKey_RepeatedCall_UsesMemo` (spawn counted once). Git-spawning tests stamp explicit per-test timeouts (≥15s) per the vitest spawn-flake memory.
**Dependencies:** None
**Parallelizable:** Yes (chain A head)

### Task 002: Populate repo identity at init emission through the composite wiring

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-5
**Files:**
- `servers/exarchos-mcp/src/workflow/tools.ts`
- `servers/exarchos-mcp/src/workflow/composite.ts`
- `servers/exarchos-mcp/src/workflow/tools.test.ts`
- `servers/exarchos-mcp/src/workflow/composite.test.ts`
**Verification:** medium — scoped tests + kill-probe. Tests: `HandleWorkflow_InitDispatch_EmitsWorkflowStartedWithRepoRoot` (composite arm — the production path, closing the built-but-unwired gap), `HandleInit_WithRepoKeyParam_EmitsRepoRoot`, `HandleInit_NoRepoKey_EmitsLegacyShape`. Confirm idempotency key behavior unchanged.
**Dependencies:** 001
**Parallelizable:** No (chain A)

### Task 003: Pipeline projection carries repoRoot + versioned snapshot lineage for re-fold

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-5, DR-6
**Files:**
- `servers/exarchos-mcp/src/views/pipeline-view.ts`
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/views/snapshot-store.ts`
- `servers/exarchos-mcp/src/views/pipeline-view.test.ts`
- `servers/exarchos-mcp/src/views/snapshot-store.test.ts`
**Verification:** medium — scoped tests + kill-probe. Tests: `PipelineProjection_StartedWithRepoRoot_StateCarriesIt`, `PipelineProjection_StartedWithoutRepoRoot_StateUndefined`, `PipelineSnapshot_V1LineageFile_IgnoredAndFullyRefolded`, `PipelineSnapshot_WritesV2LineageName`, `EventSchemaVersion_Untouched_Remains1_0` (guards against the round-2 refuted mechanism). Implementation constraint (pinned round 3): use an **optional snapshot-namespace parameter on the snapshot store** — do NOT rename the registration string, so the `'pipeline'` projection name, `BUILTIN_VIEW_NAMES` in `views/registry.ts`, and every name-keyed consumer (materializer lookup, `materializer.bench.ts`, telemetry) stay untouched by construction. Do NOT touch `event-store/event-migration.ts`, event stamps, or the global schema-version check. Projection stays a pure fold (no lookups).
**Dependencies:** 002
**Parallelizable:** No (chain A)

### Task 004: Phantom entry exclusion from page and totals

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-4
**Files:**
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/views/tools.pipeline.test.ts`
**Verification:** medium — scoped tests + kill-probe. Tests: `Pipeline_StreamWithoutStarted_ExcludedFromPageAndTotals`, `Pipeline_PhantomAndReal_TotalsCountOnlyReal`.
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
**Verification:** high — scoped tests + kill-probe + integration suite (registry schema surface). Tests: `Pipeline_Default_OmitsTasksById`, `Pipeline_DetailTrue_IncludesTasksById`, `Pipeline_Default_CountsPresent`, `Pipeline_CompactEntry_RetainsEvictionHasMore`, `PipelineSummary_FirstPage_Compacted`.
**Dependencies:** 004
**Parallelizable:** No (chain B, same file as 004)

### Task 006: Small default window + explicit paging metadata page object + deterministic ordering

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-2, DR-3
**Files:**
- `servers/exarchos-mcp/src/views/output-cap.ts`
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/views/output-cap.test.ts`
**Verification:** medium — scoped tests + kill-probe. Tests: `Pipeline_NoLimit_ReturnsAtMostTen`, `Pipeline_ExplicitLimit_Honored`, `Pipeline_PageObject_TotalOffsetLimitHasMore`, `PipelineSummary_PageObject_HasMoreFromFirstPage`, `Pipeline_ConsecutiveOffsets_PartitionSortedSequence` (deterministic `_asOf`-desc order), `Pipeline_DefaultCall_UnderTokenBudget` (`estimateOutputTokens` < 1000). Intentional oracle changes to existing cap assertions are enumerated per DR-8.
**Dependencies:** 005
**Parallelizable:** No (chain B)

### Task 007: Repo-scoped default view filtering + always-on scope perceivability

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6, DR-7
**Files:**
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/views/composite.ts`
- `servers/exarchos-mcp/src/registry.ts`
- `servers/exarchos-mcp/src/views/tools.pipeline.test.ts`
- `servers/exarchos-mcp/src/views/composite.test.ts`
- `servers/exarchos-mcp/src/views/handlers.test.ts`
- `servers/exarchos-mcp/src/__tests__/views/handlers.test.ts`
- `servers/exarchos-mcp/src/views/materializer.sentinel-skip.test.ts`
**Verification:** high — scoped tests + kill-probe + integration suite. Tests: `Pipeline_CompositeDispatch_FiltersToCallerRepo`, `Pipeline_DirectHandlerNoKey_Unscoped` (pins the by-construction test-compat semantics), `Pipeline_ScopeRepoWithoutKey_ReturnsStructuredError` (never silent unscoped), `Pipeline_ScopeAll_IncludesLegacyUnscopedRows`, `Pipeline_ExplicitRepoRoot_NormalizedBeforeMatch` (worktree + Windows-form inputs), `Pipeline_MixedState_EmitsScopeAllHintWithHiddenCount`, `Pipeline_ScopeAll_NoEscapeHatchHint`, `Pipeline_Data_CarriesScopeAndUnscopedTotal`. Update the enumerated pinned oracles (composite call-signature pin, handlers suites, sentinel-skip) as intentional changes.
**Dependencies:** 003, 006
**Parallelizable:** No (join point)

### Task 008: Contract conformance preserved — parity fixtures, perf budget, registry description

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-8
**Files:**
- `servers/exarchos-mcp/src/registry.ts`
- `servers/exarchos-mcp/src/views/parity.test.ts`
- `servers/exarchos-mcp/src/parity/readonly-cap-parity.test.ts`
- `servers/exarchos-mcp/src/cli/envelope-parity.test.ts`
- `servers/exarchos-mcp/src/__tests__/integration/perf-validation.test.ts`
- `servers/exarchos-mcp/src/__tests__/integration/cli-table-tree-regression.test.ts`
**Verification:** medium — run all six suites plus `architecture/description-budget.test.ts`; adjust parity fixtures for the scoped default (seed rows with the caller's repo key or pass `scope: "all"` explicitly so cap assertions stay meaningful); regenerate the `vw ls` render snapshot and confirm the intended tree-vs-JSON branch for the new nested `page` shape; verify the 105-call median stays under budget (memoization proof); update the pipeline action description + affordance hint strings within the 280-token action budget; fix any parity drift inside the shared core (never in adapters).
**Dependencies:** 007
**Parallelizable:** No

### Task 009: Documentation updates — contract conformance preserved in docs

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-8
**Files:**
- `docs/architecture/projections.md`
**Verification:** low — static analysis + `verify_doc_links`. Document the new projection field, the identity-source semantics (server-process cwd, worktree-collapsing key), the page object, scoping semantics, `unscopedTotal`, and the legacy-row escape hatch.
**Dependencies:** 007
**Parallelizable:** Yes (with 008)

### Task 010: Skill flows updated for scoped discovery — shepherd, rehydrate, cleanup

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-9
**Files:**
- `skills-src/shepherd/SKILL.md`
- `skills-src/rehydrate/SKILL.md`
- `skills-src/cleanup/SKILL.md`
- `skills-src/checkpoint/SKILL.md`
- `skills-src/dogfood/SKILL.md`
- `skills-src/prune/SKILL.md`
- `skills-src/checkpoint/references/mcp-tool-reference.md`
**Verification:** medium — shepherd's stale-workflow discovery AND prune's candidate observation switch to `scope: "all"` (stale legacy rows are exactly the hidden ones; prune exists to drain them); rehydrate/cleanup/checkpoint/dogfood discovery prose documents default repo scoping + `unscopedTotal`; the checkpoint tool-reference documents the new parameters and payload fields. Run `npm run build:skills`, commit regenerated `skills/` + `command-aliases/`, `npm run skills:guard` green, and update skill-snapshot baselines per the dual-baseline procedure.
**Dependencies:** 007
**Parallelizable:** Yes (with 008/009)

### Parallelization

Critical path: 001 → 002 → 003 → 007 → 008. Chain A (001→002→003, identity plumbing) and chain B (004→005→006, view economy) run in parallel worktrees. One known overlap: Task 003's snapshot-lineage registration touches `views/tools.ts` (the registration line only), which chain B also edits — the orchestrator merges chain B before chain A's 003, or resolves the one-line registration conflict at the 007 join. 008, 009, and 010 run in parallel after the join.

### Completion checklist

- [ ] Every DR-N in `## Requirements` maps to at least one task in the matrix
- [ ] Every task `Implements:` a DR-N that exists in this document
- [ ] Every task carries a `riskTier` stamp
- [ ] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [ ] Open questions are resolved OR explicitly deferred with rationale
- [ ] Ready for `plan-review`
