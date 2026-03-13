# Implementation Plan: Pipeline Pruning & Tech Debt Audit

**Design:** `docs/designs/2026-03-11-prune-and-debt-audit.md`
**Issues:** #1010, #1013

## Architecture Principle

Per #1007 and `docs/designs/2026-03-09-platform-agnosticity.md`: optimize the self-service tooling (MCP layer), not the thin content layers specific to Claude Code. The MCP server must be self-sufficient for plugin-free clients. Content layer is augmentative.

- **MCP layer (distributed):** Pipeline view enrichment, prune workflow action, runbook entries, deterministic scripts
- **Content layer (repo-local):** Thin skill at `.claude/skills/tech-debt-audit/` (like feature-audit), prune command

## Task Summary

| Task | Description | Layer | Implements | Dependencies |
|------|-------------|-------|-----------|--------------|
| 001 | Pipeline projection temporal fields | MCP | DR-2 | None |
| 002 | Pipeline view enrichment + nudge | MCP | DR-2, DR-3 | 001 |
| 003 | Pipeline view schema update | MCP | DR-2 | 002 |
| 004 | Prune workflow action | MCP | DR-1 | None |
| 005 | Prune runbook entry | MCP | DR-1 | 004 |
| 006 | Tech debt audit runbook entry | MCP | DR-5, DR-7 | None |
| 007 | check-td1-wiring.sh | MCP | DR-6 | None |
| 008 | check-td3-error-observability.sh | MCP | DR-6 | None |
| 009 | check-td4-schema-drift.sh | MCP | DR-6 | None |
| 010 | check-td6-dead-code.sh | MCP | DR-6 | None |
| 011 | check-td7-complexity.sh | MCP | DR-6 | None |
| 012 | Prune command (thin) | Content | DR-1 | 004 |
| 013 | Tech debt audit skill (repo-local) | Content | DR-4, DR-5, DR-7, DR-8 | 006, 007-011 |

## Parallelization Groups

```
Group A (sequential):  001 → 002 → 003         [Pipeline view — TypeScript TDD]
Group B (sequential):  004 → 005               [Prune action + runbook — TypeScript TDD]
Group C (independent):  006                     [Tech debt audit runbook]
Group D (independent):  007, 008, 009, 010, 011 [Deterministic scripts — Bash TDD]
Group E (after A+B):   012                      [Prune command — thin content]
Group F (after C+D):   013                      [Tech debt audit skill — thin content]
```

Recommended agent assignment:
- **Agent 1:** Tasks 001-003 (Pipeline view chain — TypeScript TDD)
- **Agent 2:** Tasks 004-005, 012 (Prune action + runbook + command)
- **Agent 3:** Tasks 006, 013 (Tech debt audit runbook + skill content)
- **Agent 4:** Tasks 007-009 (TD1 + TD3 + TD4 scripts — Bash TDD)
- **Agent 5:** Tasks 010-011 (TD6 + TD7 scripts — Bash TDD)

---

## Task Details

### Task 001: Pipeline projection temporal fields
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-2

1. **[RED]** Write tests for new temporal fields in the pipeline projection.
   - File: `servers/exarchos-mcp/src/__tests__/views/pipeline-view.test.ts`
   - Tests:
     - `PipelineProjection_WorkflowStarted_CapturesStartedAt` — `startedAt` set from `workflow.started` event timestamp
     - `PipelineProjection_AnyEvent_UpdatesLastEventTimestamp` — `lastEventTimestamp` updates on every event type
     - `PipelineProjection_MultipleEvents_LastEventTimestampIsNewest` — Last event's timestamp wins
     - `PipelineProjection_EmptyStream_DefaultsToEmptyStrings` — Init returns `startedAt: ''` and `lastEventTimestamp: ''`
   - Expected failure: Properties don't exist on `PipelineViewState`

2. **[GREEN]** Add temporal fields to interface and projection.
   - File: `servers/exarchos-mcp/src/views/pipeline-view.ts`
   - Add `startedAt: string` and `lastEventTimestamp: string` to `PipelineViewState`
   - Update `pipelineProjection.init` with empty string defaults
   - Update `pipelineProjection.apply`: track `lastEventTimestamp` on EVERY event, capture `startedAt` from `workflow.started`

3. **[REFACTOR]** Update existing `EmptyPipeline` test to assert new default fields.

**Dependencies:** None

---

### Task 002: Pipeline view enrichment and nudge
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-2, DR-3

1. **[RED]** Write tests for query-time enrichment in `handleViewPipeline`.
   - File: `servers/exarchos-mcp/src/views/tools.test.ts`
   - Tests:
     - `HandleViewPipeline_StaleWorkflow_ReturnsIsStaleTrue` — 10-day-old workflow, default threshold → `isStale: true`
     - `HandleViewPipeline_RecentWorkflow_ReturnsIsStaleFalse` — Recent workflow → `isStale: false`
     - `HandleViewPipeline_CustomThreshold_UsesProvidedValue` — `staleThresholdDays: 1` with 2-day-old → stale
     - `HandleViewPipeline_SynthesizePhaseStale_ReturnsNudge` — Synthesize phase + `daysSinceActivity > 1` → nudge
     - `HandleViewPipeline_NonSynthesizeStale_NoNudge` — Ideate phase stale → no nudge
     - `HandleViewPipeline_SynthesizeRecentActivity_NoNudge` — Synthesize + recent → no nudge

2. **[GREEN]** Implement query-time enrichment after materialization.
   - File: `servers/exarchos-mcp/src/views/tools.ts`
   - Compute `minutesSinceActivity`, `daysSinceActivity`, `isStale`, `nudge` from `lastEventTimestamp`

3. **[REFACTOR]** Extract enrichment into a pure function if handler grows too large.

**Dependencies:** Task 001

---

### Task 003: Pipeline view schema update
**Phase:** RED → GREEN
**Implements:** DR-2

1. **[RED]** Test `staleThresholdDays` parameter accepted by pipeline action schema.
   - File: `servers/exarchos-mcp/src/registry.test.ts`
   - Test: `PipelineAction_Schema_AcceptsStaleThresholdDays`

2. **[GREEN]** Add `staleThresholdDays: coercedPositiveInt().optional()` to pipeline schema in registry.
   - File: `servers/exarchos-mcp/src/registry.ts` (line ~802)
   - Update `handleViewPipeline` args type

**Dependencies:** Task 002

---

### Task 004: Prune workflow action
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-1

Following the cancel/cleanup action pattern (`cancel.ts`, `cleanup.ts`):

1. **[RED]** Write tests for `handlePrune`.
   - File: `servers/exarchos-mcp/src/workflow/prune.test.ts`
   - Tests:
     - `HandlePrune_DryRun_ReturnsCandidatesWithoutMutating` — Lists stale workflows, no state changes
     - `HandlePrune_StaleWorkflows_CancelsAll` — Workflows past threshold are cancelled
     - `HandlePrune_ActiveWorkflows_Skipped` — Recent workflows untouched
     - `HandlePrune_TerminalWorkflows_Skipped` — Completed/cancelled not re-cancelled
     - `HandlePrune_CustomThreshold_UsesProvidedValue` — `staleThresholdDays: 1`
     - `HandlePrune_NoStaleWorkflows_ReturnsEmptyCandidates` — Clean pipeline
     - `HandlePrune_WorkflowWithPrUrl_FlaggedAsSafeguarded` — Workflows with `stackPositions[].prUrl` flagged
     - `HandlePrune_EventFirstEmission_ES2` — Events emitted before state mutation for v2 workflows
   - Expected failure: `handlePrune` doesn't exist

2. **[GREEN]** Implement `handlePrune`.
   - File: `servers/exarchos-mcp/src/workflow/prune.ts`
   - Input schema: `{ staleThresholdDays?: number, dryRun?: boolean }`
   - Implementation:
     1. Glob `stateDir/*.state.json` to discover all workflows
     2. Read each state file, extract `_checkpoint.lastActivityTimestamp` and `phase`
     3. Compute staleness from checkpoint timestamp (existing `getMinutesSinceActivity`)
     4. Filter: exclude terminal phases, flag workflows with `prUrl` in stack as `safeguarded`
     5. If `dryRun`: return `{ candidates: [...], safeguarded: [...] }` without mutation
     6. For non-safeguarded candidates: reuse `handleCancel` logic (saga compensation)
     7. Emit `workflow.prune` event with summary (featureIds pruned, threshold used)
     8. Return `{ pruned: [...], skipped: [...], safeguarded: [...] }`
   - Follow cancel.ts patterns: ES v2 event-first, idempotency keys, checkpoint reset

3. **[REFACTOR]** Extract shared staleness computation if duplicated with pipeline view enrichment.

4. **[GREEN]** Register action in composite handler and registry.
   - File: `servers/exarchos-mcp/src/workflow/composite.ts` — Add `case 'prune'`
   - File: `servers/exarchos-mcp/src/registry.ts` — Add prune action to `workflowActions`:
     ```typescript
     {
       name: 'prune',
       description: 'Bulk-cancel stale workflows. Scans all workflows, filters by inactivity threshold, cancels non-safeguarded candidates. Supports dryRun for preview.',
       schema: z.object({
         staleThresholdDays: coercedPositiveInt().optional().describe('Days of inactivity before a workflow is considered stale (default: 7)'),
         dryRun: z.boolean().optional().describe('Preview candidates without cancelling'),
       }),
       phases: ALL_PHASES,
       roles: ROLE_LEAD,
       autoEmits: [
         { event: 'workflow.prune', condition: 'always' },
         { event: 'workflow.cancel', condition: 'conditional', description: 'Per pruned workflow' },
       ],
     }
     ```
   - File: `servers/exarchos-mcp/src/workflow/composite.test.ts` — Add routing test

**Dependencies:** None (uses checkpoint staleness, not pipeline view)

---

### Task 005: Prune runbook entry
**Phase:** RED → GREEN
**Implements:** DR-1

1. **[RED]** Write test verifying prune runbook is registered and resolves.
   - File: `servers/exarchos-mcp/src/runbooks/definitions.test.ts` (or existing runbook test file)
   - Test: `RunbookRegistry_Prune_ExistsAndResolves` — `exarchos_orchestrate({ action: 'runbook', id: 'prune' })` returns valid runbook

2. **[GREEN]** Add prune runbook to definitions.
   - File: `servers/exarchos-mcp/src/runbooks/definitions.ts`
   - Runbook steps:
     1. `exarchos_workflow prune --dryRun` → preview candidates
     2. Decision: confirm candidates to prune (agent or user decides)
     3. `exarchos_workflow prune` → execute
   - Add to `ALL_RUNBOOKS` array

**Dependencies:** Task 004

---

### Task 006: Tech debt audit runbook entry
**Phase:** RED → GREEN
**Implements:** DR-5, DR-7

1. **[RED]** Write test verifying tech-debt-audit runbook is registered.
   - Test: `RunbookRegistry_TechDebtAudit_ExistsAndResolves`

2. **[GREEN]** Add tech-debt-audit runbook to definitions.
   - File: `servers/exarchos-mcp/src/runbooks/definitions.ts`
   - Runbook content encodes the dimension taxonomy and execution model:
     - Audit order (SQALE hierarchy): TD5 → TD3 → TD1/TD2 → TD4 → TD6/TD7
     - Steps:
       1. `exarchos_orchestrate run_script check-td1-wiring.sh --format json` (and TD3, TD4, TD6, TD7)
       2. Decision: review automated findings, add qualitative analysis for TD2 and TD5
       3. Decision: synthesize report with findings grouped by dimension
       4. `exarchos_event append tech-debt.audit-completed` with summary
     - Template vars: `targetPath` (default: `servers/exarchos-mcp/src/`)
   - Severity model (CRITICAL/HIGH/MEDIUM/LOW) documented in runbook description
   - Finding schema documented so non-Claude-Code clients can produce conforming output
   - Add to `ALL_RUNBOOKS` array

**Dependencies:** None

---

### Task 007: check-td1-wiring.sh
**Phase:** RED → GREEN
**Implements:** DR-6

1. **[RED]** Write `scripts/check-td1-wiring.test.sh` with fixtures:
   - `good/clean-module.ts` — No module-global state
   - `bad/global-store.ts` — `let moduleStore: Store | null = null`
   - `bad/fallback-init.ts` — `?? new Store()` fallback
   - Tests: `TD1_CleanModule_NoFindings`, `TD1_GlobalStore_DetectsPattern`, `TD1_FallbackInit_DetectsPattern`, `TD1_JsonFormat_ParseableByJq`, `TD1_MissingPath_ExitsTwo`

2. **[GREEN]** Create `scripts/check-td1-wiring.sh`:
   - Checks: module-global `let` + nullable, `configure*()` exports, fallback instantiation
   - Args: `--path <dir>`, `--format json|markdown`, `--help`
   - Exit codes: 0 (clean), 1 (findings), 2 (usage error)

**Dependencies:** None

---

### Task 008: check-td3-error-observability.sh
**Phase:** RED → GREEN
**Implements:** DR-6

1. **[RED]** Write `scripts/check-td3-error-observability.test.sh` with fixtures:
   - `good/proper-error-handling.ts`, `bad/empty-catch.ts`, `bad/promise-swallow.ts`
   - Tests: `TD3_ProperErrorHandling_NoFindings`, `TD3_EmptyCatch_DetectsPattern`, `TD3_PromiseSwallow_DetectsPattern`, `TD3_JsonFormat_ParseableByJq`

2. **[GREEN]** Create `scripts/check-td3-error-observability.sh`:
   - Checks: empty catch blocks, `.catch(() => {})`, fire-and-forget annotations
   - Same args/exit code conventions as Task 007

**Dependencies:** None

---

### Task 009: check-td4-schema-drift.sh
**Phase:** RED → GREEN
**Implements:** DR-6

1. **[RED]** Write `scripts/check-td4-schema-drift.test.sh` with fixtures:
   - `good/proper-validation.ts`, `bad/type-assertion.ts`, `bad/any-schema.ts`, `bad/passthrough.ts`
   - Tests: `TD4_ProperValidation_NoFindings`, `TD4_TypeAssertion_DetectsPattern`, `TD4_ZodAny_DetectsPattern`, `TD4_AsConst_NotFlagged`

2. **[GREEN]** Create `scripts/check-td4-schema-drift.sh`:
   - Checks: `as <Type>` assertions (excluding `as const`/`as unknown`/test files), `z.any()`, `.passthrough()`
   - Same args/exit code conventions

**Dependencies:** None

---

### Task 010: check-td6-dead-code.sh
**Phase:** RED → GREEN
**Implements:** DR-6

1. **[RED]** Write `scripts/check-td6-dead-code.test.sh` with fixtures:
   - `good/clean-module.ts`, `bad/todo-ancient.ts`, `bad/fixme.ts`
   - Tests: `TD6_CleanModule_NoFindings`, `TD6_TodoFixmeHack_DetectsPatterns`, `TD6_JsonFormat_ParseableByJq`

2. **[GREEN]** Create `scripts/check-td6-dead-code.sh`:
   - Checks: `TODO`/`FIXME`/`HACK`/`XXX` archaeology, basic orphan export detection
   - Same args/exit code conventions

**Dependencies:** None

---

### Task 011: check-td7-complexity.sh
**Phase:** RED → GREEN
**Implements:** DR-6

1. **[RED]** Write `scripts/check-td7-complexity.test.sh` with fixtures:
   - `good/small-module.ts`, `bad/god-module.ts`, `bad/many-params.ts`, `bad/deep-nesting.ts`
   - Tests: `TD7_SmallModule_NoFindings`, `TD7_GodModule_DetectsLargeFile`, `TD7_ManyParams_DetectsPattern`, `TD7_DeepNesting_DetectsPattern`

2. **[GREEN]** Create `scripts/check-td7-complexity.sh`:
   - Checks: files >500 lines, functions with >5 params, >4 indentation levels, re-export-only files
   - Same args/exit code conventions

**Dependencies:** None

---

### Task 012: Prune command (thin content wrapper)
**Phase:** Content creation
**Implements:** DR-1

Create `commands/prune.md` — thin wrapper following `commands/cleanup.md` pattern:
- Frontmatter: `description: "Bulk-cancel stale workflows from the pipeline"`
- References `exarchos_workflow prune` MCP action (self-service layer does the work)
- Adds Claude Code-specific UX: formatted dry-run table, interactive confirmation prompt, PR safeguard checks via `gh pr list`, summary report
- Error handling section

**Dependencies:** Task 004

---

### Task 013: Tech debt audit skill (repo-local, thin)
**Phase:** Content creation
**Implements:** DR-4, DR-5, DR-7, DR-8

Create `.claude/skills/tech-debt-audit/` following `.claude/skills/feature-audit/` pattern:

1. **SKILL.md** — thin orchestrator referencing MCP self-service:
   - Frontmatter with `mcp-server: exarchos`
   - Triggers: "tech debt audit", "architecture review", "debt scan"
   - Negative triggers: "review this PR" (use quality-review), "fix bug" (use /debug)
   - Execution: invoke runbook (`exarchos_orchestrate runbook id:tech-debt-audit`), then augment with qualitative analysis for TD2/TD5
   - Keep under 5,000 words

2. **references/dimensions.md** — Full TD1-TD7 taxonomy (definitions, signals, severity, examples)

3. **references/report-template.md** — Finding schema + report structure

4. **references/feature-audit-distinction.md** — Boundary with quality-review/convergence

**Dependencies:** Tasks 006, 007-011 (runbook and scripts must exist for skill to reference)
