# Implementation Plan: MCP Instruction-Implementation Consistency

## Source
Brief: `~/.claude/workflow-state/refactor-mcp-consistency.state.json`
Bug report: `docs/bugs/ex.md`

## Scope
**Target:** Fix 2 server code bugs + 8 documentation mismatches between Exarchos MCP tool behavior and instruction files
**Base branch:** `fix/arch-rigor-remaining` (PR #76) — edits `next-action.ts` (decomposed from `tools.ts`)
**Excluded:** New server functionality, HSM transition/guard changes, review status casing

## Summary
- Total tasks: 3
- Parallel groups: 1 server task + 1 doc task in parallel, then 1 verification task
- Estimated test count: ~8 new tests (refactor next_action coverage)
- All 10 discrepancies (D1–D10) covered

## Spec Traceability

| Discrepancy | Type | Task ID |
|-------------|------|---------|
| D1: Worktree status enum incomplete | Doc | 2 |
| D2: Feature next_action phantom path suffixes | Doc | 2 |
| D3: AUTO:plan:--revise phantom value | Doc | 2 |
| D4: Refactor action map off-by-one naming | Server | 1 |
| D5: Phantom refactor action values | Doc | 2 |
| D6: Human checkpoint suffix mismatch | Doc | 2 |
| D7: Debug phase names missing prefixes | Doc | 2 |
| D8: State version outdated (1.0 → 1.1) | Doc | 2 |
| D9: workflowType documented as optional | Doc | 2 |
| D10: BLOCKED:circuit-open undocumented | Doc | 2 |

## Task Breakdown

---

### Task 1: Fix refactor PHASE_ACTION_MAP and add tests

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write tests for refactor next_action behavior
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/tools.test.ts`
   - Add `describe('ToolNextAction_Refactor_ReturnsCorrectActions')` block with tests:
     - `explore_GuardPasses_ReturnsAutoRefactorBrief` — init refactor, set `explore.scopeAssessment` + `explore.completedAt`, expect `AUTO:refactor-brief`
     - `brief_PolishGuardPasses_ReturnsAutoPolishImplement` — set `track: 'polish'`, `brief.problem` populated, expect `AUTO:polish-implement`
     - `brief_OverhaulGuardPasses_ReturnsAutoOverhaulPlan` — set `track: 'overhaul'`, `brief.problem` populated, expect `AUTO:overhaul-plan`
     - `polishImplement_GuardPasses_ReturnsAutoRefactorValidate` — expect `AUTO:refactor-validate`
     - `polishValidate_GuardPasses_ReturnsAutoRefactorUpdateDocs` — expect `AUTO:refactor-update-docs`
     - `polishUpdateDocs_HumanCheckpoint_ReturnsWait` — expect `WAIT:human-checkpoint:polish-update-docs`
     - `overhaulDelegate_GuardPasses_ReturnsAutoRefactorReview` — expect `AUTO:refactor-review`
     - `synthesize_HumanCheckpoint_ReturnsWait` — expect `WAIT:human-checkpoint:synthesize`
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npm run test:run` — tests for `explore` and `brief` MUST FAIL (wrong action values)

2. [GREEN] Fix `PHASE_ACTION_MAP` in `src/workflow/next-action.ts`
   - Change `explore: 'AUTO:refactor-explore'` → `explore: 'AUTO:refactor-brief'`
   - Remove `brief: 'AUTO:refactor-brief'` entry entirely (let fallback `AUTO:${transition.to}` produce track-aware values)
   - Run: `npm run test:run` — ALL tests MUST PASS

3. [REFACTOR] Verify no regressions
   - Run full test suite: `npm run test:run`
   - Run typecheck: `npm run typecheck`

**Verification:**
- [ ] `explore` returns `AUTO:refactor-brief` (not `AUTO:refactor-explore`)
- [ ] `brief` (polish) returns `AUTO:polish-implement` (not `AUTO:refactor-brief`)
- [ ] `brief` (overhaul) returns `AUTO:overhaul-plan` (not `AUTO:refactor-brief`)
- [ ] All existing tests still pass
- [ ] Human checkpoints return correct phase-name suffixes

**Dependencies:** None
**Parallelizable:** Yes (with Task 2)

---

### Task 2: Update all documentation to match server behavior

**Phase:** Documentation (no TDD)

**Changes by file:**

#### 2a. `rules/workflow-auto-resume.md`
- **D2:** Remove path suffixes from feature actions:
  - `AUTO:plan:<design-path>` → `AUTO:plan`
  - `AUTO:plan:--revise <design-path>` → remove entirely (D3)
  - `AUTO:plan-review:<plan-path>` → `AUTO:plan-review`
  - `AUTO:delegate:<path>` → `AUTO:delegate`
  - `AUTO:review:<path>` → `AUTO:review`
  - `AUTO:synthesize:<feature>` → `AUTO:synthesize`
  - `AUTO:delegate:--fixes <path>` → `AUTO:delegate:--fixes`
- **D5:** Update refactor action table:
  - `AUTO:refactor-explore` → `AUTO:refactor-brief` (after explore, transition to brief)
  - `AUTO:refactor-brief` → remove (brief no longer has a map entry)
  - `AUTO:refactor-implement` → `AUTO:polish-implement` (fallback-generated for polish track)
  - `AUTO:refactor-plan` → `AUTO:overhaul-plan` (fallback-generated for overhaul track)
  - Add: `AUTO:polish-implement` — Polish track: continue to implementation
  - Add: `AUTO:overhaul-plan` — Overhaul track: invoke /plan
- **D10:** Add `BLOCKED:circuit-open:<compoundId>` to Wait/Done States table with description

#### 2b. `skills/refactor/SKILL.md`
- **D5/D6:** Update Polish Auto-Chain next actions:
  - `AUTO:refactor-brief` after explore → `AUTO:refactor-brief` (correct — matches new map)
  - `AUTO:refactor-implement` after brief → `AUTO:polish-implement`
  - `WAIT:human-checkpoint:polish-complete` → `WAIT:human-checkpoint:polish-update-docs`
- **D5/D6:** Update Overhaul Auto-Chain next actions:
  - `AUTO:refactor-brief` after explore → `AUTO:refactor-brief` (correct)
  - `AUTO:plan:<brief>` after brief → `AUTO:overhaul-plan`
  - `AUTO:delegate:<plan>` after overhaul-plan → `AUTO:refactor-delegate`
  - `AUTO:review:<path>` after overhaul-delegate → `AUTO:refactor-review`
  - `AUTO:synthesize:<feature>` after overhaul-update-docs → `AUTO:refactor-synthesize`
  - `WAIT:human-checkpoint:overhaul-merge` → `WAIT:human-checkpoint:synthesize`
- **D5/D6:** Update Integration Points (HSM Phase → Next Action) table
- **D8:** Update `"version": "1.0"` → `"1.1"` in state schema example

#### 2c. `skills/refactor/phases/auto-chain.md`
- Update all `Returns:` lines to match actual server values
- Update action-to-behavior mapping table

#### 2d. `skills/refactor/phases/polish-validate.md`
- Fix `Next action: AUTO:refactor-implement` → correct action value

#### 2e. `skills/refactor/phases/polish-implement.md`
- Fix `Next action: AUTO:plan:<brief>` → correct action value

#### 2f. `skills/debug/references/state-schema.md`
- **D7:** Add track prefixes to all phase names:
  - `implement` → `hotfix-implement` / `debug-implement`
  - `validate` → `hotfix-validate` / `debug-validate`
  - `review` → `debug-review`
- **D8:** Update `"version": "1.0"` → `"1.1"` (4 occurrences)

#### 2g. `skills/workflow-state/SKILL.md`
- **D1:** Document all worktree status values: `'active' | 'merged' | 'removed'`
- **D8:** Update version reference from "1.0" to "1.1"
- **D9:** Mark `workflowType` as required (remove "defaults to feature" language)

#### 2h. `docs/designs/2026-02-04-workflow-state-mcp.md`
- **D2:** Remove `:<path>` from next_action example: `"AUTO:plan:<path>"` → `"AUTO:plan"`
- **D6:** Fix `HUMAN_CHECKPOINT(polish-complete)` → `HUMAN_CHECKPOINT(polish-update-docs)`

**Dependencies:** None (doc changes don't depend on server fix)
**Parallelizable:** Yes (with Task 1)

---

### Task 3: Verify consistency end-to-end

**Phase:** Verification

1. Run full MCP server test suite: `cd plugins/exarchos/servers/exarchos-mcp && npm run test:run`
2. Run typecheck: `npm run typecheck`
3. Grep for any remaining phantom values across all instruction files:
   - `AUTO:plan:` (with colon-suffix, excluding `AUTO:plan-review`)
   - `AUTO:refactor-explore`
   - `AUTO:refactor-implement`
   - `AUTO:refactor-plan`
   - `in_progress` near worktree context
   - `polish-complete`
   - `overhaul-merge`
   - `"version": "1.0"` in skill/rule files
4. Verify zero matches for all phantom values

**Dependencies:** Tasks 1, 2
**Parallelizable:** No

---

## Parallelization Strategy

```
Task 1 (server fix + tests)  ──────┐
                                    ├─→ Task 3 (verification)
Task 2 (documentation fixes) ──────┘
```

- Tasks 1 and 2 can run in parallel (different file sets, no overlap)
- Task 3 runs after both complete

### Worktree Plan

| Worktree | Branch | Tasks |
|----------|--------|-------|
| server-fix | refactor/mcp-consistency/server | 1 |
| doc-fix | refactor/mcp-consistency/docs | 2 |
| (main) | refactor/mcp-consistency | 3 (verification) |

## Completion Checklist
- [ ] Refactor PHASE_ACTION_MAP entries for explore/brief fixed
- [ ] 8 new tests covering all refactor next_action phases
- [ ] All next_action values in docs match server behavior
- [ ] All worktree status values documented (active/merged/removed)
- [ ] All debug phase names use track prefixes
- [ ] Version references updated to 1.1
- [ ] workflowType documented as required
- [ ] BLOCKED:circuit-open documented
- [ ] No phantom action values remain
- [ ] Full test suite green
