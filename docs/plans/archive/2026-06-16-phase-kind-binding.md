# Implementation Plan: Phase-Kind Binding (steps 1–2)

- **Date:** 2026-06-16
- **Design:** `docs/designs/2026-06-16-phase-kind-binding.md`
- **Epic:** #1546 — slices S1 (#1547) + S2 (#1548)
- **Integration branch:** `feature/phase-kind-binding`
- **Scope declaration:** **Partial epic.** Implements DR-1..DR-7 (foundation + ladder on every IMPLEMENT phase). Defers S3 (#1549, PLAN/REVIEW/SYNTHESIZE migration off playbooks) and S4 (#1550, POLA capability bundle + resolve-then-freeze events). The `posture` field is authored in the table (DR-1) but stays inert.

## Working directory

All paths are under `servers/exarchos-mcp/src/`. New module: `workflow/phase-kind.ts` (+ co-located `workflow/phase-kind.test.ts`).

## Phase-kind classification (locked by DR-2's characterization test)

**Correctness-critical (must be `IMPLEMENT` — these drive S2):**

| State | HSM | Kind |
|---|---|---|
| `delegate` | feature | IMPLEMENT |
| `overhaul-delegate` | refactor | IMPLEMENT |
| `debug-implement` | debug | IMPLEMENT |
| `hotfix-implement` | debug | IMPLEMENT |
| `polish-implement` | refactor | IMPLEMENT |
| `implementing` | oneshot | IMPLEMENT |

**Remaining atomic states (exact kind locked but behavior-inert in S1+S2 — only IMPLEMENT is wired):**

| Kind | States |
|---|---|
| PLAN | `plan`, `plan-review` (feature); `rca`, `design` (debug); `brief`, `overhaul-plan`, `overhaul-plan-review` (refactor); `plan` (oneshot) |
| REVIEW | `review` (feature); `debug-validate`, `debug-review`, `hotfix-validate` (debug); `polish-validate`, `overhaul-review` (refactor) |
| SYNTHESIZE | `synthesize` (feature/debug/refactor/oneshot); `merge-pending` (feature) |
| GATHER | `ideate`, `blocked` (feature); `triage`, `investigate` (debug); `explore` (refactor); `gathering`, `synthesizing` (discovery); `polish-update-docs`, `overhaul-update-docs` (refactor) |

`compound` container states (`implementation`, `thorough-track`, `hotfix-track`, `polish-track`, `overhaul-track`) and `final` states (`completed`, `cancelled`) are **exempt** — they are not phases an agent occupies and carry no obligations. **Decision:** make `State` a discriminated union so `kind` is required on `type: 'atomic'` states only (compound/final exempt). `merge-pending`, the `*-validate`, `*-update-docs`, and `synthesizing` classifications are the spike §10 granularity-tension cases — locked here, revisited in S3.

---

## Tasks

### Task 001: Define the new phase-kind discriminated union and the frozen kind obligations table module

**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR
**Risk tier:** high · **boundaryTouching:** true (new shared type contract) · **testingStrategy:** example + type-level · **propertyTests:** no · **benchmarks:** no

1. [RED] `workflow/phase-kind.test.ts`
   - `KindObligations_EveryKind_HasARow` — assert `Object.keys(KIND_OBLIGATIONS).sort()` equals `['GATHER','IMPLEMENT','PLAN','REVIEW','SYNTHESIZE']`.
   - `KindObligations_ImplementRow_PointsAtVerificationLadder` — `KIND_OBLIGATIONS.IMPLEMENT.gates?.resolver === 'verification-ladder'`.
   - `KindObligations_GatherRow_HasNullGates` — `KIND_OBLIGATIONS.GATHER.gates === null`.
   - Expected failure: module/table does not exist.
2. [GREEN] `workflow/phase-kind.ts` — `export type PhaseKind = 'IMPLEMENT' | 'PLAN' | 'REVIEW' | 'SYNTHESIZE' | 'GATHER'`; `interface PhaseObligations { readonly gates: { readonly resolver: string } | null; readonly posture: 'read-only' | 'task-isolated' | 'shared-mutating' }`; `export const KIND_OBLIGATIONS = { … } as const satisfies Record<PhaseKind, PhaseObligations>`. Posture: IMPLEMENT→task-isolated, PLAN/REVIEW/GATHER→read-only, SYNTHESIZE→shared-mutating.
3. [REFACTOR] Add a `// no workflow names / phase ids / transitions here` invariant comment; confirm INV-6 lint clean.

**Acceptance:** table compiles only when all kinds present (removing a row → `tsc --noEmit` error); no workflow/phase literals in the module.
**Dependencies:** None · **Parallelizable:** No (foundation)

---

### Task 002: Implement the resolve-gate-set resolver delegating to the verification ladder behind implement

**Implements:** DR-3
**Phase:** RED → GREEN → REFACTOR
**Risk tier:** high · **boundaryTouching:** false · **testingStrategy:** example (table-driven parity matrix) · **propertyTests:** yes (parity over full tier × boundary product) · **benchmarks:** no

1. [RED] `workflow/phase-kind.test.ts`
   - `ResolveGateSet_Implement_MatchesVerificationPolicy` — for every `(riskTier ∈ low|medium|high) × (boundaryTouching ∈ false|true)`, assert `resolveGateSet('IMPLEMENT', ctx)` deep-equals `resolveVerificationPolicy(riskTier, boundaryTouching, ctx.config).sequence`.
   - `ResolveGateSet_Gather_ReturnsEmpty` — `resolveGateSet('GATHER', ctx)` returns `[]`.
   - `ResolveGateSet_UnknownResolverName_AssertsNever` — dispatch exhaustiveness compile guard.
   - Expected failure: `resolveGateSet` not implemented.
2. [GREEN] In `workflow/phase-kind.ts`: `export function resolveGateSet(kind: PhaseKind, ctx: { riskTier: RiskTier; boundaryTouching: boolean; config?: ResolvedProjectConfig }): readonly GateName[]`. Read `KIND_OBLIGATIONS[kind].gates`; `null → []`; switch on `gates.resolver`: `'verification-ladder' → resolveVerificationPolicy(ctx.riskTier, ctx.boundaryTouching, ctx.config).sequence`; default `assertNever`. PLAN/REVIEW/SYNTHESIZE resolver names registered but throw `not-yet-wired` (inert; S3) — guarded so they are never reached at an IMPLEMENT boundary.
3. [REFACTOR] Extract `GATE_RESOLVERS` map keyed by resolver-name for S3 extensibility.

**Acceptance:** `resolveGateSet('IMPLEMENT')` byte-identical to today's resolver across all six cells; lives in shared core (no adapter import).
**Dependencies:** Task 001 · **Parallelizable:** Yes (with Task 003 — disjoint files)

---

### Task 003: Make the state type a discriminated union and tag every atomic state with its kind

**Implements:** DR-2
**Phase:** RED → GREEN → REFACTOR
**Risk tier:** high · **boundaryTouching:** true (shared `State` schema reshape) · **testingStrategy:** example (full characterization map) · **propertyTests:** no · **benchmarks:** no

1. [RED] `workflow/hsm-definitions.test.ts` (or co-located characterization test)
   - `HsmStates_EveryAtomicState_CarriesKind` — across all five HSM factories, every state with `type === 'atomic'` has a defined `kind`.
   - `HsmStates_ImplementSnowflakes_AllTaggedImplement` — `delegate`, `overhaul-delegate`, `debug-implement`, `hotfix-implement`, `polish-implement`, `implementing` each `kind === 'IMPLEMENT'`.
   - `HsmStates_KindMap_MatchesLockedClassification` — full `state→kind` assertion per the table above.
   - Expected failure: `kind` field does not exist on `State`.
2. [GREEN] `workflow/state-machine.ts` — make `State` a discriminated union: `atomic` variant requires `kind: PhaseKind`; `compound`/`final` variants have no `kind`. `workflow/hsm-definitions.ts` — add `kind` to every atomic state per the locked table.
3. [REFACTOR] Confirm no transition/guard/`next_actions` diff; `tsc --noEmit` proves every atomic state is tagged (untagged → compile error).

**Acceptance:** untagged atomic state is a compile error; characterization map green; zero behavior change (transitions/guards untouched).
**Dependencies:** Task 001 · **Parallelizable:** Yes (with Task 002)

---

### Task 004: Route every implement phase boundary through the shared gate-set resolver call

**Implements:** DR-4
**Phase:** RED → GREEN → REFACTOR
**Risk tier:** high · **boundaryTouching:** false · **testingStrategy:** example (per-phase reachability) · **propertyTests:** no · **benchmarks:** no

1. [RED] `orchestrate/prepare-delegation.test.ts` + new `workflow/implement-obligations.test.ts`
   - `ImplementObligations_DelegatePhase_Unchanged` — `feature:delegate` medium-tier resolves the same sequence as before (behavior-neutral for the already-covered phase).
   - `ImplementObligations_DebugImplement_ResolvesLadder` — a `medium`-tier `debug-implement` task resolves the same sequence as a `medium`-tier `delegate` task.
   - Same for `hotfix-implement`, `polish-implement`, `oneshot:implementing`.
   - `ImplementObligations_HighTierBoundary_IncludesIntegrationSuite` — high-tier boundary-touching IMPLEMENT phase includes `check_integration_suite` + boundary gates (proves #1537 reach).
   - Expected failure: non-delegate implement phases don't call the resolver.
2. [GREEN] Introduce `resolveImplementObligations(ctx)` wrapping `resolveGateSet('IMPLEMENT', ctx)`. Replace the direct `resolveVerificationPolicy` call in `prepare-delegation.ts` with it (behavior-neutral). Surface the resolved sequence as the verification obligation in the implement-phase playbook guidance for `debug-implement`/`hotfix-implement`/`polish-implement`/`implementing` (the same surface that holds the TDD prose today). For `oneshot:implementing` (no prepare step), call the resolver at phase-entry guidance generation (advisory per Task 006).
3. [REFACTOR] Collapse duplicate obligation-surfacing into one helper shared by all implement phases.

**Acceptance:** every IMPLEMENT phase resolves the `feature:delegate` sequence for an equal task profile; no implement phase reaches its work step without a recorded `resolveGateSet` result.
**Dependencies:** Tasks 002, 003 · **Parallelizable:** No (integration point)

---

### Task 005: Delete the hardcoded mandatory test-first prose from every implement-phase playbook entry

**Implements:** DR-5
**Phase:** RED → GREEN → REFACTOR
**Risk tier:** medium · **boundaryTouching:** false · **testingStrategy:** example (prose guard) · **propertyTests:** no · **benchmarks:** no

1. [RED] `workflow/playbooks.test.ts`
   - `Playbooks_ImplementPhases_NoMandatoryTddProse` — assert no implement-phase playbook string matches `/write failing test first|fixing without a failing test|TDD rules remain mandatory/i`.
   - `Playbooks_ImplementPhases_RetainTransitionAndEscalation` — each implement playbook still names its correct transition target + escalation rule.
   - Expected failure: prose still present at `playbooks.ts:728/791/955/1288`.
2. [GREEN] Remove the mandatory failing-test-first prose from `debug-implement` (`:728`), `hotfix-implement` (`:791`), `polish-implement` (`:955`), `oneshot:implementing` (`:1288`). Keep scope/escalation/transition guidance; the verification obligation now flows from Task 004.
3. [REFACTOR] None expected.

**Acceptance:** no implement playbook carries mandatory TDD prose; transition/escalation fields unchanged (characterization green).
**Dependencies:** Task 004 · **Parallelizable:** No (same file region as Task 004's playbook edits)

---

### Task 006: Thread per-workflow severity and the audit-to-enforce graduation mode through the obligation surface

**Implements:** DR-6
**Phase:** RED → GREEN → REFACTOR
**Risk tier:** high · **boundaryTouching:** false · **testingStrategy:** example · **propertyTests:** no · **benchmarks:** no

1. [RED] `workflow/implement-obligations.test.ts`
   - `ImplementSeverity_Oneshot_Advisory` — a failing ladder gate on `oneshot:implementing` is advisory (proceeds, finding surfaced).
   - `ImplementSeverity_FeatureDebugRefactor_Blocking` — same failure on `debug-implement`/`delegate`/`polish-implement` blocks.
   - `ImplementMode_AuditMode_DoesNotBlock` — in audit mode a failing gate emits a finding event without blocking the transition.
   - `ImplementOverride_ReviewGatesConfig_AppliesToImplementPhases` — a `.exarchos.yml review.gates.<gate>` override changes the resolved sequence for IMPLEMENT phases identically to `feature:delegate`.
   - Expected failure: severity/mode not honored on newly-covered phases.
2. [GREEN] Thread per-workflow severity (advisory: oneshot; blocking: feature/debug/refactor) and a per-binding `mode: 'audit' | 'enforce'` through the obligation surface; newly-covered phases default to audit. Reuse the existing `review.gates.*` override (config already resolved via `resolveVerificationPolicy`).
3. [REFACTOR] Centralize the severity map next to `KIND_OBLIGATIONS` consumers (not in the kind table — severity is workflow-specific, not kind-universal; keep it out of `KIND_OBLIGATIONS` to preserve INV-6).

**Acceptance:** oneshot advisory vs feature/debug/refactor blocking; audit-mode non-blocking; config override parity with delegate.
**Dependencies:** Task 004 · **Parallelizable:** Yes (with Task 007 — disjoint test/impl regions)

---

### Task 007: Make gate resolution fail closed and guard the visible tool ceiling (error and edge cases)

**Implements:** DR-7
**Phase:** RED → GREEN → REFACTOR
**Risk tier:** high · **boundaryTouching:** false · **testingStrategy:** example (error injection + structural assertion) · **propertyTests:** no · **benchmarks:** no

1. [RED]
   - `workflow/implement-obligations.test.ts` → `ResolveGateSet_ResolverThrows_AppendsPhaseBlocked` — inject a resolver error at a phase boundary; assert a `phase.blocked` event with a visible skip reason is appended and the transition does **not** proceed.
   - `workflow/phase-kind.test.ts` → `ResolveGateSet_NoConfigOverride_FallsBackToBaseTable` — absent config resolves the frozen base table (no throw).
   - `registry.test.ts` → `Registry_VisibleToolCount_UnchangedByPhaseKind` — visible MCP tool count and top-level CLI verbs are unchanged (phase-kind registry is internal).
   - Expected failure: errors propagate / silent proceed; (the tool-count guard should pass already and acts as a regression fence).
2. [GREEN] Wrap the boundary resolver call: on throw, append `phase.blocked` (fail-closed, single-machine `failurePolicy: Fail` analog) instead of proceeding. Confirm no new entry is added to `registry.ts`'s visible tool list.
3. [REFACTOR] Extract the fail-closed wrapper so every IMPLEMENT phase boundary shares it.

**Acceptance:** injected resolver error → `phase.blocked` (no silent proceed); absent config → base table; visible-tool count unchanged.
**Dependencies:** Tasks 002, 004 · **Parallelizable:** Yes (with Task 006)

---

## Dependency graph & parallelization

```
Task 001 (union+table)
   ├─► Task 002 (resolveGateSet) ─┐
   └─► Task 003 (State.kind+tag) ─┤
                                  ▼
                          Task 004 (route IMPLEMENT)
                                  ├─► Task 005 (delete prose)   [serial: shares playbook region w/ 004]
                                  ├─► Task 006 (severity/audit) ┐
                                  └─► Task 007 (fail-closed+guard)┘  [006 ∥ 007]
```

- **Wave 1:** Task 001 (foundation, solo).
- **Wave 2:** Tasks 002 ∥ 003 (disjoint files: `phase-kind.ts` vs `state-machine.ts`/`hsm-definitions.ts`).
- **Wave 3:** Task 004 (integration point, solo).
- **Wave 4:** Task 005 (serial after 004 — same playbook region), then Tasks 006 ∥ 007.

## Verification gates (per slice boundary)

- Root + `servers/exarchos-mcp` suites green; `npm run typecheck`; `npm run lint:invariants`.
- Behavior-neutrality proof for S1 (Tasks 001–003): parity test (002) + zero transition diff (003).
- S2 reachability + prose-removal + fail-closed (Tasks 004–007).

## Traceability

| DR | Task(s) |
|---|---|
| DR-1 | 001 |
| DR-2 | 003 |
| DR-3 | 002 |
| DR-4 | 004 |
| DR-5 | 005 |
| DR-6 | 006 |
| DR-7 | 007 |

## Deferred (not in this plan)

- **S3 (#1549):** PLAN/REVIEW/SYNTHESIZE resolvers become authoritative (the inert resolver slots from Task 002 get wired); remove `(workflowType:phase)` gate selection from playbooks.
- **S4 (#1550):** `posture` → POLA capability bundle; resolve-then-freeze `phase.entered`/`phase.exited` events.
