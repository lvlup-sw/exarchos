# Implementation Plan: Tool Introspection Phases 2-4

## Source Design
Link: `docs/designs/2026-03-09-tool-introspection.md`

## Scope
**Target:** Full design — all 10 requirements (DR-1 through DR-10)
**Excluded:** None

## Summary
- Total tasks: 8
- Parallel groups: 5 waves (3 waves with parallelism)
- Estimated test count: 16
- Design coverage: 10/10 requirements covered

## Spec Traceability

| Design Requirement | Task(s) | Key Test(s) |
|---|---|---|
| DR-1: AutoEmission type + autoEmits field | 001 | AutoEmission_Interface_ExistsAndExported |
| DR-2: Populate autoEmits on all actions | 002 | RegistryDrift_AutoEmitsMatchEventEmissionRegistry |
| DR-3: autoEmits in describe output | 003 | HandleDescribe_ActionWithAutoEmits_ReturnsEmissionMetadata |
| DR-4: Emission drift tests | 002 | RegistryDrift_DescriptionEmitsImpliesAutoEmitsField |
| DR-5: Derive Runbook.autoEmits | 004 | RunbookDrift_AutoEmitsMatchComputedFromToolActions |
| DR-6: Playbook serialization | 005 | SerializePlaybooks_Feature_ReturnsAllPhases |
| DR-7: Playbook describe parameter | 006 | HandleDescribe_PlaybookFeature_ReturnsSerializedPlaybooks |
| DR-8: Schema introspection adapter | 007 | ResolvePlaybookRef_Feature_ReturnsSerializedPlaybooks |
| DR-9: Skill refactoring | 008 | (editorial — content verification) |
| DR-10: Error handling | 003, 006 | HandleDescribe_PlaybookUnknown_ReturnsErrorWithValidTargets |

## Task Breakdown

### Task 001: AutoEmission interface and ToolAction.autoEmits field
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `AutoEmission_Interface_ExistsAndExported`
   - File: `servers/exarchos-mcp/src/registry.test.ts`
   - Assert: `AutoEmission` type can be imported and used to type a value with `{ event: string, condition: 'always' | 'conditional', description?: string }`
   - Expected failure: `AutoEmission` not exported from registry

2. [RED] Write test: `ToolAction_AutoEmits_AcceptsEmissionArray`
   - File: `servers/exarchos-mcp/src/registry.test.ts`
   - Assert: A ToolAction with `autoEmits: [{ event: 'workflow.started', condition: 'always' }]` compiles and is found via `findActionInRegistry`
   - Expected failure: `autoEmits` not a recognized field on ToolAction

3. [GREEN] Add `AutoEmission` interface and `autoEmits?: readonly AutoEmission[]` to `ToolAction` in `registry.ts`
   - File: `servers/exarchos-mcp/src/registry.ts`

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes

---

### Task 002: Populate autoEmits on all tool actions + drift tests
**Implements:** DR-2, DR-4

**TDD Steps:**
1. [RED] Write test: `RegistryDrift_AutoEmitsMatchEventEmissionRegistry`
   - File: `servers/exarchos-mcp/src/registry.test.ts`
   - Assert: For every action with `autoEmits`, each emission's `event` exists in `EVENT_EMISSION_REGISTRY` with `source: 'auto'`. Also assert at least one action has `autoEmits` populated.
   - Expected failure: No actions have autoEmits populated yet

2. [RED] Write test: `RegistryDrift_DescriptionEmitsImpliesAutoEmitsField`
   - File: `servers/exarchos-mcp/src/registry.test.ts`
   - Assert: For every action whose `description` contains "Auto-emits" or "Emits gate.executed" or "Emits task.", `autoEmits` is defined and non-empty
   - Expected failure: Actions with "Auto-emits" in description lack `autoEmits` field

3. [GREEN] Populate `autoEmits` on all tool actions in `registry.ts`:
   - File: `servers/exarchos-mcp/src/registry.ts`
   - Workflow actions: init (workflow.started), set (workflow.transition conditional + state.patched always), cancel (workflow.cancel + workflow.compensation), cleanup (workflow.cleanup)
   - Orchestrate actions: task_claim (task.claimed), task_complete (task.completed), task_fail (task.failed), all check_* (gate.executed), assess_stack (shepherd.* + gate.executed), prepare_synthesis (gate.executed), prepare_delegation (quality.hint.generated conditional), review_triage (review.routed conditional), check_event_emissions (quality.hint.generated conditional)

4. [REFACTOR] Verify all tests pass, no extraneous autoEmits

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** 001
**Parallelizable:** No (sequential after 001, same file)

---

### Task 003: Include autoEmits in describe handler output
**Implements:** DR-3, DR-10

**TDD Steps:**
1. [RED] Write test: `HandleDescribe_ActionWithAutoEmits_ReturnsEmissionMetadata`
   - File: `servers/exarchos-mcp/src/describe/handler.test.ts`
   - Assert: Calling `handleDescribe({ actions: ['init'] }, workflowActions)` returns result with `data.init.autoEmits` containing `[{ event: 'workflow.started', condition: 'always' }]`
   - Expected failure: `autoEmits` not included in describe output

2. [RED] Write test: `HandleDescribe_ActionWithoutAutoEmits_OmitsField`
   - File: `servers/exarchos-mcp/src/describe/handler.test.ts`
   - Assert: Calling `handleDescribe({ actions: ['get'] }, workflowActions)` returns result where `data.get.autoEmits` is `undefined` (not null, not empty array)
   - Expected failure: Field present as null or empty

3. [GREEN] Modify `handleDescribe` in `describe/handler.ts` to include `autoEmits` when present on the action
   - File: `servers/exarchos-mcp/src/describe/handler.ts`
   - Pattern: include `autoEmits` in action result only when the field is defined on the ToolAction (omit when undefined)

4. [REFACTOR] Clean up type access, ensure existing tests still pass

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** 002
**Parallelizable:** Yes (different files from 004)

---

### Task 004: Derive Runbook.autoEmits from ToolAction.autoEmits
**Implements:** DR-5

**TDD Steps:**
1. [RED] Write test: `ComputeRunbookAutoEmits_TaskCompletion_MatchesDeclared`
   - File: `servers/exarchos-mcp/src/runbooks/drift.test.ts`
   - Assert: `computeRunbookAutoEmits(TASK_COMPLETION)` returns sorted array matching `['gate.executed', 'task.completed']`
   - Expected failure: `computeRunbookAutoEmits` not exported

2. [RED] Write test: `RunbookDrift_AutoEmitsMatchComputedFromToolActions`
   - File: `servers/exarchos-mcp/src/runbooks/drift.test.ts`
   - Assert: For every runbook in `ALL_RUNBOOKS`, the sorted declared `autoEmits` matches sorted `computeRunbookAutoEmits(runbook)`
   - Expected failure: Function not implemented

3. [GREEN] Implement `computeRunbookAutoEmits` utility
   - File: `servers/exarchos-mcp/src/runbooks/compute.ts` (new file)
   - Import `findActionInRegistry` from registry, iterate non-native steps, collect autoEmits events, deduplicate and sort

4. [GREEN] Update declared `autoEmits` on runbook definitions if computed value differs
   - File: `servers/exarchos-mcp/src/runbooks/definitions.ts`
   - Fix any runbooks where declared doesn't match computed (e.g., SHEPHERD_ITERATION may need 'shepherd.iteration' and 'gate.executed' added)

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** 002
**Parallelizable:** Yes (different files from 003)

---

### Task 005: Playbook serialization functions
**Implements:** DR-6

**TDD Steps:**
1. [RED] Write test: `SerializePlaybooks_Feature_ReturnsAllPhases`
   - File: `servers/exarchos-mcp/src/workflow/playbooks.test.ts`
   - Assert: `serializePlaybooks('feature')` returns `{ workflowType: 'feature', phases: {...}, phaseCount: N }` where phases includes keys 'ideate', 'plan', 'delegate', 'review', 'synthesize', 'completed', 'cancelled', 'blocked'
   - Expected failure: `serializePlaybooks` not exported

2. [RED] Write test: `SerializePlaybooks_Unknown_Throws`
   - File: `servers/exarchos-mcp/src/workflow/playbooks.test.ts`
   - Assert: `serializePlaybooks('nonexistent')` throws error
   - Expected failure: Function not implemented

3. [RED] Write test: `ListPlaybookWorkflowTypes_ReturnsKnownTypes`
   - File: `servers/exarchos-mcp/src/workflow/playbooks.test.ts`
   - Assert: `listPlaybookWorkflowTypes()` returns array containing 'feature', 'debug', 'refactor'
   - Expected failure: Function not exported

4. [GREEN] Implement in `playbooks.ts`:
   - File: `servers/exarchos-mcp/src/workflow/playbooks.ts`
   - Add `SerializedPlaybooks` and `SerializedPhasePlaybook` interfaces
   - `serializePlaybooks`: iterate registry entries matching workflowType, build phases map, throw if no entries found
   - `listPlaybookWorkflowTypes`: collect distinct workflowType values from registry

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes (independent of Phase 2)

---

### Task 006: Playbook describe parameter and handler
**Implements:** DR-7, DR-10

**TDD Steps:**
1. [RED] Write test: `HandleDescribe_PlaybookFeature_ReturnsSerializedPlaybooks`
   - File: `servers/exarchos-mcp/src/describe/handler.test.ts`
   - Assert: `handleDescribe({ playbook: 'feature' }, workflowActions)` returns `{ success: true, data: { playbook: { workflowType: 'feature', phases: {...} } } }`
   - Expected failure: `playbook` parameter not recognized

2. [RED] Write test: `HandleDescribe_PlaybookAll_ReturnsWorkflowTypeList`
   - File: `servers/exarchos-mcp/src/describe/handler.test.ts`
   - Assert: `handleDescribe({ playbook: 'all' }, workflowActions)` returns list of workflow types
   - Expected failure: Not implemented

3. [RED] Write test: `HandleDescribe_PlaybookUnknown_ReturnsErrorWithValidTargets`
   - File: `servers/exarchos-mcp/src/describe/handler.test.ts`
   - Assert: `handleDescribe({ playbook: 'nonexistent' }, workflowActions)` returns `{ success: false, error: { code: 'UNKNOWN_WORKFLOW_TYPE', validTargets: [...] } }`
   - Expected failure: Not implemented

4. [RED] Write test: `HandleDescribe_NoParams_ErrorIncludesPlaybookInExpectedShape`
   - File: `servers/exarchos-mcp/src/describe/handler.test.ts`
   - Assert: `handleDescribe({}, workflowActions)` error `expectedShape` includes `playbook` key
   - Expected failure: `expectedShape` only has `actions` and `topology`

5. [GREEN] Add `playbook` parameter to `workflowDescribeSchema` in `registry.ts`
   - File: `servers/exarchos-mcp/src/registry.ts`

6. [GREEN] Add `handlePlaybookDescribe()` to `describe/handler.ts` modeled on `handleTopologyDescribe()`
   - File: `servers/exarchos-mcp/src/describe/handler.ts`
   - Wire into `handleDescribe`: check `hasPlaybook`, call handler, add to results
   - Update validation: at least one of actions/topology/playbook required

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** 003, 005
**Parallelizable:** No (sequential — shares describe/handler.ts with 003)

---

### Task 007: Schema introspection adapter for playbooks
**Implements:** DR-8

**TDD Steps:**
1. [RED] Write test: `ResolvePlaybookRef_Feature_ReturnsSerializedPlaybooks`
   - File: `servers/exarchos-mcp/src/adapters/schema-introspection.test.ts`
   - Assert: `resolvePlaybookRef('feature')` returns object with `workflowType: 'feature'`
   - Expected failure: `resolvePlaybookRef` not exported

2. [RED] Write test: `ResolvePlaybookRef_NoArg_ReturnsWorkflowTypeList`
   - File: `servers/exarchos-mcp/src/adapters/schema-introspection.test.ts`
   - Assert: `resolvePlaybookRef()` returns string array containing 'feature', 'debug', 'refactor'
   - Expected failure: Not implemented

3. [GREEN] Implement `resolvePlaybookRef` in `schema-introspection.ts`
   - File: `servers/exarchos-mcp/src/adapters/schema-introspection.ts`
   - Delegate to `serializePlaybooks` / `listPlaybookWorkflowTypes` from playbooks.ts

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** 005
**Parallelizable:** Yes (different files from 006)

---

### Task 008: Skill refactoring to reference describe
**Implements:** DR-9

**Steps:**
1. Audit each skill `SKILL.md` for duplicated content:
   - Parameter schemas → replace with describe reference
   - Phase transition tables → replace with playbook describe reference
   - Guard prerequisite tables → replace with playbook describe reference
   - Keep: strategy content, anti-patterns, when-to-use guidance

2. Add "Schema Discovery" section to each skill that references MCP tools:
   ```markdown
   ### Schema Discovery
   Use `exarchos_workflow({ action: "describe", actions: ["set", "init"] })` for
   parameter schemas and `exarchos_workflow({ action: "describe", playbook: "<type>" })`
   for phase transitions, guards, and playbook guidance.
   ```

3. Skills to modify (those with `metadata.mcp-server: exarchos`):
   - `skills/brainstorming/SKILL.md`
   - `skills/debug/SKILL.md`
   - `skills/delegation/SKILL.md` (largest — most duplication)
   - `skills/implementation-planning/SKILL.md`
   - `skills/quality-review/SKILL.md`
   - `skills/refactor/SKILL.md`
   - `skills/shepherd/SKILL.md`
   - `skills/spec-review/SKILL.md`
   - `skills/synthesis/SKILL.md`
   - `skills/workflow-state/SKILL.md`

4. Skills to skip (no MCP dependency):
   - `skills/cleanup/SKILL.md`
   - `skills/git-worktrees/SKILL.md`

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** 003, 006
**Parallelizable:** No (final task)

## Parallelization Strategy

```
Wave 1 (parallel):
  ├── Task 001: AutoEmission type + ToolAction field      [registry.ts]
  └── Task 005: Playbook serialization functions           [playbooks.ts]

Wave 2 (parallel):
  ├── Task 002: Populate autoEmits + drift tests           [registry.ts, registry.test.ts]
  └── Task 007: Schema introspection adapter               [schema-introspection.ts]

Wave 3 (parallel):
  ├── Task 003: autoEmits in describe output               [describe/handler.ts]
  └── Task 004: Derive Runbook.autoEmits                   [runbooks/]

Wave 4 (sequential):
  └── Task 006: Playbook describe parameter + handler      [describe/handler.ts, registry.ts]

Wave 5 (sequential):
  └── Task 008: Skill refactoring                          [skills/*/SKILL.md]
```

**File conflict analysis:** No two tasks in the same wave modify the same file. Tasks 003 and 006 both modify `describe/handler.ts` — sequenced into Wave 3 and Wave 4 respectively.

## Deferred Items

None — all design requirements covered.

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Drift tests validate autoEmits against EVENT_EMISSION_REGISTRY
- [ ] Drift tests validate runbook autoEmits against computed values
- [ ] Playbook serialization returns correct data for all workflow types
- [ ] Describe handler returns autoEmits and playbook data
- [ ] Skills reference describe instead of duplicating schemas
- [ ] Code coverage meets standards
- [ ] Ready for review
