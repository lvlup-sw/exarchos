# Implementation Plan: Lazy Schema + Runbook Protocol

## Source Design
Link: `docs/designs/2026-03-08-lazy-schema-runbook-protocol.md`
Related: [#966](https://github.com/lvlup-sw/exarchos/issues/966) — Runbooks make the MCP server self-describing, advancing runtime-agnostic support (Copilot CLI, Cursor, etc.)

## Scope
**Target:** Full design — all 4 phases (Foundation, Runbook Protocol, Integration, Anti-Drift) plus Skill Integration (§7)
**Excluded:** Phase 4 (Iteration — additional runbooks) and §8 (Token Budget Measurement — requires eval framework, measure post-deployment)

## Summary
- Total tasks: 5
- Parallel groups: 2 (Round 1: T1+T2+T3 parallel, Round 2: T4+T5 parallel)
- Estimated test count: ~35
- Design coverage: 7 of 7 actionable Technical Design sections covered

## Spec Traceability

| Design Section | Task(s) | Key Requirements |
|---|---|---|
| §1 Slim Registration | T1 | `slimDescription` field, dual-mode `buildToolDescription`, MCP adapter config |
| §2 `describe` Action | T2 | Schema, handler, registration on 4 visible tools, composite wiring |
| §3 Gate Metadata on Actions | T1 | `gate` field on `ToolAction`, metadata on all 12 check_* actions |
| §4.1 Runbook Definition Type | T3 | `RunbookStep`, `RunbookDefinition` interfaces |
| §4.2 Runbook Definitions | T3 | 5 runbook constants, `ALL_RUNBOOKS` export |
| §4.3 Runbook Action Handler | T4 | `handleRunbook` (list + detail modes), schema resolution |
| §5 Anti-Drift Architecture | T4 | 5 bidirectional sync tests, structural validation |
| §6 Registration Schema Changes | T1, T2, T4 | New action registrations, `buildRegistrationSchema` unchanged |
| §7 Skill Integration | T5 | Update skills to reference runbooks, remove duplicated prose orchestration |
| #966 Copilot CLI Support | T1, T4, T5 | Self-describing MCP server reduces dependency on Claude Code-specific skills |

## Task Breakdown

### Task 1: Gate Metadata + Slim Registration

**Implements:** §1, §3, §6 (partial)

Add gate classification to action definitions and slim registration mode to the MCP adapter. These are foundational changes that other tasks build on.

**Phase:** RED → GREEN → REFACTOR

**1. [RED] Test gate field on ToolAction**
- File: `servers/exarchos-mcp/src/registry.test.ts`
- Test: `GateMetadata_CheckActions_HaveGateField`
- Expected failure: `gate` property does not exist on ToolAction

**2. [GREEN] Add gate field to ToolAction interface + all check_* actions**
- File: `servers/exarchos-mcp/src/registry.ts`
- Add optional `gate?: { readonly blocking: boolean; readonly dimension?: string }` to `ToolAction`
- Add `gate` metadata to 12 check_* actions:
  - `check_tdd_compliance`: `{ blocking: true, dimension: 'D1' }`
  - `check_static_analysis`: `{ blocking: true, dimension: 'D2' }`
  - `check_security_scan`: `{ blocking: false, dimension: 'D1' }`
  - `check_context_economy`: `{ blocking: false, dimension: 'D3' }`
  - `check_operational_resilience`: `{ blocking: false, dimension: 'D4' }`
  - `check_workflow_determinism`: `{ blocking: false, dimension: 'D5' }`
  - `check_review_verdict`: `{ blocking: true }`
  - `check_convergence`: `{ blocking: false }`
  - `check_provenance_chain`: `{ blocking: true, dimension: 'D1' }`
  - `check_design_completeness`: `{ blocking: false, dimension: 'D1' }`
  - `check_plan_coverage`: `{ blocking: true, dimension: 'D1' }`
  - `check_task_decomposition`: `{ blocking: false, dimension: 'D5' }`
  - `check_post_merge`: `{ blocking: false, dimension: 'D4' }`

**3. [RED] Test slimDescription on CompositeTool**
- File: `servers/exarchos-mcp/src/registry.test.ts`
- Test: `SlimDescription_AllVisibleTools_HaveSlimDescription`
- Expected failure: `slimDescription` property does not exist on CompositeTool

**4. [GREEN] Add slimDescription to CompositeTool interface + all 5 tools**
- File: `servers/exarchos-mcp/src/registry.ts`
- Add `readonly slimDescription: string` to `CompositeTool`
- Write slim descriptions for all 5 tools (tool summary + action list)

**5. [RED] Test buildToolDescription dual mode**
- File: `servers/exarchos-mcp/src/registry.test.ts`
- Test: `BuildToolDescription_SlimMode_ReturnsSlimDescription`
- Test: `BuildToolDescription_FullMode_ReturnsFullDescription`
- Expected failure: `buildToolDescription` does not accept `slim` parameter

**6. [GREEN] Update buildToolDescription for dual mode**
- File: `servers/exarchos-mcp/src/registry.ts`
- Add `slim: boolean` parameter (default `false` for backward compat)
- Return `tool.slimDescription` when `slim === true`

**7. [RED] Test MCP adapter slim registration**
- File: `servers/exarchos-mcp/src/adapters/mcp.test.ts`
- Test: `CreateMcpServer_SlimRegistration_UsesSlimDescriptions`
- Expected failure: `slimRegistration` not recognized in DispatchContext

**8. [GREEN] Update MCP adapter + DispatchContext**
- File: `servers/exarchos-mcp/src/core/dispatch.ts` — Add `slimRegistration?: boolean` to `DispatchContext`
- File: `servers/exarchos-mcp/src/adapters/mcp.ts` — Use `buildToolDescription(tool, ctx.slimRegistration ?? false)`

**9. [REFACTOR]** Export gate metadata types for use by other tasks.

**Dependencies:** None
**Parallelizable:** Yes — no file conflicts with Task 2
**Files modified:** `registry.ts`, `registry.test.ts`, `adapters/mcp.ts`, `adapters/mcp.test.ts`, `core/dispatch.ts`

---

### Task 2: Describe Action

**Implements:** §2, §6 (partial)

Add a `describe` action to all 4 visible composite tools that returns full schemas for requested actions on demand.

**Phase:** RED → GREEN → REFACTOR

**1. [RED] Test findActionInRegistry helper**
- File: `servers/exarchos-mcp/src/registry.test.ts`
- Test: `FindActionInRegistry_ValidAction_ReturnsAction`
- Test: `FindActionInRegistry_InvalidAction_ReturnsUndefined`
- Test: `FindActionInRegistry_InvalidTool_ReturnsUndefined`
- Expected failure: function does not exist

**2. [GREEN] Implement findActionInRegistry**
- File: `servers/exarchos-mcp/src/registry.ts`
- Searches `getFullRegistry()` for tool by name, then action by name
- Returns `ToolAction | undefined`

**3. [RED] Test handleDescribe handler**
- File: `servers/exarchos-mcp/src/describe/handler.test.ts` (new)
- Test: `HandleDescribe_ValidAction_ReturnsSchemaAndMetadata`
- Test: `HandleDescribe_MultipleActions_ReturnsAll`
- Test: `HandleDescribe_UnknownAction_ReturnsErrorWithValidTargets`
- Test: `HandleDescribe_IncludesGateMetadata_WhenPresent`
- Test: `HandleDescribe_OmitsGate_WhenNotPresent`
- Expected failure: module does not exist

**4. [GREEN] Implement handleDescribe**
- File: `servers/exarchos-mcp/src/describe/handler.ts` (new)
- Accepts `{ actions: string[] }` + tool's action list
- Returns `Record<string, { description, schema, gate, phases, roles }>` for each requested action
- Uses `zodToJsonSchema` for schema serialization
- Returns `UNKNOWN_ACTION` error with `validTargets` for bad action names

**5. [RED] Test describe action registration**
- File: `servers/exarchos-mcp/src/registry.test.ts`
- Test: `DescribeAction_AllVisibleTools_HaveDescribeAction`
- Expected failure: no `describe` action in registry

**6. [GREEN] Register describe action on all 4 visible composite tools**
- File: `servers/exarchos-mcp/src/registry.ts`
- Add describe action definition to `workflowActions`, `eventActions`, `orchestrateActions`, `viewActions`
- Schema: `z.object({ actions: z.array(z.string()).min(1).max(10) })`
- Phases: `ALL_PHASES`, Roles: `ROLE_ANY`

**7. [RED] Test describe routing in composite handlers**
- File: `servers/exarchos-mcp/src/workflow/composite.test.ts` (or extend existing)
- Test: `HandleWorkflow_DescribeAction_ReturnsSchemas`
- Test: `HandleOrchestrate_DescribeAction_ReturnsSchemas`
- Expected failure: `describe` action not routed

**8. [GREEN] Wire describe in all 4 composite handlers**
- Files: `workflow/composite.ts`, `event-store/composite.ts`, `orchestrate/composite.ts`, `views/composite.ts`
- Import `handleDescribe` and the tool's action list
- Route `action === 'describe'` to `handleDescribe(args, toolActions)`

**9. [REFACTOR]** Extract shared describe schema constant to avoid duplication across 4 action registrations.

**Dependencies:** None (gate metadata is additive — describe works without it, returns `gate: null`)
**Parallelizable:** Yes — no file conflicts with Task 1. Potential merge conflict with Task 3 on `orchestrate/composite.ts` and `registry.ts` (additive, easy to resolve).
**Files modified:** `registry.ts`, `registry.test.ts`, `describe/handler.ts` (new), `describe/handler.test.ts` (new), `workflow/composite.ts`, `event-store/composite.ts`, `orchestrate/composite.ts`, `views/composite.ts`

---

### Task 3: Runbook Types + Definitions

**Implements:** §4.1, §4.2

Define the runbook type system and write the 5 initial runbook definitions as typed constants.

**Phase:** RED → GREEN → REFACTOR

**1. [RED] Test RunbookStep and RunbookDefinition types compile**
- File: `servers/exarchos-mcp/src/runbooks/types.test.ts` (new)
- Test: `RunbookStep_ValidStep_Compiles`
- Test: `RunbookDefinition_ValidDefinition_Compiles`
- Test: `RunbookStep_OnFail_OnlyAcceptsValidValues` (type-level)
- Expected failure: module does not exist

**2. [GREEN] Implement runbook types**
- File: `servers/exarchos-mcp/src/runbooks/types.ts` (new)
- `RunbookStep`: `tool`, `action`, `onFail`, optional `params`, `note`
- `RunbookDefinition`: `id`, `phase`, `description`, `steps`, `templateVars`, `autoEmits`
- `ResolvedRunbookStep`: extends step with `seq`, `schema`, `description`, `gate`

**3. [RED] Test runbook definitions are valid**
- File: `servers/exarchos-mcp/src/runbooks/definitions.test.ts` (new)
- Test: `AllRunbooks_HaveUniqueIds`
- Test: `AllRunbooks_HaveAtLeastOneStep`
- Test: `AllRunbooks_HaveNonEmptyTemplateVars`
- Test: `AllRunbooks_StepsHaveValidOnFail`
- Test: `TaskCompletion_HasThreeSteps_InCorrectOrder`
- Test: `QualityEvaluation_HasFourSteps`
- Test: `AgentTeamsSaga_HasElevenSteps`
- Test: `SynthesisFlow_HasFourSteps`
- Test: `ShepherdIteration_HasSixSteps`
- Expected failure: module does not exist

**4. [GREEN] Write 5 runbook definitions**
- File: `servers/exarchos-mcp/src/runbooks/definitions.ts` (new)
- Constants: `TASK_COMPLETION`, `QUALITY_EVALUATION`, `AGENT_TEAMS_SAGA`, `SYNTHESIS_FLOW`, `SHEPHERD_ITERATION`
- Export: `ALL_RUNBOOKS` array
- Match exact step sequences from design document §4.2

**5. [REFACTOR]** Verify all runbook definitions are `as const satisfies RunbookDefinition` for type narrowing.

**Dependencies:** None (pure types + data, no existing file modifications)
**Parallelizable:** Yes — all new files, no conflicts with T1 or T2
**Files modified:** `runbooks/types.ts` (new), `runbooks/types.test.ts` (new), `runbooks/definitions.ts` (new), `runbooks/definitions.test.ts` (new)

---

### Task 4: Runbook Handler + Anti-Drift Tests

**Implements:** §4.3, §5, §6 (partial)

Implement the `runbook` action handler with list and detail modes, register it on `exarchos_orchestrate`, and write the 5 anti-drift tests.

**Phase:** RED → GREEN → REFACTOR

**1. [RED] Test handleRunbook list mode**
- File: `servers/exarchos-mcp/src/runbooks/handler.test.ts` (new)
- Test: `HandleRunbook_ListMode_NoParams_ReturnsAllRunbooks`
- Test: `HandleRunbook_ListMode_WithPhase_FiltersRunbooks`
- Test: `HandleRunbook_ListMode_UnknownPhase_ReturnsEmptyArray`
- Expected failure: module does not exist

**2. [GREEN] Implement handleRunbook list mode**
- File: `servers/exarchos-mcp/src/runbooks/handler.ts` (new)
- When `id` is not provided: return `{ id, phase, description, stepCount }` for each matching runbook
- Filter by `phase` if provided

**3. [RED] Test handleRunbook detail mode**
- File: `servers/exarchos-mcp/src/runbooks/handler.test.ts`
- Test: `HandleRunbook_DetailMode_ValidId_ReturnsResolvedSteps`
- Test: `HandleRunbook_DetailMode_ResolvesSchemaFromRegistry`
- Test: `HandleRunbook_DetailMode_ResolvesGateFromRegistry`
- Test: `HandleRunbook_DetailMode_SkipsSchemaForNativeTools`
- Test: `HandleRunbook_DetailMode_UnknownId_ReturnsErrorWithValidTargets`
- Test: `HandleRunbook_DetailMode_IncludesTemplateVarsAndAutoEmits`
- Expected failure: detail mode not implemented

**4. [GREEN] Implement handleRunbook detail mode**
- File: `servers/exarchos-mcp/src/runbooks/handler.ts`
- When `id` is provided: find runbook, resolve schemas from registry via `findActionInRegistry`
- Skip schema resolution for `native:` prefixed tools
- Return full resolved runbook with `seq` numbers, schemas, gate metadata, descriptions

**5. [RED] Test runbook action registration**
- File: `servers/exarchos-mcp/src/registry.test.ts`
- Test: `RunbookAction_ExistsInOrchestrateRegistry`
- Expected failure: no `runbook` action in orchestrate registry

**6. [GREEN] Register runbook action + wire in composite handler**
- File: `servers/exarchos-mcp/src/registry.ts` — Add runbook action definition to `orchestrateActions`
  - Schema: `z.object({ phase: z.string().optional(), id: z.string().optional() })`
  - Phases: `ALL_PHASES`, Roles: `ROLE_ANY`
- File: `servers/exarchos-mcp/src/orchestrate/composite.ts` — Import `handleRunbook`, add to `ACTION_HANDLERS`

**7. [RED] Anti-drift tests**
- File: `servers/exarchos-mcp/src/runbooks/drift.test.ts` (new)
- Test: `RunbookDrift_EveryStepReferencesValidRegistryAction`
- Test: `RunbookDrift_TemplateVarsCoverRequiredParams`
- Test: `RunbookDrift_EveryBlockingGateAppearsInRunbook`
- Test: `RunbookDrift_AutoEmitsMatchEventEmissionRegistry`
- Test: `RunbookDrift_RunbookIdsAreUnique`

**8. [GREEN] Implement anti-drift tests**
- File: `servers/exarchos-mcp/src/runbooks/drift.test.ts`
- Import `ALL_RUNBOOKS` from definitions, `getFullRegistry`/`findActionInRegistry` from registry, `EVENT_EMISSION_REGISTRY` from event-store/schemas
- Implement all 5 tests per design §5.3

**9. [REFACTOR]** Ensure all tests pass with the full registry. Verify merge with T2 changes (describe action additions).

**Dependencies:** Task 1 (gate metadata for anti-drift test), Task 2 (findActionInRegistry helper), Task 3 (runbook definitions)
**Parallelizable:** No — must run after T1, T2, T3
**Files modified:** `runbooks/handler.ts` (new), `runbooks/handler.test.ts` (new), `runbooks/drift.test.ts` (new), `orchestrate/composite.ts`, `registry.ts`, `registry.test.ts`

---

### Task 5: Skill Integration — Runbook References

**Implements:** §7, #966 (partial)

Update skills that currently document multi-step orchestration sequences in prose to reference runbooks instead. This is critical — without it, agents won't discover or use runbooks. Also advances #966 by reducing dependence on Claude Code-specific skill prose for orchestration guidance.

**Phase:** RED → GREEN → REFACTOR

**1. [RED] Test that skills reference runbooks where applicable**
- File: `servers/exarchos-mcp/src/runbooks/skill-coverage.test.ts` (new)
- Test: `SkillCoverage_DelegationSkill_ReferencesTaskCompletionRunbook`
- Test: `SkillCoverage_DelegationSkill_ReferencesAgentTeamsSagaRunbook`
- Test: `SkillCoverage_QualityReviewSkill_ReferencesQualityEvaluationRunbook`
- Test: `SkillCoverage_SynthesisSkill_ReferencesSynthesisFlowRunbook`
- Test: `SkillCoverage_ShepherdSkill_ReferencesShepherdIterationRunbook`
- Implementation: grep skill files for `action: "runbook"` or `runbook` references
- Expected failure: no runbook references in skill files

**2. [GREEN] Update delegation skill**
- File: `skills/delegation/SKILL.md`
- Replace Step 3 prose gate sequence with:
  ```
  For each completed task, execute the `task-completion` runbook:
  `exarchos_orchestrate({ action: "runbook", id: "task-completion" })`
  Execute steps in order. Stop on gate failure.
  ```
- File: `skills/delegation/references/agent-teams-saga.md`
- Add runbook reference at top:
  ```
  Machine-readable version: `exarchos_orchestrate({ action: "runbook", id: "agent-teams-saga" })`
  ```
- Keep prose as human-readable context (don't delete — agents may still read it), but mark runbook as authoritative

**3. [GREEN] Update quality-review skill**
- File: `skills/quality-review/SKILL.md`
- Replace Step 1 gate invocation sequence with runbook reference:
  ```
  Run quality evaluation gates via runbook:
  `exarchos_orchestrate({ action: "runbook", id: "quality-evaluation" })`
  ```

**4. [GREEN] Update synthesis skill**
- File: `skills/synthesis/SKILL.md`
- Add runbook reference for the synthesis flow:
  ```
  Follow the `synthesis-flow` runbook:
  `exarchos_orchestrate({ action: "runbook", id: "synthesis-flow" })`
  ```

**5. [GREEN] Update shepherd skill**
- File: `skills/shepherd/SKILL.md` (or `skills/shepherd/references/`)
- Add runbook reference for shepherd iteration:
  ```
  Each shepherd iteration follows the `shepherd-iteration` runbook:
  `exarchos_orchestrate({ action: "runbook", id: "shepherd-iteration" })`
  ```

**6. [REFACTOR]** Review all updated skills for consistency. Ensure prose and runbook references don't contradict each other. Remove redundant step numbering where runbook replaces it.

**Dependencies:** Task 3 (runbook definitions must exist), Task 4 (runbook action must be wired)
**Parallelizable:** Yes with Task 4 — T5 modifies skill markdown files, T4 modifies MCP server code. No file conflicts.
**Files modified:** `skills/delegation/SKILL.md`, `skills/delegation/references/agent-teams-saga.md`, `skills/quality-review/SKILL.md`, `skills/synthesis/SKILL.md`, `skills/shepherd/SKILL.md`, `runbooks/skill-coverage.test.ts` (new)

---

## Parallelization Strategy

```
Round 1 (parallel):
  ├── Task 1: Gate Metadata + Slim Registration    [registry.ts, adapters/mcp.ts]
  ├── Task 2: Describe Action                      [describe/ (new), composites]
  └── Task 3: Runbook Types + Definitions           [runbooks/ (new files only)]

Round 2 (parallel):
  ├── Task 4: Runbook Handler + Anti-Drift Tests    [runbooks/, orchestrate/composite.ts, registry.ts]
  └── Task 5: Skill Integration                     [skills/*.md — no code file conflicts with T4]
```

**Merge conflict risk:** Tasks 1 and 2 both modify `registry.ts` but in different sections (T1: interface + tool data, T2: action arrays + new function). Additive changes — easy merge. Tasks 2 and 4 both modify `orchestrate/composite.ts` — T2 adds `describe` routing, T4 adds `runbook` routing. Additive, resolvable mechanically. Tasks 4 and 5 have zero file overlap (T4: server code, T5: skill markdown).

## Deferred Items

| Item | Rationale |
|---|---|
| Token budget measurement (§8) | Requires eval framework integration. Measure after slim registration is deployed. |
| Additional runbooks (Design §Phase 4) | Add as patterns emerge from real usage. |
| `runbook` action on `exarchos_view` | Not needed until read-heavy sequences are identified. |
| `_eventHints` in runbook responses | Evaluate after measuring orchestration reliability improvement. |
| `slimRegistration` default for new installs | Requires installer changes. Default to `false` initially, flip after validation. |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] `gate` metadata on all 12 check_* + 1 check_post_merge actions
- [ ] `slimDescription` on all 5 composite tools
- [ ] `describe` action on all 4 visible composite tools
- [ ] 5 runbook definitions match design spec
- [ ] `runbook` action returns resolved schemas from registry
- [ ] 5 anti-drift tests pass
- [ ] `buildToolDescription` supports dual mode
- [ ] MCP adapter supports `slimRegistration` config
- [ ] Skills reference runbooks for all 5 orchestration sequences
- [ ] Skill-coverage tests pass
- [ ] Ready for review
