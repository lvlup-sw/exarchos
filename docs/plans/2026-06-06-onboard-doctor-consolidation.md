# Implementation Plan: Onboarding Consolidation — `onboard` + `doctor`

**Design:** [`docs/designs/2026-06-06-onboard-doctor-consolidation.md`](../designs/2026-06-06-onboard-doctor-consolidation.md)
**Epic:** [#1510](https://github.com/lvlup-sw/exarchos/issues/1510) (milestone v2.10.2)
**Date:** 2026-06-06
**Integration branch:** `feature/onboard-doctor-consolidation`

## Scope

**Full scope.** All 10 design requirements (DR-1…DR-10) are planned. Tasks map 1:1 to the epic's
T0–T8 decomposition. The Bundle B dependency (#1508/#1507) has landed (PR #1511), so DETECT/CONFIG
consume the layered resolver from the first task.

Iron Law: **no production code without a failing test first.** Every task below is RED → GREEN →
(REFACTOR). Characterization tests (Wave 0) are the exception in spirit — they pin *current* behavior
and pass against `main`; they are the regression oracle that guards the fold.

## Architecture targets

| Artifact | Path |
|---|---|
| Reconciler core | `servers/exarchos-mcp/src/core/onboarding/reconcile.ts` (+ `types.ts`) |
| `onboard` handler | `servers/exarchos-mcp/src/orchestrate/onboard/index.ts` |
| `doctor` handler (extend) | `servers/exarchos-mcp/src/orchestrate/doctor/index.ts` |
| Reused init writers | `servers/exarchos-mcp/src/orchestrate/init/writers/*` (verbatim) |
| Event schema | `servers/exarchos-mcp/src/event-store/schemas.ts` |
| Registry/CLI | `servers/exarchos-mcp/src/registry.ts`, `src/adapters/cli.ts` |
| Hook writer | `servers/exarchos-mcp/src/orchestrate/onboard/hooks.ts` (#1485 binding) |

---

## Dependency waves

```
Wave 0  T0/DR-9 characterization  ──┐  (guards everything; land first)
        DR-1 reconciler types     ──┤
Wave 1  DR-1 detect / diff / apply ◀┘  (sequential within; share reconcile.ts)
Wave 2  DR-7 events ─ DR-2 onboard ─ DR-4 doctor --fix ─ DR-8 hooks ─ DR-6 parity  (parallel-ish, all need Wave 1)
Wave 3  DR-3 --new + retire new-project  ‖  DR-5 remove init/install-skills + stubs
Wave 4  DR-10 error/edge hardening  ─ T8 docs/bootstrap sweep
```

---

## Wave 0 — Characterization baseline + reconciler types

### Task 001: Characterize `init` current outputs
**Goal:** Pin the exact files, MCP-registration JSON, `.exarchos.yml` seed, and `init.executed` event that `init` writes today, as the regression oracle guarding the fold.
**Phase:** RED (characterization — passes on `main`)
**Implements:** DR-9 · **Epic:** T0

1. [RED] Write `Init_CurrentOutputs_PinnedSnapshot` — run `init` in a temp repo; snapshot files
   written, MCP-registration JSON shape, `.exarchos.yml` seed, and the `init.executed` event payload.
   - File: `servers/exarchos-mcp/src/orchestrate/init/init.characterization.test.ts`
   - Expected: passes against current `main` (oracle for the fold).

**Dependencies:** None · **Parallelizable:** Yes · **testingStrategy:** characterization (snapshot)

### Task 002: Characterize `doctor` current outputs
**Goal:** Snapshot the eleven doctor checks' result shapes and the `diagnostic.executed` payload so the consolidated `doctor` provably reproduces every current diagnostic.
**Phase:** RED (characterization)
**Implements:** DR-9 · **Epic:** T0

1. [RED] `Doctor_ElevenChecks_PinnedShape` — snapshot the 11 checks' `CheckResult[]` (category/name/
   status/fix) and the `diagnostic.executed` payload for a known fixture repo.
   - File: `servers/exarchos-mcp/src/orchestrate/doctor/doctor.characterization.test.ts`

**Dependencies:** None · **Parallelizable:** Yes · **testingStrategy:** characterization (snapshot)

### Task 003: Characterize `install-skills` + `new-project` current outputs
**Goal:** Pin `install-skills`' copy/register writes and `new-project`'s scaffold including the npm-rewrite, so deleting that rewrite is provably equivalence-minus-rewrite.
**Phase:** RED (characterization)
**Implements:** DR-9 · **Epic:** T0

1. [RED] `InstallSkills_LocalCopyAndRegister_PinnedWrites` — pin the skills-dir copy targets +
   `registerExarchosInClaudeJson` write shape.
   - File: `src/install-skills.characterization.test.ts`
2. [RED] `NewProject_Scaffold_PinnedOutputsIncludingLangRewrite` — pin `new-project` scaffold incl.
   the `applyLanguageCustomizations` npm→dotnet rewrite (so its deletion is provably equivalent-minus-rewrite).
   - File: `servers/exarchos-mcp/src/orchestrate/new-project.characterization.test.ts`

**Dependencies:** None · **Parallelizable:** Yes · **testingStrategy:** characterization (snapshot)

### Task 004: Reconciler domain types
**Goal:** Define the pure reconciler domain types — `DesiredState`, `PlanStep` with its `surface` tag, `ReconcilePlan`, `ReconcileResult` — that every later task builds on.
**Phase:** RED → GREEN
**Implements:** DR-1 · **Epic:** T1

1. [RED] `ReconcileTypes_PlanStepSurface_TaggedCliOnly` — assert `PlanStep.surface` ∈ `{'any','cli-only'}`,
   `ReconcilePlan`/`ReconcileResult`/`DesiredState` shapes compile and round-trip through zod.
   - File: `servers/exarchos-mcp/src/core/onboarding/types.test.ts`
   - Expected failure: module does not exist.
2. [GREEN] Define `DesiredState`, `PlanStep` (`kind: 'config'|'generate'|'install'|'hook'`, `surface`),
   `ReconcilePlan`, `ReconcileResult`, `Advisory` + zod schemas.
   - File: `servers/exarchos-mcp/src/core/onboarding/types.ts`

**Dependencies:** None · **Parallelizable:** Yes · **testingStrategy:** unit · **propertyTests:** no

---

## Wave 1 — Reconciler core (`detect → diff → apply`)

### Task 005: `detectDesiredState` consumes the layered resolver (INV-6)
**Goal:** Implement detection that derives test/typecheck/install commands purely from the Bundle B layered resolver, never a string-rewrite, honoring INV-6 workload-agnosticism.
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-1 · **Epic:** T1

1. [RED] `DetectDesiredState_DerivesCommands_FromLayeredResolver` — given a fixture repo, `test`/
   `typecheck`/`install` in `DesiredState` come from the Bundle B resolver, **not** a string-rewrite.
   - File: `servers/exarchos-mcp/src/core/onboarding/reconcile.detect.test.ts`
   - Expected failure: `detectDesiredState` unimplemented.
2. [GREEN] Implement `detectDesiredState(repoRoot, opts)` calling `resolveTestRuntime`/toolchain resolver;
   detect runtime(s), VCS, agent host.
   - File: `servers/exarchos-mcp/src/core/onboarding/reconcile.ts`
3. [REFACTOR] Extract probe helpers; ensure no `adapters/*` import (INV-2).

**Dependencies:** 004 · **Parallelizable:** No (shares reconcile.ts with 006/007) · **testingStrategy:** unit

### Task 006: `diff` = structured doctor checks
**Goal:** Implement the diff that turns the eleven doctor checks into an executable structured plan, with a fully-configured repo diffing to an empty plan.
**Phase:** RED → GREEN
**Implements:** DR-1, DR-4 · **Epic:** T1

1. [RED] `Diff_ProducesStructuredPlan_FromDoctorChecks` — `diff(desired, actual)` returns plan steps
   equivalent to the 11 doctor checks' findings (one step per remediable Fail/Warning).
   - File: `servers/exarchos-mcp/src/core/onboarding/reconcile.diff.test.ts`
2. [RED] `Diff_NoDrift_ReturnsEmptyPlan` — a fully-configured repo diffs to an empty plan (idempotence pre-req).
3. [GREEN] Implement `diff`; map each `CheckResult` (`name`/`category`/`fix`) → executable `PlanStep`.
   - File: `servers/exarchos-mcp/src/core/onboarding/reconcile.ts`

**Dependencies:** 005 · **Parallelizable:** No · **testingStrategy:** unit · **propertyTests:** yes (empty-plan invariant)

### Task 007: `apply` composes writers + config seed (idempotent, non-destructive)
**Goal:** Implement the apply engine that composes the existing init writers and the never-overwrite config seed, idempotent and non-destructive unless `--force` is passed.
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-1, DR-10 · **Epic:** T1

1. [RED] `Apply_EmptyPlan_IsNoOp` — `apply([])` writes nothing, returns empty `applied`.
   - File: `servers/exarchos-mcp/src/core/onboarding/reconcile.apply.test.ts`
2. [RED] `Apply_HandEditedConfig_PreservedWithoutForce` — existing `.exarchos.yml` keys survive (DR-10).
3. [RED] `Apply_ForceFlag_OverwritesAndReports` — `--force` overwrites, records the overwrite in result.
4. [GREEN] Implement `apply(plan, ctx)`: route `config` steps through `seedExarchosConfig` (never-overwrite),
   `generate` steps through existing init writers, collect `applied`/`skipped`/`residual`.
   - File: `servers/exarchos-mcp/src/core/onboarding/reconcile.ts`
5. [REFACTOR] Deduplicate writer invocation paths.

**Dependencies:** 006 · **Parallelizable:** No · **testingStrategy:** unit · **propertyTests:** yes (idempotence)

---

## Wave 2 — Event contract, verbs, hooks, parity

### Task 008: Two-event contract schema (INV-1 / INV-13) — atomic widening
**Goal:** Add the `onboard.requested`/`onboard.executed` zod schemas with trigger discriminator and idempotency key, and remove `init.executed`, widening the event contract atomically.
**Phase:** RED → GREEN
**Implements:** DR-7 · **Epic:** T7

1. [RED] `EventSchema_OnboardRequestedExecuted_RoundTrips` — `onboard.requested` (plan + `trigger` ∈
   `{onboard,onboard-new,doctor-fix}` + idempotency key) and `onboard.executed` (result + key) parse;
   `init.executed` removed from the registry map.
   - File: `servers/exarchos-mcp/src/event-store/schemas.onboard.test.ts`
   - Expected failure: schemas/types absent.
2. [GREEN] Add `OnboardRequestedDataSchema` + `OnboardExecutedDataSchema`; register in the event map;
   remove `init.executed`; update any projection reading it (search + fix in the same change).
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`

**Dependencies:** 004 · **Parallelizable:** Yes (schema-only) · **testingStrategy:** unit (schema)

### Task 009: `apply` emits the two-event split + crash recovery
**Goal:** Wire the two-event split into apply so a crash between requested and executed recovers by re-diffing and applying only the residual, side-effecting at most once.
**Phase:** RED → GREEN
**Implements:** DR-7, DR-10 · **Epic:** T7

1. [RED] `Apply_NonDryRun_EmitsRequestedThenExecuted` — one `onboard.requested` before side effects,
   one `onboard.executed` after; a dry-run emits neither.
   - File: `servers/exarchos-mcp/src/core/onboarding/reconcile.events.test.ts`
2. [RED] `Apply_RequestedWithoutExecuted_RecoversResidualOnly` — simulate crash; re-run applies only the
   residual diff, emits one `executed`, no double side effect (INV-13 + INV-8 idempotency key).
3. [GREEN] Wire event emission into `apply`; the re-diff precheck reads stream tail (fresh read — not a
   CAS-pinned prior sequence) before re-emitting.
   - File: `servers/exarchos-mcp/src/core/onboarding/reconcile.ts`

**Dependencies:** 007, 008 · **Parallelizable:** No · **testingStrategy:** unit · **propertyTests:** yes (at-most-once side effect)

### Task 010: `onboard` verb handler + pipeline
**Goal:** Implement the onboard verb composing the reconciler into the detect→config→generate→install→verify pipeline, idempotent with dry-run, force, and structured output.
**Phase:** RED → GREEN
**Implements:** DR-2 · **Epic:** T2

1. [RED] `Onboard_FreshRepo_ReachesGreenDoctor` — pipeline detect→config→generate→install→verify ends
   with an empty diff (green doctor).
   - File: `servers/exarchos-mcp/src/orchestrate/onboard/index.test.ts`
2. [RED] `Onboard_Rerun_ReconcilesDriftOnly` — second run is a no-op apart from drift.
3. [RED] `Onboard_DryRun_PrintsPlanWritesNothing` — `--dry-run` returns the plan, zero writes.
4. [GREEN] Implement the handler composing the Wave-1 reconciler; INV-5b carrier (`next_actions`/`_meta`).
   - File: `servers/exarchos-mcp/src/orchestrate/onboard/index.ts`

**Dependencies:** 009 · **Parallelizable:** No · **testingStrategy:** integration

### Task 011: CLI + registry wiring for `onboard` (INV-5a/5d)
**Goal:** Register the onboard action and its schema-constrained flags on the composite tool and CLI, removing the init action while keeping the visible tool count at four.
**Phase:** RED → GREEN
**Implements:** DR-2, DR-5 · **Epic:** T2/T5

1. [RED] `Registry_OnboardAction_SchemaConstrainedFlags` — `onboard` action registered on
   `exarchos_orchestrate`; flags (`--new`/`--runtime`/`--vcs`/`--dry-run`/`--force`/`--no-hooks`/`--format`)
   emit from the Zod schema; visible composite tool count stays 4.
   - File: `servers/exarchos-mcp/src/registry.onboard.test.ts`
2. [GREEN] Register the action + schema; add CLI adapter entry; remove the `init` action.
   - Files: `servers/exarchos-mcp/src/registry.ts`, `src/adapters/cli.ts`

**Dependencies:** 010 · **Parallelizable:** No · **testingStrategy:** unit

### Task 012: SessionStart hook install — default on (#1485)
**Goal:** Install the #1485 SessionStart cross-harness binding by default with a `--no-hooks` opt-out, idempotently, plus a doctor check so `--fix` can repair it.
**Phase:** RED → GREEN
**Implements:** DR-8 · **Epic:** T2

1. [RED] `Hooks_DefaultOn_InstallsSessionStartBinding` — `onboard` (no flag) leaves the #1485 binding present.
   - File: `servers/exarchos-mcp/src/orchestrate/onboard/hooks.test.ts`
2. [RED] `Hooks_NoHooksFlag_SuppressesBinding` — `--no-hooks` ⇒ binding absent, nothing else changes.
3. [RED] `Hooks_Rerun_NoDuplicateRegistration` — idempotent (exactly one entry).
4. [GREEN] Implement the GENERATE-step hook writer; add a doctor hook-presence check so `--fix` repairs it.
   - Files: `servers/exarchos-mcp/src/orchestrate/onboard/hooks.ts`,
     `servers/exarchos-mcp/src/orchestrate/doctor/checks/agent-sessionstart-hook.ts`

**Dependencies:** 010 · **Parallelizable:** Yes (separate files) · **testingStrategy:** unit

### Task 013: `doctor --fix` over the shared `apply` (INV-5b)
**Goal:** Promote doctor's fix-hint strings to a structured plan and make `--fix` call the same apply onboard uses, so the two paths converge by construction.
**Phase:** RED → GREEN
**Implements:** DR-4 · **Epic:** T4

1. [RED] `DoctorFix_ReconcilableDrift_ConvergesWithOnboard` — `doctor --fix` repairs drift; post-fix
   re-diff clean ⇒ `onboard` on the same repo is a no-op.
   - File: `servers/exarchos-mcp/src/orchestrate/doctor/doctor-fix.test.ts`
2. [RED] `DoctorBare_NoFix_ReadOnlyEmitsDiagnosticOnly` — bare `doctor` writes nothing, emits only
   `diagnostic.executed`.
3. [GREEN] Add `fix` arg to the doctor action; `--fix` calls the same `apply` (trigger `doctor-fix`);
   re-run diff; report residuals.
   - Files: `servers/exarchos-mcp/src/orchestrate/doctor/index.ts`, `servers/exarchos-mcp/src/registry.ts`

**Dependencies:** 009, 011 · **Parallelizable:** No · **testingStrategy:** integration

### Task 014: CLI/MCP parity split — install CLI-only + MCP advisory (INV-2/INV-3)
**Goal:** Split the reconciler so detect/config/generate/verify keep CLI/MCP parity while the install step is context-gated CLI-only with a structured MCP advisory, never a silent no-op.
**Phase:** RED → GREEN
**Implements:** DR-6, DR-10 · **Epic:** T6

1. [RED] `Parity_StepsOneToThreeAndFive_IdenticalAcrossSurfaces` — extend the init parity harness:
   CLI and MCP produce identical `ToolResult` for detect/config/generate/verify given same context.
   - File: `servers/exarchos-mcp/src/orchestrate/onboard/onboard.parity.test.ts`
2. [RED] `Parity_McpInstallStep_ReturnsStructuredAdvisory` — MCP arm skips step 4, returns
   `installStep:{surface:'cli-only',advisory,commands}` with `next_actions` → CLI (not error, not silent).
3. [GREEN] Gate step 4 by `DispatchContext` surface capability (plan `surface` tag), not adapter branching;
   emit the advisory on the MCP arm.
   - Files: `servers/exarchos-mcp/src/core/onboarding/reconcile.ts`, `src/adapters/mcp.ts` (presentation only)

**Dependencies:** 010 · **Parallelizable:** No · **testingStrategy:** integration (parity)

### Task 015: skills + deps INSTALL step (CLI surface)
**Goal:** Implement the CLI-surface install step reusing install-skills' local-copy fast path with npx fallback and package-manager-detector project-dependency installation from Bundle B.
**Phase:** RED → GREEN
**Implements:** DR-2, DR-6 · **Epic:** T2/T6

1. [RED] `Install_LocalCopyFastPath_ThenNpxFallback` — install step reuses `install-skills`' local-copy
   path, falls back to `npx`; project deps via package-manager-detector (Bundle B).
   - File: `servers/exarchos-mcp/src/orchestrate/onboard/install.test.ts`
2. [GREEN] Implement the CLI-gated install step calling into the (now-shared) install logic.
   - File: `servers/exarchos-mcp/src/orchestrate/onboard/install.ts`

**Dependencies:** 014 · **Parallelizable:** No · **testingStrategy:** integration

---

## Wave 3 — Greenfield + migration removal

### Task 016: `onboard --new` greenfield (single pipeline)
**Goal:** Implement greenfield `--new` as a directory seed followed by the identical adopt pipeline, byte-equivalent to adopting an empty repo and refusing non-empty targets.
**Phase:** RED → GREEN
**Implements:** DR-3 · **Epic:** T3

1. [RED] `OnboardNew_Greenfield_ByteEquivalentToAdopt` — `onboard --new foo` ≡ `onboard` in an
   equivalently-seeded empty repo (one scaffolding path).
   - File: `servers/exarchos-mcp/src/orchestrate/onboard/new.test.ts`
2. [RED] `OnboardNew_ExistingNonEmptyDir_RefusesCleanly` — refuse, write nothing (DR-10).
3. [GREEN] Implement `--new`: create dir + initial seed (salvaged from `new-project`), then run the
   identical DR-2 pipeline; emit `onboard.requested` with `trigger:onboard-new`.
   - File: `servers/exarchos-mcp/src/orchestrate/onboard/new.ts`

**Dependencies:** 010 · **Parallelizable:** Yes (after 010) · **testingStrategy:** integration

### Task 017: Retire `new-project` + delete `applyLanguageCustomizations` (INV-6, closes #1508)
**Goal:** Delete the `new-project` handler and `applyLanguageCustomizations`, removing the last npm-as-canonical string-rewrite from the onboarding path and closing issue #1508.
**Phase:** RED → GREEN
**Implements:** DR-3 · **Epic:** T3

1. [RED] `NewProject_HandlerRemoved_NoNpmRewriteRemains` — `new_project` orchestrate action gone;
   grep for `applyLanguageCustomizations` / `npm run` rewrite returns nothing in the onboarding path.
   - File: `servers/exarchos-mcp/src/orchestrate/new-project-removed.test.ts`
2. [GREEN] Delete `new-project.ts` + `applyLanguageCustomizations`; remove the `new_project` action.
   - Files: `servers/exarchos-mcp/src/orchestrate/new-project.ts` (delete), `registry.ts`

**Dependencies:** 016 · **Parallelizable:** No · **testingStrategy:** unit (regression — characterization 003 confirms equivalence-minus-rewrite)

### Task 018: Remove `init` / `install-skills` verbs + error stubs (DR-5)
**Goal:** Replace the init and install-skills verbs with non-zero rename error stubs and dedupe the duplicated MCP-registration writer down to the single reconciler apply path.
**Phase:** RED → GREEN
**Implements:** DR-5 · **Epic:** T5

1. [RED] `InitStub_Invoked_ExitsNonZeroWithRename` — `init`/`install-skills` print
   `renamed → use 'exarchos onboard'`, exit non-zero, run no side effect.
   - File: `src/onboarding-stubs.test.ts`
2. [RED] `McpRegistration_SingleWriter_NoDuplicate` — MCP registration written by exactly one path
   (the reconciler `apply`).
3. [GREEN] Replace `init`/`install-skills` CLI verbs with error stubs; delete the duplicate
   `registerExarchosInClaudeJson` call site; route the surviving writer through `apply`.
   - Files: `src/adapters/cli.ts`, `src/install-skills.ts`, `servers/exarchos-mcp/src/orchestrate/init/index.ts`

**Dependencies:** 011, 017 · **Parallelizable:** No · **testingStrategy:** unit

---

## Wave 4 — Error/edge hardening + docs

### Task 019: Failure-mode hardening (DR-10)
**Goal:** Harden the failure modes — offline npx failure stays forward-only, residual blocking verify exits with the doctor diff, and unresolved toolchains warn without fabricating commands.
**Phase:** RED → GREEN
**Implements:** DR-10 · **Epic:** T2/T6

1. [RED] `Install_OfflineNpxFailure_ExitsNonZeroForwardOnly` — step-4 failure ⇒ non-zero, prior steps
   not rolled back, re-run resumes from residual.
   - File: `servers/exarchos-mcp/src/orchestrate/onboard/onboard.failuremodes.test.ts`
2. [RED] `Verify_ResidualBlockingFail_ExitsWithDoctorDiff` — VERIFY residual ⇒ non-zero + INV-5b error
   envelope (`suggestedFix`).
3. [RED] `Detect_UnresolvedToolchain_WarnsWritesNoFabricatedCommand` — unresolved command ⇒ warn, write
   what it can, doctor flags; no crash, no fabricated command.
4. [GREEN] Implement the three failure paths.
   - Files: `servers/exarchos-mcp/src/orchestrate/onboard/index.ts`, `reconcile.ts`

**Dependencies:** 015 · **Parallelizable:** No · **testingStrategy:** integration · **propertyTests:** no

### Task 020: Migration + docs sweep (T8)
**Goal:** Sweep the bootstrap scripts, onboarding guides, dogfood/doctor references, and the CLAUDE.md architecture note so no live surface points at the retired onboarding verbs.
**Phase:** RED → GREEN
**Implements:** DR-5 · **Epic:** T8

1. [RED] `Docs_NoStaleInitReferences_LinksResolve` — `verify_doc_links` over guides/bootstrap scripts;
   no live reference to `init`/`install-skills`/`new-project` as the onboarding path.
   - File: `servers/exarchos-mcp/src/orchestrate/docs-onboard-sweep.test.ts`
2. [GREEN] Update `scripts/get-exarchos.{sh,ps1}`, configuration/onboarding guides, `dogfood`/`doctor`
   references, the CLAUDE.md architecture note; run `npm run build:skills` + `skills:guard`.
   - Files: bootstrap scripts, `docs/guides/*`, `CLAUDE.md`, `skills-src/*`

**Dependencies:** 018 · **Parallelizable:** Yes (docs-only) · **testingStrategy:** unit (link/regression)

---

## Parallelization summary

| Wave | Parallel-safe group | Serialized because |
|---|---|---|
| 0 | 001 ‖ 002 ‖ 003 ‖ 004 | independent files |
| 1 | 005 → 006 → 007 | all mutate `reconcile.ts` |
| 2 | 008 ‖ (012 after 010); 009→010→011→{013,014}; 015 after 014 | 009/010/011 chain through reconcile + handler |
| 3 | 016 → 017; 018 after 017+011 | shared registry/writer edits |
| 4 | 019; 020 (docs) parallel-safe | 019 needs install step |

**High-blast-radius tasks** (full-suite check between merges per house convention): **008** (event
schema widening — projection-wide), **011/018** (registry + CLI surface removal), **017** (handler deletion).

## Verification (post-implementation gates)

- Per-task: `check_tdd_compliance`, `check_static_analysis` on each task branch.
- Between merges: `check_integration_suite` after 008, 011, 017, 018 (blast-radius).
- Pre-synthesis: full `npm run test:run` (root + `servers/exarchos-mcp`), `npm run typecheck`,
  `npm run lint:invariants` (INV-6 advisory), `npm run skills:guard`.
- INV-2 parity proven by Task 014; INV-13 crash recovery by Task 009; INV-6 closure by Task 017.

## Open implementation details (settle during delegate, not blockers)

- `trigger` enum surface — confirm `onboard-new` as a distinct value vs `greenfield:true` field (Task 008/009).
- Step-4 `surface` gate — reuse an existing `DispatchContext` capability flag vs introduce one (Task 014);
  confirm against the INV-11/INV-3 capability model.
