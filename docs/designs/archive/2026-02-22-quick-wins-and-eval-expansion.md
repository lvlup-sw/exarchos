# Design: Quick Wins Batch + Core Workflow Eval Expansion

## Problem Statement

Three categories of technical debt need attention before moving to larger features:

1. **Active bug** (#775): The `scope-assessment-complete` guard rejects valid `explore.scopeAssessment` state because the `explore` field is not initialized in the default state structure. Refactor workflows that set `explore.scopeAssessment` then transition to `brief` hit a guard failure.

2. **Stale annotations**: Three event schemas (`ReviewFindingData`, `ReviewEscalatedData`, `QualityRegressionData`) still carry `@planned` despite having production emitters. This creates confusion about what's actually live.

3. **Eval coverage gap**: Only 3 eval suites exist (delegation, quality-review, reliability). Core workflow skills — ideate, plan, delegate, refactor, debug — drive every development workflow but lack regression protection. When skill content changes, there's no automated gate to catch behavioral regressions.

## Chosen Approach

**Spec-driven assertions + historical data mining.** Extract testable assertions directly from each skill's SKILL.md specification (required tool calls, phase transition sequences, artifact creation). Mine historical workflow state files for realistic golden dataset entries. Verify with a single test run.

**Rationale:** Mirrors the existing delegation eval suite pattern. Spec-derived assertions stay aligned with skill definitions. Historical state files across projects (exarchos, valkyrie, ares-elite-frontend) provide realistic data shapes without needing to run full workflows.

## Technical Design

### Part 1: Quick Wins

#### 1A. Fix #775 — `explore` field initialization

**Root cause:** `initStateFile()` in `state-store.ts` does not initialize `explore: {}` in the default state. When `applyDotPath` sets `explore.scopeAssessment`, the value persists correctly, but re-materialization in the ES v2 path may lose it.

**Fix:** Add `explore: {}` to the initial state in `initStateFile()`. Add a test that:
1. Initializes a refactor workflow
2. Sets `explore.scopeAssessment` via `handleSet`
3. Transitions to `brief` phase
4. Asserts the transition succeeds (guard passes)

#### 1B. Remove stale `@planned` annotations

Remove `@planned` from:
- `ReviewFindingData` (emitted by quality-review skill)
- `ReviewEscalatedData` (emitted by quality-review skill)
- `QualityRegressionData` (emitted by quality gate)

Add promotion tests for each (similar to the existing `quality.hint.generated` promotion test):
- Assert that each event type is present in the `EventType` union without `@planned`
- Assert that each data schema validates against a sample payload

#### 1C. Add shepherd event schemas

Add to `schemas.ts`:
- `ShepherdStartedData` — `{ prUrl: string; stackSize: number; ciStatus: string }`
- `ShepherdIterationData` — `{ prUrl: string; iteration: number; action: string; outcome: string }`
- `ShepherdApprovalRequestedData` — `{ prUrl: string; reviewers: string[] }`
- `ShepherdCompletedData` — `{ prUrl: string; merged: boolean; iterations: number; duration: number }`

Add corresponding entries to the `EventType` discriminated union. Mark with `@planned` initially since the shepherd skill needs updating to emit typed events.

#### 1D. Clean up legacy `team.task.assigned` CQRS handling

Search for legacy `team.task.assigned` handling in CQRS views that predates the current event schema. Remove dead code paths or update to use current `TeamTaskAssignedData` schema.

### Part 2: Eval Suite Expansion

#### Target Skills and Assertions

Each suite follows the established pattern: `suite.json` + `datasets/regression.jsonl` + `datasets/golden.jsonl`.

**Ideate (brainstorming) suite:**
```
Assertions:
- tool-call: requires exarchos_workflow.init, exarchos_workflow.set
- trace-pattern: workflow.started → workflow.transition (ideate→plan)
- exact-match: artifacts.design path exists in final state
```

Golden cases (3-5):
- Simple feature brainstorm → design doc produced
- Brainstorm with constraints → design reflects constraints
- Brainstorm with multiple approaches → 2-3 options documented

**Plan (implementation-planning) suite:**
```
Assertions:
- tool-call: requires exarchos_workflow.set (phase=plan-review, tasks populated)
- trace-pattern: workflow.transition (plan→plan-review)
- exact-match: artifacts.plan path exists, tasks array non-empty
- llm-rubric: "Evaluate whether the plan covers all design sections with traceable tasks.
               Score 1 if every section maps to >=1 task. Score 0 if major gaps exist."
```

Golden cases (3-5):
- Small design (3 tasks) → plan with dependencies
- Large design (10+ tasks) → parallel groups identified
- Design with testing strategy → PBT/benchmark flags set

**Refactor suite:**
```
Assertions:
- tool-call: requires exarchos_workflow.init (workflowType=refactor)
- trace-pattern: workflow.started → (explore→brief→implement→validate)
- exact-match: workflowType = "refactor" in state
```

Golden cases (3-5):
- Polish track (small refactor) → direct implementation
- Overhaul track → delegation to worktrees
- Track selection → correct track chosen based on scope

**Debug suite:**
```
Assertions:
- tool-call: requires exarchos_workflow.init (workflowType=debug)
- trace-pattern: workflow.started → (triage→investigate→fix→validate)
- exact-match: workflowType = "debug" in state
```

Golden cases (3-5):
- Hotfix track → quick fix applied
- Thorough track → root cause analysis documented
- Track selection → correct track based on severity

#### Dataset Construction

**Mining approach:**
1. Read historical state files from `~/.claude/workflow-state/` and project-local `docs/workflow-state/` directories
2. Extract realistic `input` shapes (tool calls, state transitions, task structures)
3. Derive `expected` shapes from the final state (artifacts, phase, task statuses)
4. Tag with `regression` layer for CI gate enforcement

**Golden data construction:**
1. Hand-craft 3-5 scenarios per skill from SKILL.md specifications
2. Model after the existing `evals/delegation/datasets/golden.jsonl` format
3. Include edge cases (empty tasks, missing artifacts, invalid transitions)

#### Directory Structure

```
evals/
  brainstorming/
    suite.json
    datasets/
      regression.jsonl
      golden.jsonl
  implementation-planning/
    suite.json
    datasets/
      regression.jsonl
      golden.jsonl
  refactor/
    suite.json
    datasets/
      regression.jsonl
      golden.jsonl
  debug/
    suite.json
    datasets/
      regression.jsonl
      golden.jsonl
```

## Integration Points

- **Event store schemas** (`servers/exarchos-mcp/src/event-store/schemas.ts`) — stale annotation removal, shepherd schema addition
- **State store** (`servers/exarchos-mcp/src/state/state-store.ts`) — `explore` field initialization for #775
- **Eval harness** (`servers/exarchos-mcp/src/evals/`) — new suites discovered by `discoverSuites()`
- **CI gate** (`.github/workflows/eval-gate.yml`) — new suites automatically included in regression runs
- **CQRS views** (`servers/exarchos-mcp/src/views/`) — legacy handler cleanup

## Testing Strategy

### Quick wins testing
- **#775 fix:** Unit test: init refactor state → set explore.scopeAssessment → transition to brief → assert success
- **@planned removal:** Snapshot test: assert `@planned` not present on the three schemas
- **Shepherd schemas:** Schema validation test: assert each schema validates sample payloads
- **CQRS cleanup:** Existing view tests remain green after removal

### Eval suite testing
- **Suite discovery:** Assert `discoverSuites()` finds all new suites
- **Dataset parsing:** Assert all JSONL files parse without errors via `DatasetLoader`
- **Grader execution:** Run each suite with `--layer regression` and verify all cases pass
- **Verification run:** Single `npm run eval:run` execution confirms end-to-end

## Open Questions

1. **Shepherd schema fields** — The exact event payloads depend on what the shepherd skill currently emits untyped. Need to inspect actual emissions to confirm field shapes. If unclear, mark schemas as `@planned` and refine later.

2. **Historical state file format versions** — Older state files may use v1.0 format without `_esVersion`. The mining script needs to handle both formats.

3. **LLM rubric graders for plan suite** — Require `ANTHROPIC_API_KEY` in CI. The capability-llm layer is advisory-only, so this is acceptable, but we should ensure the CI gate doesn't fail when the key is absent (existing behavior handles this via skip).
