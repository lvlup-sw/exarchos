# Consolidated Post-Merge Fixes

**Date:** 2026-03-09
**Status:** Draft
**Feature ID:** `consolidated-post-merge-fixes`
**Workflow Type:** feature

## Problem Statement

After merging PRs #982 (HSM topology), #986 (introspection phases 2-4), and #993 (decision runbooks), seven open issues remain — spanning critical workflow bugs, documentation gaps, schema omissions, and test debt. One additional issue (#997) was filed during triage. These issues erode trust in the workflow engine and gate system.

The most critical cluster (#990 + #997) reveals a fundamental flaw: the `_events` materialized view is populated inconsistently across code paths, causing HSM guard failures that permanently block workflow phase transitions.

### Issues In Scope

| # | Title | Category |
|---|-------|----------|
| 990 | delegate→review guard fails — `_events` hydration overwrite | Code bug (critical) |
| 997 | Model-emitted events not projected into `_events` during reconciliation | Code bug (critical) |
| 989 | Validation scripts use brittle header matching | Code bug (medium) |
| 991 | prepare_delegation blocker message misleading | Messaging gap |
| 992 | shepherd-escalation runbook not referenced from any skill | Docs gap |
| 994 | Playbook event listings lack required field schemas | DX gap |
| 995 | Review phase has no post-review completion event type | Schema gap |
| 996 | Test coverage gaps in workflow state machine edge cases | Test debt |

## Requirements

### DR-1: Unified `_events` Hydration (fixes #990, #997)

The `_events` array must be populated through a single, consistent code path used by both `handleSet` phase transitions and `reconcileFromEvents`.

**Current state (broken):**
- `handleSet` has two hydration blocks (tools.ts:471-484 and tools.ts:495-520) — Block 2 overwrites Block 1 with selective field extraction that strips non-transition event data
- `reconcileFromEvents` (state-store.ts:700-741) only processes `workflow.started`, `workflow.transition`, `workflow.checkpoint` — silently skips `team.spawned`, `team.disbanded`, `task.completed`, etc.
- Guards (guards.ts:558-595) read exclusively from `state._events` — they never query the event store

**Required behavior:**
1. Extract a single `hydrateEventsFromStore(featureId, eventStore)` function that maps ALL event types with full data spread
2. Remove both existing hydration blocks from `handleSet` and replace with a single call to the new function
3. Call the same function at the end of `reconcileFromEvents` after event application
4. Event mapping must preserve: `type` (via `mapExternalToInternalType`), `timestamp`, all `e.data` fields spread at top level, and `metadata: e.data` for backward compatibility
5. Catch blocks must preserve existing error semantics: best-effort empty array in `handleSet`, hard error in `reconcileFromEvents`

### DR-2: Port All 12 MCP-Hardcoded Bash Scripts to TypeScript (fixes #989)

All 12 MCP gate handlers use `execFileSync` to invoke bash scripts with hardcoded relative paths. This creates:
- **Portability failure:** Bash-only — no Windows support, no Cursor/Windsurf compatibility
- **Distribution gap:** Scripts are not embedded in the MCP server bundle (`dist/exarchos.js`); they resolve from CWD-relative `scripts/` paths that break outside the repo checkout
- **Two-layer brittleness:** Bash stdout format changes silently break TypeScript output parsers
- **Platform lock-in:** `resolveScript()` exists but 12 of 12 gate handlers bypass it, using hardcoded relative paths

**Current architecture (broken):**
```
MCP tool call → TypeScript handler → execFileSync(bash script) → parse stdout → return result
CLI command   → same TypeScript handler → same bash call → same parse
```

**Required architecture (clean refactor):**
```
MCP tool call → TypeScript handler → pure TS validation logic → return result
CLI command   → same TypeScript handler → same TS logic → same result
```

**All 12 scripts to port:**

| # | Script | Handler | Logic Summary |
|---|--------|---------|---------------|
| 1 | `verify-plan-coverage.sh` | `plan-coverage.ts` | Design→plan section cross-reference with keyword matching |
| 2 | `verify-ideate-artifacts.sh` | `design-completeness.ts` | Design doc section validation, state file checks |
| 3 | `check-task-decomposition.sh` | `task-decomposition.ts` | Task structure validation, DAG cycle detection, parallel safety |
| 4 | `security-scan.sh` | `security-scan.ts` | Grep for secrets/credentials patterns in changed files |
| 5 | `review-verdict.sh` | `review-verdict.ts` | Parse CodeRabbit/review approval status from PR |
| 6 | `static-analysis-gate.sh` | `static-analysis.ts` | Run typecheck + lint + test status checks |
| 7 | `verify-provenance-chain.sh` | `provenance-chain.ts` | Validate design→plan→task traceability chain |
| 8 | `check-context-economy.sh` | `context-economy.ts` | Check token budget / context window usage metrics |
| 9 | `check-operational-resilience.sh` | `operational-resilience.ts` | Validate error handling patterns in code |
| 10 | `check-tdd-compliance.sh` | `tdd-compliance.ts` | Verify test-first discipline (test commits before impl) |
| 11 | `check-post-merge.sh` | `post-merge.ts` | Post-merge validation checks |
| 12 | `check-workflow-determinism.sh` | `workflow-determinism.ts` | Validate state machine transition determinism |

**Migration strategy — behavioral snapshots first:**
1. For each script, run the existing bash against known inputs and capture structured output as vitest snapshot fixtures
2. Port logic to TypeScript in the existing handler file
3. Assert TypeScript produces equivalent structured results
4. Delete the bash script and its `.test.sh` file

**Required behavior:**
1. All validation logic lives in TypeScript, testable with vitest, no `execFileSync` or bash dependency
2. Header matching uses case-insensitive regex, accepts `## Requirements` and `## Design Requirements`
3. Description parsing handles blank lines, missing `**Description:**` fields gracefully
4. Return structured result objects (not stdout strings parsed by regex)
5. Both MCP and CLI entry points call the same TypeScript functions
6. Bash scripts are deleted (no backward compatibility needed)
7. `.test.sh` files are replaced with vitest `.test.ts` files

**Follow-up:** The remaining 21 `run_script`-only bash scripts have the same bash dependency but use `resolveScript()` for correct path resolution. Filed as #998 for a separate effort.

### DR-3: Delegation Readiness Blocker Message (fixes #991)

The `prepare_delegation` handler is correct — it requires `task.assigned` events because that's the only mechanism tracked by `DELEGATION_READINESS_VIEW`. But the blocker message is misleading.

**Current message** (delegation-readiness-view.ts:39):
```
no tasks found in workflow state — emit task.assigned events via exarchos_event before calling prepare_delegation
```

**Required change:**
```
no task.assigned events found — emit task.assigned events for each task via exarchos_event before calling prepare_delegation
```

The message must not reference "workflow state" since the check reads from event projections, not `state.tasks[]`.

### DR-4: Shepherd-Escalation Runbook Coverage (fixes #992)

**Required changes:**
1. Add a "Decision Runbooks" reference to `skills/shepherd/SKILL.md` following the existing pattern at line 39-41: `exarchos_orchestrate({ action: "runbook", id: "shepherd-escalation" })`
2. Add a `SkillCoverage_ShepherdSkill_ReferencesShepherdEscalationRunbook` test to `src/runbooks/skill-coverage.test.ts` following the existing assertion pattern

### DR-5: Playbook Event Field Schemas (fixes #994)

Playbook event listings tell agents WHAT event to emit and WHEN, but not WHAT FIELDS the event data requires. This causes avoidable validation failures.

**Current `EventInstruction` interface** (playbooks.ts:9-12):
```typescript
interface EventInstruction {
  readonly type: string;
  readonly when: string;
}
```

**Required change — add optional `fields` property:**
```typescript
interface EventInstruction {
  readonly type: string;
  readonly when: string;
  readonly fields?: readonly string[];
}
```

Populate `fields` for events with non-obvious required fields (e.g., `gate.executed` → `['gateName', 'layer', 'passed']`). Events with self-evident schemas (e.g., `shepherd.started`) may omit `fields`.

Also add a `compactGuidance` instruction to playbooks advising: "Call `exarchos_event describe(eventTypes: [...])` before first-time emission of any event type."

### DR-6: Register `review.completed` Event Type (fixes #995)

No event type exists for recording review verdicts. Review outcomes are stored only in mutable workflow state, leaving no event-sourced audit trail.

**Required changes:**
1. Add `'review.completed'` to `EventTypes` array in schemas.ts
2. Register in `EVENT_EMISSION_REGISTRY` as `'model'` source
3. Create Zod schema:
   ```typescript
   export const ReviewCompletedData = z.object({
     stage: z.string().describe('Review stage (spec-review, quality-review)'),
     verdict: z.enum(['pass', 'fail', 'blocked']).describe('Review verdict'),
     findingsCount: z.number().int().nonnegative().describe('Number of findings'),
     summary: z.string().describe('Brief review summary'),
   });
   ```
4. Register in `EVENT_DATA_SCHEMAS` map and `EventDataMap` type
5. Update review phase playbook events to include `review.completed`

### DR-7: Test Coverage Hardening (fixes #996)

Current coverage: 91% statements / 85.5% branches / 95.8% functions
Target: >=95% statements / >=90% branches

**Priority test areas (ordered by impact):**

1. **`src/workflow/tools.ts` (82.8%)** — Composite tool routing error paths, the `_events` hydration path (covered by DR-1 tests)
2. **`src/workflow/cancel.ts` (67.8%)** — Saga compensation paths: partial cancellation, compensation failure recovery, concurrent cancel
3. **`src/views/tools.ts` (59.3%)** — View composite routing, unknown action handling, malformed input
4. **`src/workflow/next-action.ts` (84.7%)** — Edge cases: empty state, unknown phase, conflicting recommendations
5. **`src/workflow/query.ts` (88.3%)** — Query filter combinations, projection edge cases, nested dot-path queries
6. **`src/storage/migration.ts` (78.6%)** — Migration failure recovery, corrupt state handling, version skip
7. **`src/storage/lifecycle.ts` (84.7%)** — Storage lifecycle edge cases
8. **`src/views/synthesis-readiness-view.ts` (82.4%)** — Readiness check edge cases
9. **`src/workflow/guards.ts` (93.75% branches)** — Guard prerequisite combinations, transition rejection scenarios
10. **`src/workflow/compensation.ts` (97.4%)** — Lines 143-149: compensation failure recovery path
11. **`src/workflow/reconcile` tests** — Post-reconcile guard evaluation, model-emitted event projection (covered by DR-1)

**Test principles:**
- Every edge case test must be a failing test first (TDD red phase), then implementation, then green
- Tests define behavior — if a test doesn't exist for a scenario, that scenario's behavior is undefined
- Guard tests must cover the full hydration→evaluation→transition pipeline, not just synthetic `_events` arrays

## Chosen Approach

**Surgical fix-per-issue** with shared `hydrateEventsFromStore` extraction as the only cross-cutting change. Each fix is independently testable and reviewable.

### Key Design Decision: Keep `_events` as Materialized View

We evaluated two approaches for #990/#997:
- **Option A (chosen):** Unify hydration into single `hydrateEventsFromStore()`, extend reconcile to call it
- **Option B (rejected):** Make guards query event store directly

Option B was rejected because:
- Breaks CQRS pattern (guards become event-store-aware, bypassing materialized views)
- Requires guards to become async (ripples through entire guard evaluation chain)
- Removes degraded-mode capability (guards can't evaluate from disk state if event store unavailable)
- Adds runtime I/O dependency to deterministic guard evaluation

The architecture is correct; the implementation has a gap. Fix the projection, don't change the architecture.

## Technical Design

### Component 1: `hydrateEventsFromStore()` Function

**Location:** New export in `src/workflow/state-store.ts` (co-located with reconcile)

```typescript
export async function hydrateEventsFromStore(
  featureId: string,
  eventStore: EventStore,
): Promise<readonly Record<string, unknown>[]> {
  const storeEvents = await eventStore.query(featureId);
  return storeEvents.map((e) => ({
    type: mapExternalToInternalType(e.type),
    timestamp: e.timestamp,
    ...(e.data as Record<string, unknown> ?? {}),
    metadata: e.data as Record<string, unknown> ?? {},
  }));
}
```

This uses Block 1's full-spread mapping, which preserves all event data fields. Block 2's selective spread (`from`, `to`, `trigger` only) is removed — it was a premature optimization that broke non-transition events.

**Integration points:**
- `handleSet` (tools.ts): Replace both blocks with single call, wrapped in try/catch with best-effort fallback
- `reconcileFromEvents` (state-store.ts): Call after event application loop, before state file write

### Component 2: handleSet Refactoring

**Before** (two blocks, lines 464-520):
```
Block 1 (lines 471-484): Full spread → _events
Block 2 (lines 495-520): Selective spread → OVERWRITES _events
```

**After** (single block):
```typescript
// ─── Hydrate _events from event store for guard evaluation ──────────
if (input.phase && moduleEventStore) {
  try {
    mutableState._events = await hydrateEventsFromStore(
      input.featureId, moduleEventStore,
    );
  } catch {
    mutableState._events = mutableState._events ?? [];
  }
}
```

Remove Block 2 entirely (lines 493-520).

### Component 3: reconcileFromEvents Extension

**Insert after the event application loop** (after line 853, before the state file write):

```typescript
// Hydrate _events from full event stream for guard evaluation
try {
  stateRecord._events = await hydrateEventsFromStore(featureId, eventStore);
} catch (err) {
  logger.warn(
    { err: err instanceof Error ? err.message : String(err) },
    'Failed to hydrate _events during reconcile — guards may fail',
  );
}
```

### Component 4: Validation Logic — Bash → TypeScript Port

Port all validation logic into the existing TypeScript handler files. Each handler already exists — remove the `execFileSync` call and replace with inline TypeScript logic that returns structured results directly.

**`src/orchestrate/plan-coverage.ts` — port `verify-plan-coverage.sh` logic:**

Pure TypeScript implementation of:
- `parseDesignSections(content: string)`: Extract `###`/`####` headers under `## Technical Design`, `## Design Requirements`, or `## Requirements` (case-insensitive). Hierarchical: prefer `####` subsections when they exist under a `###`.
- `parsePlanTasks(content: string)`: Extract `### Task` headers and titles.
- `extractKeywords(text: string)`: Tokenize, lowercase, filter stop words and short words.
- `keywordMatch(sectionKeywords: string[], targetText: string)`: At least 2 keyword matches (or all if only 1 keyword).
- `parseDeferredSections(content: string)`: Parse deferred rows from traceability table.
- `computeCoverage(designSections, planTasks, deferredSections, planContent)`: Cross-reference matrix.

Return `PlanCoverageResult` directly — no stdout parsing.

**`src/orchestrate/design-completeness.ts` — port `verify-ideate-artifacts.sh` logic:**

Pure TypeScript implementation of:
- `resolveDesignFile(stateFile, docsDir?, designFile?)`: Resolve from args, state JSON, or docs directory.
- `checkRequiredSections(content: string)`: Case-insensitive match for 7 sections (adding `Requirements`).
- `checkMultipleOptions(content: string)`: Count `Option N` headings.
- `checkStateDesignPath(stateFile: string)`: Validate `artifacts.design` in JSON.

No `jq` dependency — use `JSON.parse` + `fs.readFile`.

**`src/orchestrate/task-decomposition.ts` — port `check-task-decomposition.sh` logic:**

Pure TypeScript implementation of:
- `parseTaskBlocks(content: string)`: Extract task ID + content blocks.
- `validateTaskStructure(block: string)`: Check description (>10 words), file targets (backtick paths), test expectations (`[RED]`, `Method_Scenario_Outcome`). Handle missing `**Description:**` gracefully.
- `validateDependencyDAG(tasks)`: Iterative DFS cycle detection.
- `checkParallelSafety(tasks)`: File overlap detection between parallelizable tasks.

**Additional 9 scripts to port (same pattern — remove `execFileSync`, implement in TypeScript):**

- `src/orchestrate/security-scan.ts` ← `scripts/security-scan.sh`: Regex-based credential/secret pattern scanning. Port grep patterns to TypeScript regex.
- `src/orchestrate/review-verdict.ts` ← `scripts/review-verdict.sh`: Parse PR review status. Port `gh` CLI output parsing to TypeScript (or use GitHub API directly).
- `src/orchestrate/static-analysis.ts` ← `scripts/static-analysis-gate.sh`: Invoke `tsc --noEmit`, lint, test status. Note: this script legitimately shells out to external tools — port the orchestration logic but keep `execFileSync` for external tool invocation (tsc, eslint) with proper error handling.
- `src/orchestrate/provenance-chain.ts` ← `scripts/verify-provenance-chain.sh`: File existence + content cross-reference. Pure string analysis, straightforward port.
- `src/orchestrate/context-economy.ts` ← `scripts/check-context-economy.sh`: Token/context metrics. Port metric extraction to TypeScript.
- `src/orchestrate/operational-resilience.ts` ← `scripts/check-operational-resilience.sh`: Error handling pattern validation. Port grep patterns to TypeScript regex.
- `src/orchestrate/tdd-compliance.ts` ← `scripts/check-tdd-compliance.sh`: Git log analysis for test-first ordering. Port git log parsing to TypeScript.
- `src/orchestrate/post-merge.ts` ← `scripts/check-post-merge.sh`: Post-merge validation. Port checks to TypeScript.
- `src/orchestrate/workflow-determinism.ts` ← `scripts/check-workflow-determinism.sh`: State machine validation. Port to TypeScript.

**Files to delete (12 scripts + 12 test files = 24 files):**
- `scripts/verify-plan-coverage.sh` + `.test.sh`
- `scripts/verify-ideate-artifacts.sh` + `.test.sh`
- `scripts/check-task-decomposition.sh` + `.test.sh`
- `scripts/security-scan.sh` + `.test.sh`
- `scripts/review-verdict.sh` + `.test.sh`
- `scripts/static-analysis-gate.sh` + `.test.sh`
- `scripts/verify-provenance-chain.sh` + `.test.sh`
- `scripts/check-context-economy.sh` + `.test.sh`
- `scripts/check-operational-resilience.sh` + `.test.sh`
- `scripts/check-tdd-compliance.sh` + `.test.sh`
- `scripts/check-post-merge.sh` + `.test.sh`
- `scripts/check-workflow-determinism.sh` + `.test.sh`

**Follow-up:** 21 `run_script`-only scripts filed as #998 for separate effort.

### Component 5: Event Schema & Playbook Updates

**schemas.ts additions:**
- `'review.completed'` in `EventTypes`, `EVENT_EMISSION_REGISTRY`, `EVENT_DATA_SCHEMAS`, `EventDataMap`

**playbooks.ts changes:**
- Add `fields` property to `EventInstruction` interface
- Populate for events with non-obvious schemas (at minimum: `gate.executed`, `review.completed`, `task.assigned`)
- Add describe instruction to `compactGuidance` for phases that emit events

## Integration Points

- **Guards** — No changes. Guards continue reading `state._events` which is now correctly populated.
- **Event store** — No schema changes except adding `review.completed`.
- **Views** — No changes. `DELEGATION_READINESS_VIEW` and `WORKFLOW_STATE_VIEW` continue working from event projections.
- **Skills** — Shepherd SKILL.md gets runbook reference. No other skill changes.

## Testing Strategy

### TDD Sequence

Each fix follows red-green-refactor:

1. **DR-1 tests (critical path first):**
   - `hydrateEventsFromStore` unit tests: maps all event types, preserves data fields, handles empty store
   - `handleSet` integration: phase transition with team events in store → guard passes
   - `reconcileFromEvents` integration: reconcile with team.disbanded in stream → `_events` contains it → guard passes
   - End-to-end: init → delegate → emit team events → reconcile → transition to review succeeds

2. **DR-2 tests (behavioral snapshot migration for each of 12 scripts):**
   - **Phase 1 — Behavioral snapshots:** Run existing bash script against known inputs, capture structured output as vitest fixtures. This locks in current behavior before porting.
   - **Phase 2 — TypeScript implementation:** Write vitest tests asserting equivalent structured results from new TypeScript logic.
   - **Phase 3 — Deletion verification:** After port, delete bash + `.test.sh`, run full suite to verify no remaining references.

3. **DR-3 test:** Snapshot test for blocker message text

4. **DR-4 test:** `SkillCoverage_ShepherdSkill_ReferencesShepherdEscalationRunbook`

5. **DR-5 tests:** Playbook snapshot tests verify `fields` property exists for key events

6. **DR-6 tests:** Schema validation tests for `review.completed`, event append + query round-trip

7. **DR-7 tests:** Edge-case tests per the priority list — each targeting specific uncovered lines/branches

### Coverage Targets

| File | Current | Target |
|------|---------|--------|
| `workflow/tools.ts` | 82.8% | >=92% |
| `workflow/cancel.ts` | 67.8% | >=85% |
| `views/tools.ts` | 59.3% | >=80% |
| `workflow/next-action.ts` | 84.7% | >=92% |
| `workflow/query.ts` | 88.3% | >=92% |
| `storage/migration.ts` | 78.6% | >=88% |
| Overall statements | 91% | >=95% |
| Overall branches | 85.5% | >=90% |

## Open Questions

None — all approaches are settled. Implementation can proceed immediately.
