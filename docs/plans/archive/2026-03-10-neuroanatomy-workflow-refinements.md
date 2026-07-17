# Implementation Plan: Neuroanatomy-Informed Workflow Refinements

## Source Design
Link: `docs/designs/2026-03-10-neuroanatomy-workflow-refinements.md`

## Scope
**Target:** Full design — all 16 design requirements
**Excluded:** None. Dynamic budget estimation (TALE), self-consistency at all gates, and formal compression contracts are explicitly out of scope per design §5.

## Summary
- Total tasks: 6
- Parallel groups: 2
- Estimated test count: ~20 (extending 4 existing test files + new classification tests)
- Design coverage: 16 of 16 DRs covered

## Spec Traceability

| Design Requirement | Task(s) | Verification |
|--------------------|---------|--------------|
| DR-1: Pattern 7 mechanism correction | Task 2 | Manual review |
| DR-2: Pattern 4 attribution correction | Task 2 | Manual review |
| DR-3: Pattern 6 mechanism correction | Task 2 | Manual review |
| DR-4: Three-zone anatomy nuance | Task 2 | Manual review |
| DR-5: API-level effort parameter docs | Task 2 | Manual review |
| DR-6: Claude Code integration specifics | Task 2 | Manual review |
| DR-7: Design phase two-step reasoning | Task 4 | `playbooks.property.test.ts` |
| DR-8: Planning three-stage decomposition | Task 4 | `playbooks.property.test.ts` |
| DR-9: Two-pass review (spec + quality) | Tasks 3, 4 | `decision-runbooks.test.ts` + `playbooks.property.test.ts` |
| DR-10: Effort-aware system prompts | Tasks 3, 4 | `decision-runbooks.test.ts` + `playbooks.property.test.ts` |
| DR-11: Task complexity classification | Tasks 1, 3, 5 | `agents.test.ts` + `decision-runbooks.test.ts` + `prepare-delegation.test.ts` |
| DR-12: AgentSpec effort field | Task 1 | `agents.test.ts` |
| DR-13: Phase transition compression | Task 4 | `playbooks.property.test.ts` |
| DR-14: Carry-forward budgets | Task 4 | `playbooks.property.test.ts` |
| DR-15: Self-consistency at plan-review | Task 4 | `playbooks.property.test.ts` |
| DR-16: Platform abstraction | Tasks 1, 2, 5 | `agents.test.ts` + manual review + `prepare-delegation.test.ts` |

## Task Breakdown

### Task 1: Agent Spec Extensions — Effort Field + Scaffolder
**Implements:** DR-11, DR-12, DR-16
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests in `servers/exarchos-mcp/src/agents/agents.test.ts`:

   - `AgentSpecTypes_EffortField_AcceptsValidValues` — Verify `effort` field accepts `'low' | 'medium' | 'high' | 'max'` and is optional (existing specs without it still compile)
   - `ScaffolderSpec_HasCorrectConfig_SonnetModelLowEffort` — Verify SCAFFOLDER has: `id: 'scaffolder'`, `model: 'sonnet'`, `effort: 'low'`, `isolation: 'worktree'`, expected tools, conciseness-focused system prompt with `{{taskDescription}}` and `{{filePaths}}` template vars, `disallowedTools: ['Agent']`, `resumable: false`
   - `AllSpecs_HaveUniqueIds_NoDuplicates` — Existing test, now must include scaffolder (4 unique IDs)

   Expected failures: `SCAFFOLDER` import fails (doesn't exist yet), `effort` field unknown on type

2. **[GREEN]** Implement:
   - `servers/exarchos-mcp/src/agents/types.ts`:
     - Add `readonly effort?: 'low' | 'medium' | 'high' | 'max'` to `AgentSpec`
     - Add `'scaffolder'` to `AgentSpecId` union
   - `servers/exarchos-mcp/src/agents/definitions.ts`:
     - Add `SCAFFOLDER` agent spec constant with `model: 'sonnet'`, `effort: 'low'`, conciseness-focused system prompt, worktree isolation
     - Add `SCAFFOLDER` to `ALL_AGENT_SPECS` array
     - Export `SCAFFOLDER`

3. **[REFACTOR]** Ensure all existing tests still pass; no changes to existing specs needed since `effort` is optional.

**Files:**
- `servers/exarchos-mcp/src/agents/types.ts`
- `servers/exarchos-mcp/src/agents/definitions.ts`
- `servers/exarchos-mcp/src/agents/agents.test.ts`

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 2: ADR Document Corrections — Patterns 4, 6, 7 + Anatomy + Effort Section
**Implements:** DR-1, DR-2, DR-3, DR-4, DR-5, DR-6
**Phase:** Edit existing document

1. **Pattern 4 (Self-Consistency, §4)** — Add attribution paragraph at the start of "The Research Basis" subsection acknowledging Wang et al. (2022) self-consistency as independent prior art. Reframe Huginn connection: "The convergence observation from Huginn *reinforces* why self-consistency works — independent calls trigger the same reasoning circuits, which converge when the problem is well-defined — but the technique is independently validated."

2. **Pattern 6 (Model Tiering, §6)** — Edit "The Research Basis" subsection. Replace "A model's 'tier' (Haiku vs. Sonnet vs. Opus) roughly corresponds to the depth and sophistication of its reasoning circuits" with corrected explanation: models differ in architecture, training data, optimization targets, and capability profiles. The practical mapping holds empirically as capability matching.

3. **Pattern 7 (Prompt Structure, §7)** — Rewrite "The Research Basis" subsection. Remove the claim about "activating" different layer zones. Replace with attention mask explanation: all tokens pass through all layers; prompt order matters because later tokens attend to all preceding tokens. Context before question → attention to context when processing question. Format spec last → closest to generation point.

4. **Section 5.1 (Three-Zone Anatomy)** — Add nuance paragraph after the ASCII diagram: this is a useful simplification, not a precise anatomical map. Cross-zone computation occurs, attention heads specialize within circuits, boundaries vary by architecture/input/task.

5. **New section after §7 — "Pattern 8: Effort Control Across Platforms"** — Document the `effort` API parameter (`output_config.effort`: `low` | `medium` | `high` | `max`), adaptive thinking (`thinking: {type: "adaptive"}`), and the Claude Code integration path (model selection + prompt-based effort steering). Include effort-to-model mapping table and Anthropic documentation citations.

**Files:**
- `docs/adrs/transformer-neuroanatomy-applied-agent-tooling.md`

**Verification:** Manual review for factual accuracy of mechanism explanations.
**Dependencies:** None
**Parallelizable:** Yes

---

### Task 3: Decision Runbooks — Task Classification + Review Strategy
**Implements:** DR-9, DR-10, DR-11
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:

   In `servers/exarchos-mcp/src/runbooks/decision-runbooks.test.ts`:
   - Add `'task-classification'` and `'review-strategy'` to `DECISION_RUNBOOK_IDS` array — this automatically generates structural invariant tests (≥2 decide steps, ≥1 escalate branch, actionable guidance ≥20 chars, tool='none')

   In `servers/exarchos-mcp/src/runbooks/definitions.test.ts`:
   - Update `AllRunbooks_Count` from 12 to 14
   - Add `TaskClassification_HasCorrectPhase_Delegate` — verify phase is `'delegate'`
   - Add `TaskClassification_HasThreeSteps_ScaffoldingThenComplexityThenContext` — verify 3 decision steps in expected order
   - Add `ReviewStrategy_HasCorrectPhase_Review` — verify phase is `'review'`
   - Add `ReviewStrategy_HasThreeSteps_SizeThenFailuresThenStage` — verify 3 decision steps in expected order

   Expected failures: Imports fail (TASK_CLASSIFICATION, REVIEW_STRATEGY don't exist), ALL_RUNBOOKS.length is 12 not 14

2. **[GREEN]** Implement in `servers/exarchos-mcp/src/runbooks/definitions.ts`:
   - Add `TASK_CLASSIFICATION` runbook (per design §3.3.1):
     - `id: 'task-classification'`, `phase: 'delegate'`
     - Step 1: Is this scaffolding? → scaffolder agent spec (sonnet, effort low)
     - Step 2: Does it involve edge cases/algorithms/multi-dependency? → high complexity (opus, effort high)
     - Step 3: Context package size check → compress if > 500 tokens
   - Add `REVIEW_STRATEGY` runbook (per design §3.3.2):
     - `id: 'review-strategy'`, `phase: 'review'`
     - Step 1: Diff touches > 5 files or spans multiple modules? → two-pass review
     - Step 2: Prior review failure (fix cycle)? → force two-pass
     - Step 3: Spec-review or quality-review? → stage-specific pass guidance
   - Add both to `ALL_RUNBOOKS` array
   - Export both constants

3. **[REFACTOR]** Verify all existing runbook tests still pass (structural invariants, unique IDs, handler resolution).

**Files:**
- `servers/exarchos-mcp/src/runbooks/definitions.ts`
- `servers/exarchos-mcp/src/runbooks/definitions.test.ts`
- `servers/exarchos-mcp/src/runbooks/decision-runbooks.test.ts`

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 4: Playbook compactGuidance Enrichment — Neuroanatomy Patterns
**Implements:** DR-7, DR-8, DR-9, DR-10, DR-11, DR-13, DR-14, DR-15
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests in `servers/exarchos-mcp/src/workflow/playbooks.property.test.ts`:

   Add a new describe block `'Neuroanatomy pattern enrichment'` with tests:
   - `compactGuidance_FeatureIdeate_ContainsCompressionGuidance` — ideate compactGuidance includes "compress" or "summary"
   - `compactGuidance_FeatureIdeate_ContainsTwoStepDesign` — ideate mentions "reasoning" and "format" as separate concerns
   - `compactGuidance_FeaturePlan_ContainsContextPackaging` — plan mentions "context package" or "self-contained"
   - `compactGuidance_FeaturePlan_ContainsThreeStageDecomposition` — plan mentions "logical" and "concrete" and "parallelization"
   - `compactGuidance_FeaturePlanReview_ContainsSelfConsistency` — plan-review mentions "varied framing" or "self-consistency" or "3 framings"
   - `compactGuidance_FeatureDelegate_ContainsEffortClassification` — delegate mentions "classify" or "complexity" or "task-classification"
   - `compactGuidance_FeatureDelegate_ContainsContextScoping` — delegate mentions "context package" (not "full design")
   - `compactGuidance_FeatureReview_ContainsTwoPassEvaluation` — review mentions "two-pass" or "high-recall"
   - `compactGuidance_FeatureReview_ContainsReviewStrategy` — review mentions "review-strategy"

   Expected failures: Current compactGuidance strings don't contain any of these keywords

2. **[GREEN]** Update 5 feature playbook compactGuidance strings in `servers/exarchos-mcp/src/workflow/playbooks.ts`:

   - **ideate** (line ~134): Append compression + two-step design guidance per design §3.2.1
   - **plan** (line ~155): Append three-stage decomposition + context packaging per design §3.2.2
   - **plan-review** (line ~176): Append self-consistency per design §3.2.3
   - **delegate** (line ~234): Append effort classification + context scoping per design §3.2.4
   - **review** (line ~270): Append two-pass evaluation + review-strategy runbook reference per design §3.2.5

3. **[REFACTOR]** Verify compactGuidance lengths stay within reasonable bounds. Existing drift tests (`compactGuidance_MentionsTool_*`) must still pass — enrichment must not remove existing tool mentions.

**Files:**
- `servers/exarchos-mcp/src/workflow/playbooks.ts`
- `servers/exarchos-mcp/src/workflow/playbooks.property.test.ts`

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 5: prepare_delegation Handler — Task Classifications
**Implements:** DR-11, DR-16
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests in `servers/exarchos-mcp/src/orchestrate/prepare-delegation.test.ts`:

   Add a new describe block `'Task classification'`:
   - `PrepareDelegation_WithTasks_ReturnsTaskClassifications` — when `tasks` arg provided and ready, result includes `taskClassifications` array with one entry per task
   - `TaskClassification_ScaffoldingTitle_ReturnsLowScaffolder` — task with title containing "stub" → `{ complexity: 'low', recommendedAgent: 'scaffolder', effort: 'low' }`
   - `TaskClassification_BoilerplateTitle_ReturnsLowScaffolder` — task with title containing "boilerplate" or "type definitions" or "interface" → low/scaffolder
   - `TaskClassification_MultiDependencyTask_ReturnsHighImplementer` — task with `blockedBy` length ≥ 2 → `{ complexity: 'high', recommendedAgent: 'implementer', effort: 'high' }`
   - `TaskClassification_ManyFiles_ReturnsHighImplementer` — task with `files` length ≥ 3 → high/implementer
   - `TaskClassification_StandardTask_ReturnsMediumImplementer` — default → `{ complexity: 'medium', recommendedAgent: 'implementer', effort: 'medium' }`
   - `PrepareDelegation_NoTasks_OmitsClassifications` — when no `tasks` arg, result has no `taskClassifications` field

   Expected failures: `taskClassifications` field doesn't exist in result type or handler output

2. **[GREEN]** Implement in `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`:

   - Add `TaskClassification` interface:
     ```typescript
     interface TaskClassification {
       readonly taskId: string;
       readonly complexity: 'low' | 'medium' | 'high';
       readonly recommendedAgent: 'scaffolder' | 'implementer';
       readonly effort: 'low' | 'medium' | 'high';
       readonly reason: string;
     }
     ```
   - Add `classifyTask()` pure function with heuristic logic:
     - Title contains scaffolding indicators (`stub`, `boilerplate`, `type def`, `interface`, `scaffold`) → low/scaffolder
     - Task has ≥ 2 `blockedBy` entries → high/implementer
     - Task targets ≥ 3 files → high/implementer
     - Otherwise → medium/implementer
   - Extend `args.tasks` type to include optional `blockedBy?: string[]` and `files?: string[]`
   - Add `taskClassifications` to `PrepareDelegationResult` interface
   - In `handlePrepareDelegation`, when ready and `args.tasks` provided, compute classifications and include in result

3. **[REFACTOR]** Verify all existing prepare-delegation tests still pass. Classification is additive (new field on result) so no existing behavior changes.

**Files:**
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.test.ts`

**Dependencies:** Task 1 (scaffolder agent spec should exist for the recommendation to be actionable)
**Parallelizable:** Yes (within Group 2)

---

### Task 6: Skill Thin Updates — Schema Discovery References
**Implements:** DR-9, DR-11
**Phase:** Edit existing skills (markdown only)

1. `skills/delegation/SKILL.md` — Add a "Schema Discovery" section that instructs:
   - "Before dispatching, query `runbook({ id: 'task-classification' })` to get the cognitive complexity classification tree"
   - "Query `runbook({ id: 'dispatch-decision' })` for dispatch strategy (parallel vs sequential)"
   - Brief note: scaffolder agent spec available for low-complexity tasks

2. `skills/spec-review/SKILL.md` — Add a "Schema Discovery" section:
   - "Query `runbook({ id: 'review-strategy' })` to determine single-pass vs two-pass evaluation strategy"

3. `skills/quality-review/SKILL.md` — Add a "Schema Discovery" section:
   - "Query `runbook({ id: 'review-strategy' })` to determine single-pass vs two-pass evaluation strategy"

These are thin wrappers — the actual decision logic lives in the runbooks (Task 3) and playbooks (Task 4).

**Files:**
- `skills/delegation/SKILL.md`
- `skills/spec-review/SKILL.md`
- `skills/quality-review/SKILL.md`

**Verification:** `scripts/validate-all-skills.sh` (frontmatter validity)
**Dependencies:** Task 3 (runbooks must exist for references to be valid)
**Parallelizable:** Yes (within Group 2)

---

## Parallelization Strategy

```
Group 1 (parallel — all independent, no file overlap):
├── Task 1: Agent spec code (agents/types.ts + agents/definitions.ts + agents/agents.test.ts)
├── Task 2: ADR corrections (docs/adrs/transformer-neuroanatomy-applied-agent-tooling.md)
├── Task 3: Decision runbooks (runbooks/definitions.ts + runbooks/*.test.ts)
└── Task 4: Playbook enrichment (workflow/playbooks.ts + workflow/playbooks.property.test.ts)

Group 2 (parallel with each other, depends on Group 1):
├── Task 5: Handler enhancement (orchestrate/prepare-delegation.ts + *.test.ts) — depends on Task 1
└── Task 6: Skill thin updates (skills/*/SKILL.md) — depends on Task 3
```

**Critical path:** Task 1 → Task 5 (agent spec → handler classification)

**Worktree safety:** All Group 1 tasks touch completely different files — zero overlap. Group 2 tasks also touch different files from each other. Task 5 must wait for Task 1 to merge (references scaffolder by name). Task 6 must wait for Task 3 to merge (references runbook IDs).

## Context Packages

### Task 1 Context
> **DR-11** (Task complexity classification): Delegation skill classifies tasks by cognitive complexity and assigns model tier accordingly.
> **DR-12** (AgentSpec effort field): Agent spec type extended with optional `effort` field for platform-agnostic API integrations.
> **DR-16** (Platform abstraction): All changes structured as platform-agnostic patterns with Claude Code-specific implementation notes.
>
> Design §3.4: SCAFFOLDER spec — `id: 'scaffolder'`, `model: 'sonnet'`, `effort: 'low'`, worktree isolation, conciseness-focused prompt with `{{taskDescription}}` and `{{filePaths}}` template vars, `disallowedTools: ['Agent']`, `resumable: false`. Effort field is advisory metadata — maps to `output_config.effort` for API integrations.
>
> Existing patterns: See IMPLEMENTER/FIXER/REVIEWER in `agents/definitions.ts`. AgentSpecId union in `agents/types.ts`. ALL_AGENT_SPECS array.

### Task 2 Context
> **DR-1 through DR-6**: ADR factual corrections. See design §3.1 for the specific corrections to Patterns 4, 6, 7, the three-zone anatomy nuance addition, and the new Pattern 8 (Effort Control Across Platforms) section. All corrections maintain the same practical advice — only the mechanism explanations change.
>
> Key references: Wang et al. 2022 (self-consistency prior art), autoregressive attention mask (prompt order mechanism), Anthropic effort parameter docs (`output_config.effort`, `thinking: {type: "adaptive"}`).

### Task 3 Context
> **DR-9** (Two-pass review): Both review stages use two-pass evaluation — high-recall followed by high-precision filtering.
> **DR-10** (Effort-aware prompts): Agent specs include effort-appropriate system prompt guidance.
> **DR-11** (Task complexity classification): Classify tasks as low/medium/high and select agent spec accordingly.
>
> Design §3.3: Two new runbooks — TASK_CLASSIFICATION (id: `task-classification`, phase: `delegate`, 3 decide steps: scaffolding check → complexity assessment → context size check) and REVIEW_STRATEGY (id: `review-strategy`, phase: `review`, 3 decide steps: change size → prior failures → stage type).
>
> Existing patterns: See TRIAGE_DECISION, DISPATCH_DECISION, REVIEW_ESCALATION in `runbooks/definitions.ts`. DECISION_RUNBOOK_IDS in `decision-runbooks.test.ts`. ALL_RUNBOOKS array (currently 12 items → 14).

### Task 4 Context
> **DR-7** (Two-step design): Separate reasoning from formatting in ideate phase.
> **DR-8** (Three-stage decomposition): Logical units → concrete tasks → parallelization plan in plan phase.
> **DR-9** (Two-pass review): High-recall then high-precision in review phase.
> **DR-13, DR-14** (Compression + carry-forward): Phase transitions include compression — ~300-token summaries, ~500-token context packages.
> **DR-15** (Self-consistency): Plan-review runs coverage analysis with 3 varied framings.
>
> Design §3.2: Enrich compactGuidance for 5 feature phases (ideate, plan, plan-review, delegate, review). Each gets appended guidance about the neuroanatomy pattern it implements. §3.6: Compression budgets embedded in compactGuidance.
>
> Existing format: compactGuidance is a single string with sections: purpose ("You are..."), tool invocations, transition criteria, key decision, anti-pattern, escalation. Enrichment appends new material — must not remove existing content. Current strings are ~300-500 chars.

### Task 5 Context
> **DR-11** (Task complexity classification): Deterministic heuristic classification in handler output.
> **DR-16** (Platform abstraction): Classification available to any MCP client, not just Claude Code skills.
>
> Design §3.5: Extend `PrepareDelegationResult` with `taskClassifications` array. Each entry: `taskId`, `complexity` (low/medium/high), `recommendedAgent` (scaffolder/implementer), `effort` (low/medium/high), `reason`. Classification logic: title keywords → scaffolding, ≥2 blockedBy → high, ≥3 files → high, else medium. Advisory — agents can override.
>
> Existing handler: `handlePrepareDelegation` in `orchestrate/prepare-delegation.ts` (197 lines). Takes `args.tasks?: Array<{id, title}>`. Returns `PrepareDelegationResult` with `ready`, `readiness`, `blockers`, `qualityHints`, `isolation`. See existing test fixtures for mock patterns.

### Task 6 Context
> **DR-9** (Two-pass review): Skills reference review-strategy runbook for evaluation strategy.
> **DR-11** (Task complexity classification): Delegation skill references task-classification runbook.
>
> These are thin content-layer wrappers. Add "Schema Discovery" sections to 3 skills: delegation references `task-classification` + `dispatch-decision` runbooks, spec-review references `review-strategy` runbook, quality-review references `review-strategy` runbook. Format: brief instruction to call `runbook({ id: '...' })` before proceeding.
>
> Existing pattern: Skills already have tool references and workflow guidance from playbooks. Schema Discovery is a new section type that tells the agent which runbooks to query at phase start.

## Deferred Items

Per design §5, the following are explicitly out of scope:
- Dynamic budget estimation (TALE-like classifier) — Deferred until usage data available
- Self-consistency at all gates — Only plan-review for now
- Formal compression contracts — Guided by compactGuidance strings, not schema enforcement
- HSM sub-states — Multi-pass review and three-stage planning encoded as guidance, not HSM states

## Completion Checklist
- [ ] All tests written before implementation (RED phase)
- [ ] All tests pass (`npm run test:run`)
- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] Skill validation scripts pass (`scripts/validate-all-skills.sh`)
- [ ] ADR corrections manually reviewed for factual accuracy
- [ ] Runbook structural invariants pass (decision-runbooks.test.ts)
- [ ] Playbook drift tests pass (playbooks.property.test.ts)
- [ ] Code coverage meets standards
- [ ] Ready for review
