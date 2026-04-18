# Autonomous Phase-Branch Merge Orchestrator

**Target version:** v2.8.5 -- v3.0
**Cross-cutting reference:** [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) (event-sourcing integrity, MCP parity, basileus-forward)
**Depends on:** insights-remediation dispatch guards (DR-1 branch ancestry validation, DR-2 worktree assertion)
**Related:** `setup-worktree.ts`, `verify-worktree.ts`, `validate-pr-stack.ts`, `merge-pr.ts`, `post-merge.ts`

## Overview

Analysis of 137 Claude Code sessions surfaced a recurring class of failures: subagents branching from wrong bases, merges executed from wrong worktrees, and cherry-pick conflicts caused by divergent ancestry. The insights-remediation feature adds dispatch guards (DR-1 branch ancestry validation, DR-2 worktree assertion) as point checks. This design extends those guards into a fully autonomous merge orchestrator that pre-validates branch topology, executes merges with rollback capability, resolves conflicts through semantic strategies, detects worktree drift, and persists state for session survival -- all without human intervention.

The orchestrator is a single handler in the dispatch core, surfaced identically through CLI and MCP. Every state transition emits an event. The full merge lifecycle is reconstructable from the event log alone.

## Architecture

### Module layout

```
servers/exarchos-mcp/src/orchestrate/
  merge-orchestrator/
    index.ts                    # Composer: preflight -> execute -> verify -> emit
    schema.ts                   # Zod schemas + derived TS types
    preflight.ts                # Topology validation, drift detection, ancestry checks
    executor.ts                 # Merge execution with rollback capability
    conflict-resolver.ts        # Semantic conflict resolution strategies
    state-file.ts               # Structured state persistence for session survival
    index.test.ts               # Composer tests
  merge-orchestrator.parity.test.ts   # CLI <-> MCP parity test
```

### Handler contract

```ts
// schema.ts
export const MergeStrategySchema = z.enum(['squash', 'rebase', 'merge']);
export const ConflictStrategySchema = z.enum(['line-level', 'ast-aware', 'manual']);

export const MergePreflightResultSchema = z.object({
  topologyValid: z.boolean(),
  ancestryValid: z.boolean(),
  worktreeClean: z.boolean(),
  driftDetected: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const MergeOrchestratorOutputSchema = z.object({
  phase: z.enum(['preflight', 'executing', 'conflict-resolution', 'completed', 'rolled-back']),
  preflight: MergePreflightResultSchema,
  mergeSha: z.string().optional(),
  conflictsResolved: z.number().int().nonnegative(),
  rollbackSha: z.string().optional(),
  stateFileWritten: z.boolean(),
});
```

### Composer flow

```
exarchos merge-orchestrate (CLI)     exarchos_orchestrate({action:"merge_orchestrate"}) (MCP)
         |                                              |
         +------------------+---------------------------+
                            v
            dispatch('exarchos_orchestrate', {action:'merge_orchestrate'}, ctx)
                            v
               handleMergeOrchestrate(args, ctx)    <- merge-orchestrator/index.ts
                            v
  1. preflight(args, ctx)                           <- merge-orchestrator/preflight.ts
     - DR-1 branch ancestry validation
     - DR-2 worktree assertion
     - topology pre-validation (base reachable, no orphaned branches)
     - worktree drift detection (uncommitted changes, stale index)
                            v
  2. emit('merge.preflight', { result })
                            v
  3. IF preflight.passed:
       executor.merge(args, ctx)                    <- merge-orchestrator/executor.ts
       - record rollback SHA before merge
       - execute merge with chosen strategy
       - emit('merge.executed', { sha, strategy })
                            v
  4. IF conflicts detected:
       conflictResolver.resolve(args, ctx)          <- merge-orchestrator/conflict-resolver.ts
       - apply conflict strategy (line-level or AST-aware)
       - emit('merge.conflict.detected', { files, strategy })
       - emit('merge.conflict.resolved', { files }) OR emit('merge.rollback', { sha })
                            v
  5. stateFile.write(ctx)                           <- merge-orchestrator/state-file.ts
       - persist orchestrator state for session survival
                            v
  6. return MergeOrchestratorOutputSchema.parse(result)
```

## Requirements

### DR-MO-1: Base-Branch Topology Pre-Validation

Extends DR-1/DR-2 dispatch guards into a topology-aware preflight that validates the entire merge path before execution begins.

**Capabilities:**
- Verify the source branch is a descendant of the target base branch (reuses DR-1 ancestry validation)
- Confirm the merge is being initiated from the correct worktree (reuses DR-2 worktree assertion)
- Detect orphaned branches that would create disconnected merge paths
- Validate that no intermediate branches in a stack have been force-pushed or rebased without propagation

**Acceptance criteria:**
1. Preflight rejects merges when `git merge-base --is-ancestor` fails between source and target
2. Preflight rejects merges initiated from a worktree that does not match the source branch
3. Preflight emits a `merge.preflight` event containing the full topology check results
4. Preflight completes in under 2 seconds for repositories with up to 50 open branches
5. All preflight checks are injectable (no module-globals) for unit testing without a live git repo

### DR-MO-2: Merge Execution with Rollback

The executor records recovery state before modifying any refs, executes the merge, and rolls back on failure.

**Capabilities:**
- Record the pre-merge HEAD SHA as a rollback point before any ref mutation
- Execute merge using the caller-specified strategy (squash, rebase, or merge commit)
- On merge failure or post-merge verification failure, reset to the recorded rollback SHA
- Emit distinct events for success (`merge.executed`) and rollback (`merge.rollback`)

**Acceptance criteria:**
1. Rollback SHA is recorded and persisted to state file before the merge command runs
2. After rollback, `git rev-parse HEAD` matches the recorded rollback SHA
3. Rollback event includes the reason for rollback (conflict, verification failure, timeout)
4. Merge execution uses `execFileSync` (not shell interpolation) for command injection safety
5. Handler returns `ToolResult` with `success: false` and structured error on rollback

### DR-MO-3: Semantic Conflict Resolution

Provides two conflict resolution strategies: line-level (default) and AST-aware (opt-in). The orchestrator selects the strategy based on file type and caller preference, and falls back to rollback when resolution fails.

**Capabilities:**
- Line-level resolution: parse standard git conflict markers, apply heuristic resolution (accept-theirs for generated files, accept-ours for lock files, prompt-needed for source)
- AST-aware resolution (future): parse TypeScript/JavaScript AST for both sides, merge at the declaration level rather than line level, detect semantic conflicts that line-level would miss (renamed imports, reordered exports)
- File-type routing: `.lock` files always accept-incoming, generated files (e.g., `skills/`) always accept-current, source files use the configured strategy
- Fallback: if any conflict cannot be resolved automatically, rollback the entire merge and report unresolvable files

**Acceptance criteria:**
1. Line-level strategy resolves at least lock-file and generated-file conflicts without human input
2. AST-aware strategy is behind a feature flag (`--conflict-strategy ast-aware`) and defaults to off
3. Unresolvable conflicts trigger a full rollback, not a partial merge state
4. Each resolved file emits a `merge.conflict.resolved` event with the resolution method used
5. Conflict resolution operates on the working tree only -- no ref mutations until all conflicts resolve

### DR-MO-4: Worktree Drift Detection and Recovery

Detects when a worktree has drifted from its expected state (uncommitted changes, stale index, detached HEAD) and either recovers automatically or aborts with a diagnostic report.

**Capabilities:**
- Detect uncommitted changes in the worktree (`git status --porcelain`)
- Detect stale index state (index differs from HEAD)
- Detect detached HEAD (worktree not on a branch)
- Auto-recover from stale index by running `git reset` (soft) when uncommitted changes are absent
- Abort with actionable diagnostic when uncommitted changes would be lost

**Acceptance criteria:**
1. Drift detection runs as part of preflight (DR-MO-1) before any merge operation
2. Clean worktrees pass drift detection in under 500ms
3. Auto-recovery is limited to `git reset` (soft reset only) -- never discards uncommitted work
4. Diagnostic report includes the specific drift type and a suggested recovery command
5. Drift detection emits findings as warnings in the `merge.preflight` event, not separate events

### DR-MO-5: Structured State File for Session Survival

Persists the orchestrator's current phase, rollback SHA, conflict state, and pending actions to a JSON state file, enabling a new session to resume a merge that was interrupted by context exhaustion or session timeout.

**Capabilities:**
- Write state file to `<stateDir>/merge-orchestrator/<featureId>.json` after each phase transition
- Include: current phase, rollback SHA, source/target branches, conflict file list, retry count
- On handler entry, check for existing state file and resume from the recorded phase
- Expire state files after 24 hours (stale merges should not auto-resume)

**Acceptance criteria:**
1. State file is valid JSON parseable by `MergeOrchestratorStateSchema.parse()`
2. Handler resumes from the correct phase when a state file exists and is under 24 hours old
3. Expired state files are deleted on detection, not silently ignored
4. State file path is deterministic from `stateDir + featureId` (no random components)
5. State file writes are atomic (write to temp file, rename) to prevent corruption on crash

## Event catalog

| Event type | Emitted by | Payload |
|---|---|---|
| `merge.preflight` | preflight.ts | `{ featureId, sourceBranch, targetBranch, topologyValid, ancestryValid, worktreeClean, driftDetected, errors[], warnings[] }` |
| `merge.executed` | executor.ts | `{ featureId, sourceBranch, targetBranch, strategy, mergeSha, rollbackSha }` |
| `merge.conflict.detected` | conflict-resolver.ts | `{ featureId, files[], conflictStrategy, totalConflicts }` |
| `merge.conflict.resolved` | conflict-resolver.ts | `{ featureId, files[], resolutionMethod, resolvedCount }` |
| `merge.rollback` | executor.ts | `{ featureId, rollbackSha, reason, phase }` |

All events are appended to the `orchestrate` stream via `ctx.eventStore.append()`. Events carry the `featureId` as the correlation key, enabling reconstruction of the full merge lifecycle from events alone. The event payloads use the same Zod schemas as the handler output (types derived via `z.infer`), so schema-type divergence is eliminated by construction.

## CLI surface

Top-level command: `exarchos merge-orchestrate`

```
exarchos merge-orchestrate \
  --feature-id <id> \
  --source-branch <branch> \
  --target-branch <branch> \
  --strategy <squash|rebase|merge> \
  --conflict-strategy <line-level|ast-aware> \
  --resume                              # resume from state file if present
  --dry-run                             # run preflight only, do not execute merge
```

Exit codes follow the existing `CLI_EXIT_CODES` contract:
- 0: merge completed successfully
- 1: invalid input (missing args, bad strategy)
- 2: merge failed (conflict unresolvable, rollback executed)
- 3: uncaught exception

The `--dry-run` flag runs preflight (DR-MO-1) and drift detection (DR-MO-4) without executing the merge, returning the preflight report. This enables CI integration where merge readiness is checked before the merge window opens.

## MCP surface

`exarchos_orchestrate({ action: "merge_orchestrate", ... })` routes through `composite.ts` into `handleMergeOrchestrate`. The action is registered in `registry.ts` with the same Zod schema as the CLI flags, enforcing parity at the type level.

Arguments mirror the CLI flags as camelCase properties:
```ts
{
  action: "merge_orchestrate",
  featureId: string,
  sourceBranch: string,
  targetBranch: string,
  strategy: "squash" | "rebase" | "merge",
  conflictStrategy?: "line-level" | "ast-aware",
  resume?: boolean,
  dryRun?: boolean,
}
```

The return shape is `ToolResult` wrapping `MergeOrchestratorOutputSchema`, identical to CLI output. Both adapters call the same handler function with the same argument types.

## #1109 compliance matrix

| Constraint | How this design complies | Verification |
|---|---|---|
| **Event-sourcing integrity** | Every phase transition emits an event (5 event types). The merge lifecycle is fully reconstructable from the event log. State file supplements but does not replace events -- it exists only for session resumption, not as source of truth. | Parity test asserts event emission count matches phase transitions. Integration test reconstructs merge timeline from events alone. |
| **MCP parity** | Single handler function (`handleMergeOrchestrate`) called by both CLI adapter and MCP composite router. Zod schema shared between CLI flag parser and MCP action schema. No CLI-only code paths. | `merge-orchestrator.parity.test.ts` invokes handler through both CLI adapter and MCP dispatch, asserts identical `ToolResult` shape. |
| **Basileus-forward** | Handler accepts `DispatchContext` (not raw stateDir string). VCS operations use `VcsProvider` abstraction, not direct `gh` calls. State file format is JSON (portable across transports). No stdin/stdout assumptions -- all I/O through context-injected interfaces. | Code review checklist: no `process.stdin`, no `process.stdout`, no `execSync('gh ...')`. All VCS calls go through `createVcsProvider({ config: ctx.projectConfig })`. |

## Dependencies and sequencing

1. **DR-1/DR-2 dispatch guards** (insights-remediation) must land first. The preflight module imports and composes these guards rather than reimplementing ancestry/worktree validation.
2. **VcsProvider abstraction** (already landed in `validate-pr-stack.ts`) is reused for any PR-aware operations during post-merge cleanup.
3. **AST-aware conflict resolution** (DR-MO-3, future flag) is deferred to a follow-up PR. The initial implementation ships with line-level resolution only.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Auto-rollback destroys intended changes | High | Rollback only resets to the recorded pre-merge SHA. Uncommitted work is detected and blocked by drift detection (DR-MO-4) before any merge begins. |
| State file corruption on crash | Medium | Atomic writes (temp + rename). State file is supplementary -- events remain the source of truth. Corrupted state files are deleted, forcing a fresh preflight. |
| AST parser adds heavyweight dependency | Medium | AST-aware strategy is behind a feature flag and deferred. Initial release ships line-level only, which requires no new dependencies. |
| Git operations hang on large repos | Low | All `execFileSync` calls include a 30-second timeout. Preflight timeout is 2 seconds (DR-MO-1 AC-4). |
