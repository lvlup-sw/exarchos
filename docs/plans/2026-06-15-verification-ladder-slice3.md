# Implementation Plan: Verification Ladder — Slice 3 (R5 + R6)

## Source Design
Link: `docs/designs/2026-06-15-verification-ladder-slice3.md`

## Scope
**Target:** Full design — R5 `mutation-adequacy` boundary review dimension (#1520) + R6 cheap-mix planning default (#1521)
**Excluded:** R10 governance fold + `subagent.tokens_used` telemetry (#1525), full-tree/nightly mutation orchestration (Task path seamed, not driven — v2.12 lifecycle verbs), LLM equivalent-mutant filter, blocking-by-default severity, per-tier severity, any new MCP tool or CLI verb, any change to the slice-1 frozen table / slice-2 `verification:` resolver. Per design §1.

## Summary
- Total tasks: 10 (000–009)
- Parallel groups: Bundle A (R5) and Bundle B (R6) share no files; fully concurrent. R6 (009) **merges after** R5's core lands (design §5 — relaxation-without-backstop hazard).
- Estimated test count: ~38
- Design coverage: §3, §4.1–§4.6, §5, §6 (see traceability table)

## Conventions
- All MCP-server code/tests under `servers/exarchos-mcp/src/` (prefix omitted below); test command `cd servers/exarchos-mcp && npm run test:run`.
- **Zero new visible tools** (design §2 / INV-5d): `mutation-adequacy` is an **action** on `exarchos_orchestrate`. It MUST get a `handleOrchestrate` dispatch branch and pass the `registry` sync assertion — tested **through `handleOrchestrate`** (the DOA-action trap), never only the bare handler.
- **Field-collision guard** (INV-5d / `buildRegistrationSchema`): reuse `base: z.string()` at its existing type; do not introduce a field name at a clashing type.
- Review-dimension names are **derived from the skill folder name** (`review-contract.ts` SoT); never re-declare in `playbooks.ts`/`tools.ts`.
- Skills authored in `skills-src/`; run `npm run build:skills` + `npm run skills:guard`; commit source + regenerated tree (INV-4).
- High-blast tasks (003 registry/action, 007 required-dimension reshape): run the **full root + MCP suite** before merging their branches.
- Workflow state reads use `resolveWorkflowState` (event-store-backed), never `.state.json` presence.

## Spec Traceability

| Design section | Requirement | Tasks |
|---|---|---|
| §4.7-style T0 pin | review-dimension roster + action-roster characterization before the fold | 000 |
| §4.1 action (report parse half) | Stryker `mutation-testing-report-schema` Zod + carrier aggregation; fail-closed | 001 |
| §4.2 diff-scope table | per-runner augmentation co-located with `config/toolchains.ts`; resolver-applied | 002 |
| §4.1 action (handler half) | `mutation-adequacy` handler + registry + `handleOrchestrate` branch; Skipped/Warning degrade | 003 |
| §4.5 execution/liveness | `mutation.executing_started`/`executed`; `gate.executed` foldable; idempotent re-run | 004 |
| §4.1 / INV-12 | survivors + `NoCoverage` → `next_actions` | 005 |
| §4.6 advisory verdict | threshold (config, default soft ~40%); advisory severity; explicit override blocks | 006 |
| §4.3 review dimension | `review-contract.ts` high-tier-only; INV-4 non-native-worktree parity | 007 |
| §4.3 skill | `skills-src/mutation-adequacy/SKILL.md` + `quality-review` pointer | 008 |
| §4.4 R6 cheap mix | tier table in planning references; deterministic mix fields | 009 |
| §5 hazards | handler-gap, field-collision, dimension reshape, relaxation ordering | 003, 007, 009 (woven) |
| §6 acceptance | diff-scoped < minutes; advisory; survivor affordances; per-tier mix | 002, 005, 006, 009 |

## Task Breakdown

### Task 000: T0 characterization — review-dimension + action rosters
**Phase:** PIN (written to PASS against HEAD before any change)
**Test Layer:** integration · **Risk:** low · **Boundary:** false · **Implements:** design §5 (reshape safety net)

1. [PIN] Write characterization tests:
   - `ReviewDimensionRoster_CurrentBuild_StablePerWorkflowType` — `getRequiredReviews` output per workflow type, pinned
   - `OrchestrateActionRoster_CurrentBuild_PinnedActionSet` — current registered action names/count
   - File: `orchestrate/mutation-adequacy.characterization.test.ts`
   - Run: MUST PASS on unmodified HEAD (deliberately updated when 003/007 land)
2. [GREEN] N/A — no production change

**Dependencies:** None · **Parallelizable:** Yes (with 001, 002, 009)

### Task 001: Stryker report schema + carrier aggregation
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit · **Risk:** medium · **Boundary:** true (parses an external report contract) · **Implements:** design §4.1 (parse half), §4.6 carrier

1. [RED] Tests in `orchestrate/mutation-adequacy.report.test.ts`:
   - `MutationReportSchema_ValidStrykerReport_ParsesAndAggregates`
   - `AggregateCarrier_MixedMutantStates_ComputesScore` (score = killed / (total − noCoverage), the Stryker convention; asserted explicitly)
   - `MutationReportSchema_MalformedReport_FailsClosed` (returns a degrade signal, never throws)
   - Expected failure: schema/aggregator absent
2. [GREEN] `orchestrate/mutation-adequacy.ts` (report region): `MutationReportSchema` mirroring `mutation-testing-report-schema`; `aggregate(report) → { mutationScore, killed, survived, noCoverage, total }`
3. [REFACTOR] Extract a single carrier type shared by aggregator and handler

**Dependencies:** None · **Parallelizable:** Yes (with 000, 002, 009)

### Task 002: Per-runner diff-scope augmentation table
**Phase:** RED → GREEN
**Test Layer:** unit · **Risk:** medium · **Boundary:** false · **Implements:** design §4.2

1. [RED] Tests in `config/toolchains.test.ts` (or `config/mutation-diff-scope.test.ts`):
   - `ResolveMutationDiffScope_NodeStryker_AppendsSinceFlag` (`+= --since=<base>`)
   - `ResolveMutationDiffScope_RustCargoMutants_AlreadyDiffNative` (no double-scope)
   - `ResolveMutationDiffScope_PythonMutmut_RestrictsToChangedPaths`
   - `ResolveMutationDiffScope_UnknownToolchain_SignalsUnscopedWarning` (never silently full)
   - Expected failure: no augmentation surface
2. [GREEN] `config/toolchains.ts` — typed `MUTATION_DIFF_SCOPE` table keyed by toolchain id + `resolveMutationDiffScope(toolchainId, base)`; identity stays in the SoT module, resolver-applied (handler runner-agnostic)

**Dependencies:** None · **Parallelizable:** Yes (with 000, 001, 009)

### Task 003: `mutation-adequacy` action handler + registry + dispatch-through
**Phase:** RED → GREEN
**Test Layer:** integration · **Risk:** high · **Boundary:** true · **Implements:** design §4.1 (handler half)

1. [RED] Tests in `orchestrate/mutation-adequacy.test.ts` (dispatched **through `handleOrchestrate`**, injected runner seam):
   - `HandleOrchestrate_MutationAdequacy_ResolvesRunsParsesReturnsCarrier`
   - `HandleOrchestrate_MutationAdequacy_UnresolvedCommand_Skipped` (reason names remediation)
   - `HandleOrchestrate_MutationAdequacy_MalformedReport_Warning` (degrade, not throw)
   - `HandleOrchestrate_MutationAdequacy_FullScope_DeferredAdvisory` (design §4.5 — `scope: 'full'` returns a deferred-to-R10/v2.12 advisory, never an inline full-tree run)
   - `Registry_MutationAdequacyAction_HasHandlerBranch` (no `UNKNOWN_ACTION`; sync assertion green)
   - Expected failure: action unregistered / no handler branch
2. [GREEN] `orchestrate/mutation-adequacy.ts` handler; input schema `{ featureId, base: z.string(), worktreePath?, threshold?, scope: 'diff'|'full' = 'diff' }` (reuse `base` type verbatim); `scope: 'full'` short-circuits to a deferred-advisory (no inline full run); register in `registry` **with** a `handleOrchestrate` branch; inject the runner + diff-scope (002) + report parse (001)

**Verification:** Full root + MCP suite before merge (high-blast: registry + dispatch surface)
**Dependencies:** 001, 002 · **Parallelizable:** No (Bundle A spine)

### Task 004: Liveness + `gate.executed` emission
**Phase:** RED → GREEN
**Test Layer:** integration · **Risk:** medium · **Boundary:** false · **Implements:** design §4.5, §2 (INV-10/INV-1/INV-8)

1. [RED] Tests in `orchestrate/mutation-adequacy.test.ts`:
   - `MutationAdequacy_Run_EmitsExecutingStartedThenExecuted`
   - `MutationAdequacy_Result_EmitsGateExecutedWithScore` (folds into a score trend in a property test)
   - `MutationAdequacy_Retry_IdempotentNoCasPin` (operationId collapse; no CAS-pin on follow-on)
   - Expected failure: no liveness/gate events emitted
2. [GREEN] Add `mutation.executing_started`/`mutation.executed` event types to `event-store/schemas.ts`; emit around the run; emit `gate.executed { gateName: 'mutation-adequacy', layer: 'review', mutationScore }`

**Dependencies:** 003 · **Parallelizable:** Yes (with 005, 006)

### Task 005: Surviving-mutant `next_actions`
**Phase:** RED → GREEN
**Test Layer:** unit · **Risk:** low · **Boundary:** false · **Implements:** design §4.1 / INV-12

1. [RED] Tests in `orchestrate/mutation-adequacy.test.ts`:
   - `MutationAdequacy_SurvivingMutants_EmitKillTestNextActions` ("write a test that kills `<file>:<line>`")
   - `MutationAdequacy_NoCoverageMutants_EmitKillTestNextActions`
   - `MutationAdequacy_AllKilled_NoSurvivorAffordances`
   - Expected failure: survivors not mapped to affordances
2. [GREEN] Map survivor + `NoCoverage` mutant locations to `next_actions` on the result

**Dependencies:** 003 · **Parallelizable:** Yes (with 004, 006)

### Task 006: Advisory verdict + config threshold
**Phase:** RED → GREEN
**Test Layer:** integration · **Risk:** medium · **Boundary:** false · **Implements:** design §4.6

1. [RED] Tests in `orchestrate/mutation-adequacy.test.ts` + `config/resolve.test.ts`:
   - `MutationAdequacy_ScoreBelowThreshold_PassedFalseButAdvisory` (warning, never blocks)
   - `MutationAdequacy_ExplicitOverride_Blocking` (`review.gates` pin raises severity — slice-2 mechanism)
   - `MutationAdequacy_NoThresholdConfig_DefaultsToSoftAdvisory` (~40% default)
   - Expected failure: no threshold resolution / always blocks or never warns
2. [GREEN] Thread `mutation-adequacy` through `applyLadderGateSeverity` (reuse, do not reinvent); add an optional `mutationAdequacy.threshold` to the config schema with the soft default

**Dependencies:** 003 · **Parallelizable:** Yes (with 004, 005)

### Task 007: Review-dimension wiring + high-tier-only + INV-4 parity
**Phase:** RED → GREEN
**Test Layer:** integration · **Risk:** medium-high (cross-surface reshape) · **Boundary:** false · **Implements:** design §4.3

1. [RED] Tests in `workflow/review-contract.test.ts`:
   - `ReviewContract_MutationAdequacy_RequiredForHighTierOnly`
   - `ReviewContract_MutationAdequacy_AbsentForMediumLow`
   - `MutationAdequacyDimension_ResolvesOnNonNativeWorktreePath` (open Q4 — INV-4 parity, not just CC native)
   - Expected failure: dimension not in required-reviews; updates the 000 pin deliberately
2. [GREEN] Add `mutation-adequacy` to the high-tier required-reviews map in `review-contract.ts`; thread the engine `_requiredReviews` + `playbooks.ts` references off the SoT (no literals)

**Verification:** Full root + MCP suite before merge (required-dimension count reshape)
**Dependencies:** 003 · **Parallelizable:** No (after 003 within Bundle A)

### Task 008: `mutation-adequacy` skill + `quality-review` pointer
**Phase:** GREEN (authoring; verified by `skills:guard`)
**Test Layer:** guard · **Risk:** low · **Boundary:** false · **Implements:** design §4.3

1. Author `skills-src/mutation-adequacy/SKILL.md` (`metadata.mcp-server: exarchos`; invokes the action, reads the carrier, turns survivors into kill-this-mutant follow-ups) + `references/` (report-schema reading guide, advisory-threshold rationale — no frontmatter on references)
2. Add a pointer to the new dimension in `skills-src/quality-review/SKILL.md`
3. `npm run build:skills` + `npm run skills:guard`

**Verification:** `skills:guard` green; frontmatter valid (name kebab-case, `metadata.mcp-server: exarchos`)
**Dependencies:** 007 (dimension name) · **Parallelizable:** No (after 007)

### Task 009: R6 — cheap verification mix as the planning default
**Phase:** GREEN (authoring; verified by `skills:guard` + characterization)
**Test Layer:** guard · **Risk:** low · **Boundary:** false · **Implements:** design §4.4

1. Edit `skills-src/implementation-planning/references/testing-strategy-guide.md` + `task-template.md`: add a **tier table** (data, not branching prose — INV-6) mapping `riskTier` → default `testingStrategy`. Medium/high default to strict/branded types + inline invariants/assertions + one PBT on the pure core + one acceptance north-star test, with `propertyTests`/`testLayer`/`characterizationRequired` set from the table; low stays minimal; granular per-behavior red-green becomes opt-in
2. `npm run build:skills` + `npm run skills:guard`

**Verification:** `skills:guard` green; the tier table sets the mix fields deterministically (no implementer guesswork)
**Dependencies:** None · **Parallelizable:** Yes (with all of Bundle A) — but **merges after** R5 core (003–007) lands (relaxation-without-backstop hazard, §5)

## Parallelization Strategy

```
Group 1 (start immediately, parallel):  000 (pin)   001 (report)   002 (diff-scope)   009 (R6, dev only)
Group 2 (after 001 + 002):              003 (action spine)
Group 3 (after 003):                    004, 005, 006   (parallel)   →   007 (dimension)
Group 4 (after 007):                    008 (skill)
Merge order: high-blast 003 and 007 merge with full-suite verification; 008 last in Bundle A;
             009 (R6) lands ONLY after R5 core (003–007) is merged — the backstop precedes the relaxation.
```

Integration branch: `feature/verification-ladder-slice3`; task branches `task/NNN-<slug>` off the integration branch (never `main`).

## Deferred Items
- R10 (#1525) — mutation-score trend fold + `subagent.tokens_used` telemetry: this slice only **emits** the foldable `gate.executed`; the view is R10.
- Full-tree/nightly mutation orchestration via Tasks/SEP-1686 — seam defined (`scope: 'full'` returns deferred-advisory), driven when v2.12 lifecycle verbs land.
- LLM equivalent-mutant filter; blocking-by-default severity; per-tier severity — recorded non-goals.
