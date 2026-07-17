# Port Remaining 21 run_script Bash Scripts to TypeScript

**Date:** 2026-03-11
**Status:** Draft
**Feature ID:** `refactor-port-scripts-to-ts`
**Workflow Type:** refactor (overhaul track)
**Issue:** #998

## Problem Statement

After porting the 12 MCP-hardcoded bash scripts to TypeScript (consolidated-post-merge-fixes, PR #999), 21 bash scripts remain accessible via the generic `exarchos_orchestrate({ action: "run_script" })` action. These scripts use `resolveScript()` for path resolution but still require a POSIX shell — failing on Windows and in non-Claude-Code environments (Cursor, Windsurf).

### Current Architecture (broken)

```
Skill/playbook → exarchos_orchestrate({ action: "run_script", script: "foo.sh" })
              → resolveScript("foo.sh") → execFileSync(resolved path)
              → parse stdout → return result
```

### Target Architecture (clean)

```
Skill/playbook → exarchos_orchestrate({ action: "foo" })
              → TypeScript handler (pure logic, no subprocess)
              → return structured result
```

## Requirements

### DR-1: Port All 21 Scripts to TypeScript Handlers

Each script becomes a named orchestrate action handler in `servers/exarchos-mcp/src/orchestrate/`, registered in `composite.ts` and `registry.ts`.

**Scripts by complexity batch:**

#### Batch 1: Simple Utilities (4 scripts)

| Script | Lines | Handler Name | Logic Summary |
|--------|-------|-------------|---------------|
| `extract-task.sh` | 68 | `extract-task.ts` | Extract single task section from plan markdown by task ID |
| `review-diff.sh` | 64 | `review-diff.ts` | Format git diff as markdown report |
| `verify-worktree.sh` | 85 | `verify-worktree.ts` | Check CWD is inside a `.worktrees/` path |
| `select-debug-track.sh` | 187 | `select-debug-track.ts` | Decision tree: urgency × known root cause → HOTFIX/THOROUGH |

#### Batch 2: Medium Validators (10 scripts)

| Script | Lines | Handler Name | Logic Summary |
|--------|-------|-------------|---------------|
| `check-coverage-thresholds.sh` | 195 | `check-coverage-thresholds.ts` | Parse coverage JSON, compare against thresholds |
| `spec-coverage-check.sh` | 231 | `spec-coverage-check.ts` | Cross-reference plan tasks with test files |
| `check-pr-comments.sh` | 128 | `check-pr-comments.ts` | Analyze PR comment threads via gh API |
| `validate-pr-body.sh` | 173 | `validate-pr-body.ts` | Validate PR body against required sections |
| `validate-pr-stack.sh` | 147 | `validate-pr-stack.ts` | Validate linear PR chain (no forks, no gaps) |
| `debug-review-gate.sh` | 202 | `debug-review-gate.ts` | Run debug-specific review checks |
| `investigation-timer.sh` | 172 | `investigation-timer.ts` | Parse ISO8601 timestamps, calculate elapsed vs budget |
| `extract-fix-tasks.sh` | 180 | `extract-fix-tasks.ts` | Transform review findings to fix task JSON array |
| `generate-traceability.sh` | 210 | `generate-traceability.ts` | Build design→plan→task traceability matrix |
| `assess-refactor-scope.sh` | 240 | `assess-refactor-scope.ts` | File count + module span → polish/overhaul recommendation |

#### Batch 3: Complex State Orchestration (7 scripts)

| Script | Lines | Handler Name | Logic Summary |
|--------|-------|-------------|---------------|
| `setup-worktree.sh` | 324 | `setup-worktree.ts` | Create git worktree with branch, install deps, run baseline tests |
| `verify-worktree-baseline.sh` | 160 | `verify-worktree-baseline.ts` | Auto-detect project type, run baseline tests in worktree |
| `post-delegation-check.sh` | 318 | `post-delegation-check.ts` | Validate all delegation tasks complete, run per-worktree tests |
| `reconcile-state.sh` | 347 | `reconcile-state.ts` | Validate state file against git reality (5 checks) |
| `pre-synthesis-check.sh` | 476 | `pre-synthesis-check.ts` | 7 pre-synthesis checks with workflow-specific phase graphs |
| `verify-delegation-saga.sh` | 241 | `verify-delegation-saga.ts` | Parse event JSONL, validate team event ordering rules |
| `new-project.sh` | 104 | `new-project.ts` | Scaffold project from template with language-specific setup |

### DR-2: Register Handlers in Orchestrate System

1. Add each handler to `ACTION_HANDLERS` map in `composite.ts`
2. Add Zod schema for each action's args in `registry.ts`
3. Handlers follow the established pattern: accept typed args + stateDir, return `ToolResult`

### DR-3: Update Playbook `validationScripts` References

Three playbook entries reference bash scripts:

| Playbook | Phase | Current `validationScripts` | New Action |
|----------|-------|---------------------------|-----------|
| `feature:delegate` | delegate | `['scripts/post-delegation-check.sh']` | `post_delegation_check` |
| `feature:synthesize` | synthesize | `['scripts/pre-synthesis-check.sh', 'scripts/validate-pr-stack.sh']` | `pre_synthesis_check`, `validate_pr_stack` |
| `refactor:synthesize` | synthesize | `['scripts/pre-synthesis-check.sh', 'scripts/validate-pr-stack.sh']` | `pre_synthesis_check`, `validate_pr_stack` |

After porting, update these to reference the new action names. The `validationScripts` field may need rethinking — either keep as string references to action names, or introduce a `validationActions` field.

### DR-4: Remove `run_script` Action

Once all 21 scripts are ported, fully remove the `run_script` action and all associated code:
1. Delete `run_script` handler (`servers/exarchos-mcp/src/orchestrate/run-script.ts`)
2. Remove `run_script` entry from `ACTION_HANDLERS` in `composite.ts`
3. Remove `run_script` Zod schema from `registry.ts`
4. Remove `resolveScript()` utility and any script-resolution infrastructure
5. Remove all first-party `.sh` scripts from `scripts/` directory
6. Remove corresponding `.test.sh` files
7. Remove any `run_script` references in skills, rules, or commands

## Migration Strategy

Follow the same behavioral-snapshot-first pattern established by the 12 MCP-hardcoded ports:

1. **Capture**: Run bash script with known inputs, capture stdout/stderr/exit code as vitest fixtures
2. **Port**: Implement equivalent TypeScript logic in handler file
3. **Verify**: Assert TypeScript produces equivalent structured results
4. **Delete**: Remove bash script and `.test.sh` file

### Dependency Replacement

| Bash Tool | TypeScript Equivalent |
|-----------|----------------------|
| `jq` | `JSON.parse()` + type guards (zod already available) |
| `git` | `execFileSync('git', [...])` (already used by other handlers) |
| `gh` CLI | `execFileSync('gh', [...])` or GitHub REST API |
| `awk/sed` | Native string methods + regex |
| `date` parsing | `Date` constructor + `Date.now()` |
| `grep` | Native regex matching |

### Patterns to Preserve

1. **Check/fail tracking**: Array-based result collection with pass/fail/skip counts → TypeScript class or utility
2. **Markdown output**: Structured markdown with headings, tables, code blocks → template strings
3. **Exit code semantics**: 0=success, 1=validation failure, 2=usage error → `{ passed: boolean }` result type
4. **Gate event emission**: All handlers emit `gate.executed` events via `gate-utils.ts`

## Task Decomposition

### Parallel Group A (Batch 1 — 4 tasks, can run simultaneously)

- **Task A1**: Port `extract-task.sh` → `extract-task.ts`
- **Task A2**: Port `review-diff.sh` → `review-diff.ts`
- **Task A3**: Port `verify-worktree.sh` → `verify-worktree.ts`
- **Task A4**: Port `select-debug-track.sh` → `select-debug-track.ts`

### Parallel Group B (Batch 2 — 10 tasks, groups of 3-4)

- **Task B1**: Port `investigation-timer.sh` → `investigation-timer.ts`
- **Task B2**: Port `check-coverage-thresholds.sh` → `check-coverage-thresholds.ts`
- **Task B3**: Port `assess-refactor-scope.sh` → `assess-refactor-scope.ts`
- **Task B4**: Port `check-pr-comments.sh` → `check-pr-comments.ts`
- **Task B5**: Port `validate-pr-body.sh` → `validate-pr-body.ts`
- **Task B6**: Port `validate-pr-stack.sh` → `validate-pr-stack.ts`
- **Task B7**: Port `debug-review-gate.sh` → `debug-review-gate.ts`
- **Task B8**: Port `extract-fix-tasks.sh` → `extract-fix-tasks.ts`
- **Task B9**: Port `generate-traceability.sh` → `generate-traceability.ts`
- **Task B10**: Port `spec-coverage-check.sh` → `spec-coverage-check.ts`

### Sequential Group C (Batch 3 — 7 tasks, ordered)

- **Task C1**: Port `verify-worktree-baseline.sh` → `verify-worktree-baseline.ts`
- **Task C2**: Port `setup-worktree.sh` → `setup-worktree.ts` (depends on C1)
- **Task C3**: Port `verify-delegation-saga.sh` → `verify-delegation-saga.ts`
- **Task C4**: Port `post-delegation-check.sh` → `post-delegation-check.ts` (depends on C3)
- **Task C5**: Port `reconcile-state.sh` → `reconcile-state.ts`
- **Task C6**: Port `pre-synthesis-check.sh` → `pre-synthesis-check.ts` (depends on C4, C5)
- **Task C7**: Port `new-project.sh` → `new-project.ts`

### Integration Task

- **Task I1**: Update `composite.ts`, `registry.ts`, and `playbooks.ts` to register all new handlers and update validation script references. Delete all ported `.sh` and `.test.sh` files. Mark `run_script` as deprecated.

## Success Criteria

1. All 21 scripts have TypeScript equivalents with vitest tests
2. No bash dependency remains for any first-party orchestrate action
3. Playbook `validationScripts` updated to reference TypeScript handlers
4. `npm run test:run` passes
5. `npm run typecheck` passes
6. All ported `.sh` and `.test.sh` files deleted
