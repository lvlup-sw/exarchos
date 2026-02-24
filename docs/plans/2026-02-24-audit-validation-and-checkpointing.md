# Implementation Plan: Audit Validation & Checkpointing

## Source Design
Link: `docs/designs/2026-02-24-audit-validation-and-checkpointing.md`

## Scope
**Target:** Full design — all 4 workstreams (playbooks, validation remediation, /rehydrate, eval suite)
**Excluded:** None

## Summary
- Total tasks: 16
- Parallel groups: 4 (across 2 phases)
- Estimated test count: 42
- Design coverage: 4 of 4 workstreams covered

## Spec Traceability

| Design Section | Tasks | Coverage |
|----------------|-------|----------|
| A.1 Playbook Data Structure | 1 | Type definitions, getPlaybook, renderPlaybook |
| A.2 Playbook Registry | 2, 3, 4 | All 36 phases across 3 workflow types |
| A.3/A.4 Context Assembly Integration | 6 | Behavioral section in context.md |
| A.5 Playbook Access via MCP | 7 | Field projection in exarchos_workflow get |
| A.6 Validation Script Cross-Reference | 13 | validate-phase-coverage.sh |
| B.1 Fix reconcile-state.sh | 10 | Valid phases updated + test |
| B.2 Fix pre-synthesis-check.sh | 11 | Polish/debug handling + test |
| B.3 Wire Unwired Scripts | 12 | 4 scripts into 3 skills |
| B.4 Fix Stale Eval Datasets | 14 | regression.jsonl + golden.jsonl |
| B.5 Meta-Validation Script | 13 | validate-phase-coverage.sh + test |
| C.1 /rehydrate Command | 9 | New command + /resume deprecation |
| C.3 SessionStart Enhancement | 8 | behavioralGuidance field |
| D.1 New Dataset | 15 | 6 compaction-behavioral eval cases |
| D.2 Suite Configuration Update | 15 | Reliability suite.json updated |
| D.3 Integration Test | 16 | Pre-compact → session-start round-trip |
| HSM Coverage Invariant | 5 | Property test: all states have playbooks |

## Task Breakdown

---

### Task 1: PhasePlaybook type, getPlaybook(), and renderPlaybook()

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests: `getPlaybook_ValidPhase_ReturnsPlaybook`, `getPlaybook_UnknownPhase_ReturnsNull`, `getPlaybook_TerminalPhase_ReturnsMinimalPlaybook`, `renderPlaybook_DelegatePhase_IncludesToolsAndEvents`, `renderPlaybook_TerminalPhase_ReturnsMinimalGuidance`
   - File: `servers/exarchos-mcp/src/workflow/playbooks.test.ts`
   - Expected failure: Module `playbooks.ts` does not exist
   - Run: `npm run test:run` — MUST FAIL

2. [GREEN] Create `playbooks.ts` with:
   - `PhasePlaybook` interface (phase, workflowType, skill, skillRef, tools, events, transitionCriteria, guardPrerequisites, validationScripts, humanCheckpoint, compactGuidance)
   - `ToolInstruction` and `EventInstruction` interfaces
   - `getPlaybook(workflowType: string, phase: string): PhasePlaybook | null` function (initially with only a single feature:ideate entry for the test to pass)
   - `renderPlaybook(playbook: PhasePlaybook): string` that produces the markdown behavioral guidance section
   - File: `servers/exarchos-mcp/src/workflow/playbooks.ts`
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] Extract rendering helpers if markdown assembly is complex
   - Run: `npm run test:run` — MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail because module doesn't exist
- [ ] Tests pass with skeleton implementation
- [ ] renderPlaybook produces markdown with Tools, Events, Transition, Scripts sections

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`
**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 2: Feature workflow playbook entries (9 phases)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests for each feature phase: `getPlaybook_FeatureIdeate_HasBrainstormingSkill`, `getPlaybook_FeaturePlan_HasPlanningSkill`, `getPlaybook_FeaturePlanReview_IsHumanCheckpoint`, `getPlaybook_FeatureDelegate_HasEventInstructions`, `getPlaybook_FeatureReview_HasStaticAnalysisScript`, `getPlaybook_FeatureSynthesize_HasPreSynthesisScript`, `getPlaybook_FeatureCompleted_IsMinimal`, `getPlaybook_FeatureCancelled_IsMinimal`, `getPlaybook_FeatureBlocked_HasUnblockGuidance`
   - File: `servers/exarchos-mcp/src/workflow/playbooks.test.ts` (append to existing)
   - Expected failure: getPlaybook returns null for unpopulated phases
   - Run: `npm run test:run` — MUST FAIL

2. [GREEN] Populate the playbook registry with all 9 feature phases:
   - `ideate`: skill=brainstorming, tools=[exarchos_workflow init/set], events=[], scripts=[verify-ideate-artifacts.sh], humanCheckpoint=false
   - `plan`: skill=implementation-planning, tools=[exarchos_workflow set], events=[], scripts=[generate-traceability.sh, verify-plan-coverage.sh], humanCheckpoint=false
   - `plan-review`: skill=implementation-planning, tools=[exarchos_workflow set], events=[], scripts=[verify-plan-coverage.sh], humanCheckpoint=true
   - `delegate`: skill=delegation, tools=[exarchos_workflow get/set, exarchos_event append/batch_append, exarchos_orchestrate task_complete/task_claim], events=[task.assigned, team.spawned, team.teammate.dispatched, team.disbanded, gate.executed], scripts=[setup-worktree.sh, verify-worktree.sh, post-delegation-check.sh], humanCheckpoint=false
   - `review`: skill=quality-review, tools=[exarchos_workflow get/set, exarchos_event append, exarchos_view tasks], events=[gate.executed], scripts=[static-analysis-gate.sh, security-scan.sh, review-verdict.sh, verify-review-triage.sh], humanCheckpoint=false
   - `synthesize`: skill=synthesis, tools=[exarchos_workflow get/set, exarchos_event append, graphite submit], events=[gate.executed], scripts=[pre-synthesis-check.sh, reconstruct-stack.sh, check-coderabbit.sh], humanCheckpoint=true
   - `completed`, `cancelled`, `blocked`: minimal playbooks
   - File: `servers/exarchos-mcp/src/workflow/playbooks.ts`
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] Ensure consistent structure across entries
   - Run: `npm run test:run` — MUST STAY GREEN

**Verification:**
- [ ] Each feature phase returns a non-null playbook
- [ ] Delegate playbook has >=4 tool instructions and >=3 event instructions
- [ ] Synthesize playbook has humanCheckpoint=true
- [ ] Completed/cancelled playbooks have empty tools array

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`
**Dependencies:** Task 1
**Parallelizable:** Yes (within Group A, parallel with Tasks 3, 4)

---

### Task 3: Debug workflow playbook entries (13 phases)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests for each debug phase: `getPlaybook_DebugTriage_HasTrackSelectionScript`, `getPlaybook_DebugInvestigate_HasTimerScript`, `getPlaybook_DebugRca_HasRcaArtifactGuard`, `getPlaybook_DebugDesign_HasFixDesignGuard`, `getPlaybook_DebugImplement_HasImplementationSkill`, `getPlaybook_DebugValidate_HasValidationGuidance`, `getPlaybook_DebugReview_HasReviewGateScript`, `getPlaybook_HotfixImplement_HasNoWorktree`, `getPlaybook_HotfixValidate_IsHumanCheckpoint`, `getPlaybook_DebugSynthesize_IsHumanCheckpoint`
   - File: `servers/exarchos-mcp/src/workflow/playbooks.test.ts` (append)
   - Expected failure: getPlaybook returns null for debug phases
   - Run: `npm run test:run` — MUST FAIL

2. [GREEN] Populate 13 debug playbook entries:
   - `triage`: skill=debug, scripts=[select-debug-track.sh], transition="Set triage.symptom → investigate"
   - `investigate`: skill=debug, scripts=[select-debug-track.sh, investigation-timer.sh], transition="Set track → rca or hotfix-implement"
   - `rca`: skill=debug, transition="Set artifacts.rca → design"
   - `design`: skill=debug, transition="Set artifacts.fixDesign → debug-implement"
   - `debug-implement`: skill=debug, transition="Auto-pass → debug-validate"
   - `debug-validate`: skill=debug, transition="Set validation.testsPass → debug-review"
   - `debug-review`: skill=debug, scripts=[debug-review-gate.sh], transition="Reviews pass → synthesize"
   - `hotfix-implement`: skill=debug, transition="Auto-pass → hotfix-validate"
   - `hotfix-validate`: skill=debug, humanCheckpoint=true, transition="validation.testsPass → completed (or synthesize if PR requested)"
   - `synthesize`: skill=synthesis, humanCheckpoint=true, scripts=[pre-synthesis-check.sh, reconstruct-stack.sh]
   - `completed`, `cancelled`, `blocked`: minimal
   - File: `servers/exarchos-mcp/src/workflow/playbooks.ts`
   - Run: `npm run test:run` — MUST PASS

**Verification:**
- [ ] All 13 debug phases return non-null playbooks
- [ ] Triage and investigate reference select-debug-track.sh
- [ ] hotfix-validate is a human checkpoint

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`
**Dependencies:** Task 1
**Parallelizable:** Yes (within Group A, parallel with Tasks 2, 4)

---

### Task 4: Refactor workflow playbook entries (14 phases)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests for each refactor phase: `getPlaybook_RefactorExplore_HasScopeScript`, `getPlaybook_RefactorBrief_HasGoalsGuidance`, `getPlaybook_PolishImplement_HasPolishScopeScript`, `getPlaybook_PolishValidate_HasRefactorValidateScript`, `getPlaybook_PolishUpdateDocs_IsHumanCheckpoint`, `getPlaybook_OverhaulPlan_HasPlanSkill`, `getPlaybook_OverhaulDelegate_HasDelegationSkill`, `getPlaybook_OverhaulReview_HasReviewSkill`, `getPlaybook_OverhaulUpdateDocs_HasDocLinksScript`, `getPlaybook_RefactorSynthesize_HasSynthesisSkill`
   - File: `servers/exarchos-mcp/src/workflow/playbooks.test.ts` (append)
   - Expected failure: getPlaybook returns null for refactor phases
   - Run: `npm run test:run` — MUST FAIL

2. [GREEN] Populate 14 refactor playbook entries:
   - `explore`: skill=refactor, scripts=[assess-refactor-scope.sh], transition="Set explore.scopeAssessment → brief"
   - `brief`: skill=refactor, transition="Set track → polish-implement or overhaul-plan"
   - `polish-implement`: skill=refactor, scripts=[check-polish-scope.sh], transition="Auto-pass → polish-validate"
   - `polish-validate`: skill=refactor, scripts=[validate-refactor.sh], transition="Set validation.testsPass → polish-update-docs"
   - `polish-update-docs`: skill=refactor, humanCheckpoint=true, transition="Set validation.docsUpdated → completed"
   - `overhaul-plan`: skill=implementation-planning, transition="Set artifacts.plan → overhaul-delegate"
   - `overhaul-delegate`: skill=delegation, events=[task.assigned, team.spawned, etc.], transition="All tasks complete → overhaul-review"
   - `overhaul-review`: skill=quality-review, scripts=[static-analysis-gate.sh, security-scan.sh, review-verdict.sh], transition="Reviews pass → overhaul-update-docs"
   - `overhaul-update-docs`: skill=refactor, scripts=[verify-doc-links.sh], transition="Set validation.docsUpdated → synthesize"
   - `synthesize`: skill=synthesis, humanCheckpoint=true, scripts=[pre-synthesis-check.sh]
   - `completed`, `cancelled`, `blocked`: minimal
   - File: `servers/exarchos-mcp/src/workflow/playbooks.ts`
   - Run: `npm run test:run` — MUST PASS

**Verification:**
- [ ] All 14 refactor phases return non-null playbooks
- [ ] Polish track has no synthesize step (polish-update-docs → completed)
- [ ] Overhaul track references delegation and review skills

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`
**Dependencies:** Task 1
**Parallelizable:** Yes (within Group A, parallel with Tasks 2, 3)

---

### Task 5: HSM-playbook coverage property test + content adequacy

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write property test: `allHsmStates_HavePlaybookEntry_NoneOmitted`
   - File: `servers/exarchos-mcp/src/workflow/playbooks.property.test.ts`
   - Import HSM definitions from `hsm-definitions.ts`, iterate all state IDs for each workflow type, assert `getPlaybook(workflowType, stateId) !== null` for every non-compound state
   - Also: `allPlaybookEntries_ReferenceExistingHsmStates_NoneOrphaned` — every playbook key corresponds to a real HSM state
   - Also content adequacy tests for every non-terminal playbook:
     - `compactGuidance_MentionsAtLeastOneTool` — for each playbook with non-empty `tools`, assert `compactGuidance` contains at least one tool name from the `tools` array
     - `compactGuidance_MentionsAtLeastOneEvent` — for each playbook with non-empty `events`, assert `compactGuidance` contains at least one event type from the `events` array
     - `renderPlaybook_ContainsAllToolNames` — `renderPlaybook()` output includes every tool name from the playbook's `tools` array
     - `renderPlaybook_ContainsAllEventTypes` — `renderPlaybook()` output includes every event type from the playbook's `events` array
     - `humanCheckpointPlaybooks_GuidanceMentionsWaitOrPause` — for playbooks with `humanCheckpoint: true`, assert `compactGuidance` contains "wait", "pause", "confirm", or "checkpoint"
   - Expected failure: If any phase was missed in Tasks 2-4 or content is incomplete
   - Run: `npm run test:run` — MUST FAIL (or pass if 2-4 were complete)

2. [GREEN] Fix any missing playbook entries or inadequate content discovered by the tests
   - File: `servers/exarchos-mcp/src/workflow/playbooks.ts`
   - Run: `npm run test:run` — MUST PASS

**Verification:**
- [ ] Property test covers all 3 workflow types
- [ ] No HSM state ID is missing from playbook registry
- [ ] No playbook entry references a non-existent HSM state
- [ ] Every non-terminal playbook's compactGuidance mentions its tools and events
- [ ] renderPlaybook output is comprehensive (all tools and event types present)
- [ ] Human checkpoint playbooks include wait/pause language

**testingStrategy:** `{ "exampleTests": true, "propertyTests": true, "benchmarks": false, "properties": ["completeness: every HSM state has a playbook entry", "consistency: every playbook key is a valid HSM state", "content-adequacy: compactGuidance references tools and events", "render-fidelity: renderPlaybook includes all tool and event names"] }`
**Dependencies:** Tasks 2, 3, 4
**Parallelizable:** No (validation of Tasks 2-4)

---

### Task 6: Context assembly behavioral section

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests: `handleAssembleContext_ActiveWorkflow_IncludesBehavioralSection`, `handleAssembleContext_BehavioralSection_ContainsToolInstructions`, `handleAssembleContext_BehavioralSection_ContainsEventInstructions`, `handleAssembleContext_BehavioralSection_NeverTruncated`, `handleAssembleContext_UnknownPhase_OmitsBehavioralSection`
   - File: `servers/exarchos-mcp/src/cli-commands/assemble-context.test.ts` (append to existing)
   - Expected failure: No behavioral section in context output
   - Run: `npm run test:run` — MUST FAIL

2. [GREEN] Update `assemble-context.ts`:
   - Import `getPlaybook`, `renderPlaybook` from `../workflow/playbooks.js`
   - After computing `phase` and `workflowType` (line ~296), call `getPlaybook(workflowType, phase)`
   - If playbook found, call `renderPlaybook(playbook)` to produce the behavioral markdown
   - Add `behavioral` field to `ContextSections` interface
   - In `truncateToCharBudget`, include `behavioral` in `coreParts` (always kept, never truncated) alongside header, taskTable, nextAction
   - File: `servers/exarchos-mcp/src/cli-commands/assemble-context.ts`
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] Ensure behavioral section stays under 600 chars to preserve budget for other sections
   - Run: `npm run test:run` — MUST STAY GREEN

**Verification:**
- [ ] Context.md for a delegate-phase workflow includes "Behavioral Guidance" heading
- [ ] Behavioral section lists tool names, event types, and transition criteria
- [ ] Behavioral section is never dropped during truncation (it's in core parts)

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`
**Dependencies:** Task 1 (needs playbooks module)
**Parallelizable:** Yes (Group B, parallel with Tasks 7, 8)

---

### Task 7: Playbook field projection in exarchos_workflow get

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests: `handleGet_PlaybookField_ReturnsPhasePlaybook`, `handleGet_PlaybookField_NullForUnknownPhase`, `handleGet_PlaybookWithOtherFields_ReturnsBoth`
   - File: `servers/exarchos-mcp/src/workflow/tools.test.ts` (append to existing, or new section)
   - Expected failure: `playbook` field not recognized
   - Run: `npm run test:run` — MUST FAIL

2. [GREEN] Update `handleGet` in `tools.ts`:
   - When `fields` includes `"playbook"`, call `getPlaybook(state.workflowType, state.phase)`
   - Include the playbook object in the response under the `playbook` key
   - File: `servers/exarchos-mcp/src/workflow/tools.ts`
   - Run: `npm run test:run` — MUST PASS

**Verification:**
- [ ] `exarchos_workflow get featureId="x" fields=["playbook"]` returns the PhasePlaybook for current phase
- [ ] Playbook field works alongside other field projections

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`
**Dependencies:** Task 1 (needs playbooks module)
**Parallelizable:** Yes (Group B, parallel with Tasks 6, 8)

---

### Task 8: SessionStart behavioralGuidance field

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests: `handleSessionStart_WithCheckpoint_IncludesBehavioralGuidance`, `handleSessionStart_BehavioralGuidance_MatchesPhasePlaybook`, `handleSessionStart_NoCheckpoint_ActiveWorkflow_IncludesBehavioralGuidance`, `handleSessionStart_TerminalPhase_NoBehavioralGuidance`
   - File: `servers/exarchos-mcp/src/cli-commands/session-start.test.ts` (append)
   - Expected failure: No `behavioralGuidance` field in result
   - Run: `npm run test:run` — MUST FAIL

2. [GREEN] Update `session-start.ts`:
   - Import `getPlaybook`, `renderPlaybook` from `../workflow/playbooks.js`
   - In the checkpoint path (line ~511-558): after building workflows, look up `getPlaybook(cp.phase's workflowType, cp.phase)` for the first active workflow and render it into a `behavioralGuidance` field on `SessionStartResult`
   - In the no-checkpoint path (line ~560-583): for active workflows, similarly look up playbook for the first non-terminal workflow
   - Add `behavioralGuidance?: string` to `SessionStartResult` interface
   - File: `servers/exarchos-mcp/src/cli-commands/session-start.ts`
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] Extract playbook lookup into a helper to avoid duplication between checkpoint and no-checkpoint paths
   - Run: `npm run test:run` — MUST STAY GREEN

**Verification:**
- [ ] SessionStart result includes behavioral guidance when active workflow exists
- [ ] Behavioral guidance matches the rendered playbook for the current phase
- [ ] No behavioral guidance for terminal phases (completed, cancelled)

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`
**Dependencies:** Task 1 (needs playbooks module)
**Parallelizable:** Yes (Group B, parallel with Tasks 6, 7)

---

### Task 9: /rehydrate command and /resume deprecation

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Verify no `commands/rehydrate.md` exists
   - Expected: file not found

2. [GREEN] Create `commands/rehydrate.md`:
   - Frontmatter: name, description ("Re-inject workflow state and behavioral guidance")
   - Body: When to Use (after compaction, mid-session drift, session resume), Process (discover active workflow → fetch state + playbook → render behavioral context → output rehydration), Output Format (phase, tasks, behavioral guidance, next action, artifacts)
   - Update `commands/resume.md`: Add deprecation notice at top pointing to `/rehydrate`. Keep functional for backward compatibility.
   - Files: `commands/rehydrate.md` (new), `commands/resume.md` (edit)

**Verification:**
- [ ] `/rehydrate` command file exists with valid frontmatter
- [ ] `/resume` command has deprecation notice

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`
**Dependencies:** Task 7 (needs playbook field in exarchos_workflow get)
**Parallelizable:** No (depends on Task 7)

---

### Task 10: Fix reconcile-state.sh valid phases

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test cases in `reconcile-state.test.sh` for:
   - `reconcile_RefactorPolishImplement_ValidPhase` — assert exit 0 for a refactor workflow in `polish-implement`
   - `reconcile_RefactorOverhaulDelegate_ValidPhase` — assert exit 0 for `overhaul-delegate`
   - `reconcile_DebugRca_ValidPhase` — assert exit 0 for debug workflow in `rca`
   - `reconcile_DebugHotfixImplement_ValidPhase` — assert exit 0 for `hotfix-implement`
   - `reconcile_FeatureBlocked_ValidPhase` — assert exit 0 for feature workflow in `blocked`
   - Run: tests MUST FAIL (script rejects these phases as invalid)

2. [GREEN] Update `reconcile-state.sh` (L153-169) to match HSM phase enums:
   - Feature: `ideate plan plan-review delegate review synthesize completed cancelled blocked`
   - Debug: `triage investigate rca design debug-implement debug-validate debug-review hotfix-implement hotfix-validate synthesize completed cancelled blocked`
   - Refactor: `explore brief polish-implement polish-validate polish-update-docs overhaul-plan overhaul-delegate overhaul-review overhaul-update-docs synthesize completed cancelled blocked`
   - File: `scripts/reconcile-state.sh`
   - Run: tests MUST PASS

**Verification:**
- [ ] All valid HSM phases accepted
- [ ] Invalid phase names still rejected
- [ ] Existing passing tests still pass

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`
**Dependencies:** None
**Parallelizable:** Yes (Group C)

---

### Task 11: Fix pre-synthesis-check.sh phase handling

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test cases in `pre-synthesis-check.test.sh` for:
   - `preSynthesis_RefactorPolishValidate_CorrectMessage` — assert appropriate "polish track completes directly" message
   - `preSynthesis_RefactorOverhaulPlan_ListsAllRemainingTransitions` — assert all overhaul transitions listed
   - `preSynthesis_DebugValidate_UsesCorrectPhaseName` — assert uses `debug-validate` not bare `validate`
   - `preSynthesis_DebugHotfixValidate_CorrectMessage` — assert appropriate hotfix message
   - Run: tests MUST FAIL

2. [GREEN] Update `pre-synthesis-check.sh` (L183-213):
   - Refactor case: add `polish-implement|polish-validate|polish-update-docs` case that explains polish track goes to completed directly (no synthesize)
   - Add `overhaul-plan` case with full transition chain
   - Debug case: replace bare `validate` with `debug-validate|debug-review|hotfix-validate` cases
   - File: `scripts/pre-synthesis-check.sh`
   - Run: tests MUST PASS

**Verification:**
- [ ] Polish-track phases get informative error (not "manual phase advancement needed")
- [ ] Overhaul-plan lists all remaining transitions
- [ ] Debug phases use correct HSM phase names
- [ ] Existing passing tests unchanged

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`
**Dependencies:** None
**Parallelizable:** Yes (Group C, parallel with Task 10)

---

### Task 12: Wire unwired scripts into skills

**Phase:** GREEN (content-only — no TDD structure, validated by skill validation tests)

**Steps:**
1. Update `skills/synthesis/SKILL.md` or `skills/synthesis/references/synthesis-steps.md`:
   - Add `check-benchmark-regression.sh` as an optional gate: "If `state.verification.hasBenchmarks` is true, run `scripts/check-benchmark-regression.sh` — exit 0: within threshold, exit 1: regression detected (stop synthesis)"
   - Add immediately after the existing pre-synthesis-check.sh reference

2. Update `skills/shepherd/SKILL.md`:
   - Replace or augment `check-coderabbit.sh` with `coderabbit-review-gate.sh`: "Use `scripts/coderabbit-review-gate.sh` for sophisticated CodeRabbit review management: handles round counting, severity classification (high/medium/low), auto-resolution of outdated comments, and approve/wait/escalate decisions"
   - Add `check-pr-comments.sh` as a gate before requesting approval: "Before requesting human approval, run `scripts/check-pr-comments.sh` to verify all inline PR review comments have replies — exit 0: all addressed, exit 1: unaddressed comments remain"

3. Update `skills/quality-review/SKILL.md`:
   - Add `verify-review-triage.sh` as a pre-check: "Before starting quality review, run `scripts/verify-review-triage.sh` to verify review triage routing was applied correctly — exit 0: triage correct, exit 1: triage issues found"

**Verification:**
- [ ] Each script name appears in at least one SKILL.md or reference file
- [ ] Exit code semantics documented alongside each reference
- [ ] Run existing `validate-*-skill.test.sh` tests for affected skills — all pass

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`
**Dependencies:** None
**Parallelizable:** Yes (Group D)

---

### Task 13: Create validate-phase-coverage.sh meta-validation

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test cases in `validate-phase-coverage.test.sh`:
   - `validate_AllPhasesHavePlaybooks_ExitZero` — provide a complete playbook JSON, assert exit 0
   - `validate_MissingPhase_ExitOne` — provide a playbook JSON missing one phase, assert exit 1 with gap message
   - `validate_OrphanedScript_ExitOne` — provide a playbook referencing a non-existent script, assert exit 1
   - `validate_UsageError_ExitTwo` — call with no args, assert exit 2
   - Run: tests MUST FAIL (script doesn't exist)

2. [GREEN] Create `scripts/validate-phase-coverage.sh`:
   - Inputs: `--playbook-json <path>` (exported from playbooks registry), `--scripts-dir <path>`
   - Check 1: Every non-final phase in each workflow type has a playbook entry (compare against known phase lists)
   - Check 2: Every `validationScripts` entry in every playbook resolves to an existing file
   - Check 3: Every `*.sh` validation script in scripts-dir is referenced by at least one playbook (detects unwired scripts). Exclude known utility scripts (build-*.ts, new-project.sh, sync-*.sh, validate-phase-coverage.sh itself).
   - Exit: 0 = all covered, 1 = gaps found, 2 = usage error
   - File: `scripts/validate-phase-coverage.sh`
   - Run: tests MUST PASS

**Verification:**
- [ ] Exits 0 when all phases covered and all scripts wired
- [ ] Exits 1 with descriptive message for each gap type
- [ ] Exits 2 on missing arguments

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`
**Dependencies:** None (tests use synthetic playbook JSON, not actual playbooks.ts output)
**Parallelizable:** Yes (Group C, parallel with Tasks 10, 11)

---

### Task 14: Fix refactor eval datasets

**Phase:** GREEN (data-only change)

**Steps:**
1. Update `evals/refactor/datasets/regression.jsonl`:
   - Case `ref-r001`: Change `brief → implement → validate` to `brief → polish-implement → polish-validate → polish-update-docs → completed` (polish track)
   - Case `ref-r002`: Change to overhaul track phases: `brief → overhaul-plan → overhaul-delegate → overhaul-review → overhaul-update-docs → synthesize → completed`
   - Update expected patterns to match new phase names

2. Update `evals/refactor/datasets/golden.jsonl`:
   - Update all 3 cases to use correct HSM phase names
   - Split between polish and overhaul track scenarios

**Verification:**
- [ ] All phase names in trace_events match valid HSM state IDs
- [ ] Expected patterns updated to match new phase names
- [ ] Run eval harness dry-run to verify JSONL parses correctly

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`
**Dependencies:** None
**Parallelizable:** Yes (Group E, parallel with Task 15)

---

### Task 15: Create compaction-behavioral eval dataset + update suite

**Phase:** GREEN (data-only)

**Steps:**
1. Create `evals/reliability/datasets/compaction-behavioral.jsonl` with 6 cases:
   - `rel-compact-beh-001`: Agent emits events after compaction (delegate phase — asserts task.assigned, task.completed, gate.executed post-compaction)
   - `rel-compact-beh-002`: Agent uses MCP tools proactively (review phase — asserts tool.call min:2, gate.executed min:2)
   - `rel-compact-beh-003`: Agent runs validation scripts (synthesize phase — asserts gate.executed for pre-synthesis-check and reconstruct-stack)
   - `rel-compact-beh-004`: Debug thorough track compaction (rca phase — asserts tool.call min:2, workflow.transition forward)
   - `rel-compact-beh-005`: Refactor polish track compaction (polish-validate — asserts gate.executed for validate-refactor, workflow.transition to polish-update-docs)
   - `rel-compact-beh-006`: /rehydrate mid-session recovery (asserts command.invoked, then task.assigned and gate.executed resume)
   - Use exact format from design doc section D.1

2. Update `evals/reliability/suite.json`:
   - Add `"compaction-behavioral"` dataset entry pointing to `./datasets/compaction-behavioral.jsonl`
   - Update description to include "compaction-behavioral"

**Verification:**
- [ ] All 6 cases parse as valid JSONL
- [ ] Each case has expected patterns with reasonable assertions
- [ ] Suite.json references the new dataset correctly

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`
**Dependencies:** None
**Parallelizable:** Yes (Group E, parallel with Task 14)

---

### Task 16: Integration test — pre-compact → session-start round-trip

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write integration tests:
   - `preCompactToSessionStart_DelegatePhase_BehavioralGuidanceIncluded`: Create state file in delegate phase → call handlePreCompact → verify context.md has behavioral section → call handleSessionStart → verify behavioralGuidance populated
   - `preCompactToSessionStart_ReviewPhase_HasToolInstructions`: Same flow for review phase → verify tools listed
   - `preCompactToSessionStart_TerminalPhase_NoBehavioralGuidance`: Create completed state → verify no behavioral section
   - `preCompactToSessionStart_EveryWorkflowType_HasBehavioral`: Parameterized test across feature/debug/refactor with representative phases
   - File: `servers/exarchos-mcp/src/cli-commands/assemble-context.integration.test.ts`
   - Expected failure: No behavioral section in generated context
   - Run: `npm run test:run` — MUST FAIL

2. [GREEN] Tests should pass once Tasks 6 and 8 are complete (this task validates the integration)
   - Run: `npm run test:run` — MUST PASS

**Verification:**
- [ ] Round-trip preserves phase, tasks, and adds behavioral guidance
- [ ] Behavioral guidance contains tool names and event types
- [ ] Terminal phases produce no behavioral guidance

**testingStrategy:** `{ "exampleTests": true, "propertyTests": true, "benchmarks": false, "properties": ["round-trip: for any valid (workflowType, phase), pre-compact followed by session-start produces non-empty behavioralGuidance"] }`
**Dependencies:** Tasks 5, 6, 8 (needs complete playbooks + context assembly + session-start changes)
**Parallelizable:** No (final integration validation)

---

## Parallelization Strategy

### Phase 1 — Foundation + Independent Streams (parallel)

All four groups run simultaneously in separate worktrees:

| Worktree | Tasks | Files Touched | Dependencies |
|----------|-------|---------------|-------------|
| **A: Playbook Module** | 1 → (2, 3, 4 parallel) → 5 | `servers/exarchos-mcp/src/workflow/playbooks.ts`, `*.test.ts`, `*.property.test.ts` | None |
| **B: Script Fixes** | 10, 11, 13 (parallel) | `scripts/reconcile-state.sh`, `scripts/pre-synthesis-check.sh`, `scripts/validate-phase-coverage.sh`, `*.test.sh` | None |
| **C: Skill Wiring** | 12 | `skills/synthesis/SKILL.md`, `skills/shepherd/SKILL.md`, `skills/quality-review/SKILL.md` | None |
| **D: Eval Datasets** | 14, 15 (parallel) | `evals/refactor/datasets/`, `evals/reliability/datasets/`, `evals/reliability/suite.json` | None |

### Phase 2 — Integration (parallel, after Phase 1)

| Worktree | Tasks | Files Touched | Dependencies |
|----------|-------|---------------|-------------|
| **E: Context Assembly** | 6, 7, 8 (parallel) | `servers/exarchos-mcp/src/cli-commands/assemble-context.ts`, `session-start.ts`, `*.test.ts` | Worktree A (playbooks module) |
| **F: MCP + Command** | 9 | `servers/exarchos-mcp/src/workflow/tools.ts`, `commands/rehydrate.md`, `commands/resume.md` | Worktree A (playbooks module) |

### Phase 3 — Final Validation (sequential, after Phase 2)

| Task | Dependencies |
|------|-------------|
| 16 (integration test) | Worktrees A + E + F |

```
Phase 1:  [A: playbooks] ──────────────────┐
          [B: script fixes] ────────────────┤
          [C: skill wiring] ────────────────┤
          [D: eval datasets] ───────────────┤
                                            ▼
Phase 2:  [E: context assembly] ────────────┐
          [F: MCP + command] ───────────────┤
                                            ▼
Phase 3:  [16: integration test] ───────────→ Done
```

## Deferred Items

None — all design sections covered.

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] `validate-phase-coverage.sh` exit 0 (meta-validation)
- [ ] All 6 compaction-behavioral eval cases parse and match expected patterns
- [ ] Refactor eval datasets use valid HSM phase names
- [ ] `/rehydrate` command exists with valid frontmatter
- [ ] Context.md includes behavioral guidance section after pre-compact
- [ ] Ready for review
