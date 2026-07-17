# Self-Healing Autonomous PR Shepherd

**Date:** 2026-04-17
**Issue:** [#1120](https://github.com/lvlup-sw/exarchos/issues/1120)
**Target version:** v2.8.5 -- v3.0
**Cross-cutting reference:** [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) (event-sourcing integrity + MCP parity + basileus-forward)
**Related:** existing `shepherd-status-view.ts`, `skills-src/shepherd/SKILL.md`, `assess_stack` composite action

## Problem

The current shepherd skill averages 3-4 review iterations per PR, executing fixes sequentially within a single agent context. Each iteration re-reads the full PR, re-classifies all review threads, and applies fixes one at a time. This sequential approach has three costs: (1) wall-clock latency scales linearly with thread count, (2) unrelated fixes can interfere with each other when applied in sequence, and (3) the single agent context risks exhaustion on PRs with >10 review threads. The existing `shepherd-status-view.ts` tracks iteration count and overall PR health but has no concept of per-thread classification or parallel remediation.

## Goals

- Classify review threads by category (style, bug, architecture) using a lightweight classifier subagent, enabling differentiated handling strategies.
- Dispatch parallel fix agents -- one per classified cluster -- each operating in an isolated git worktree, eliminating cross-fix interference.
- Auto-revert clusters whose fixes cause test regressions, preserving known-good state without human intervention.
- Reduce average iterations-to-merge from 3-4 to 1-2 by resolving independent concerns in parallel.
- Expose the autonomous shepherd through both CLI (`exarchos shepherd-auto`) and MCP (`exarchos_orchestrate({ action: "shepherd-auto" })`), maintaining facade parity per #1109.

## Non-Goals

- Replacing the existing shepherd skill. The autonomous shepherd is an opt-in escalation; the existing sequential shepherd remains the default.
- Handling merge conflicts across stacked PRs. Stack-level coordination remains the responsibility of `assess_stack`.
- Auto-merging without human approval. The autonomous shepherd drives a PR to approval-ready state; a human still approves.
- Remote MCP deployment of fix agents. Local worktree isolation only; remote dispatch is #1081 scope.

---

## DR-SH-1: Review Thread Classification

**Requirement:** A classifier subagent analyzes all unresolved review threads on a PR and assigns each to exactly one category: `style`, `bug`, or `architecture`. Threads in the same category that touch overlapping file regions are grouped into a single cluster.

**Design:** The classifier runs as a lightweight subagent (no worktree needed -- read-only analysis). It receives the PR diff and all unresolved review comments via `assess_stack` output. Classification uses the review comment body, the diff hunk context, and the reviewer identity (bot vs. human) as inputs. Output is a `ClassifiedCluster[]` array where each cluster has a category, confidence score (0.0-1.0), affected file regions, and the originating comment thread IDs.

```typescript
interface ClassifiedCluster {
  readonly id: string;                    // deterministic hash of thread IDs
  readonly category: 'style' | 'bug' | 'architecture';
  readonly confidence: number;            // 0.0-1.0
  readonly threads: ReadonlyArray<{ threadId: string; file: string; line: number }>;
  readonly affectedFiles: ReadonlyArray<string>;
}
```

Clusters with `category: 'architecture'` and any cluster with `confidence < configuredThreshold` (default 0.6) are routed to escalation rather than automated fix.

**Acceptance criteria:**
- AC-1.1: Classifier produces a non-empty `ClassifiedCluster[]` for every PR with unresolved threads.
- AC-1.2: Each thread appears in exactly one cluster (no duplication, no omission).
- AC-1.3: Architecture-category clusters are never dispatched to fix agents; they route to escalation.
- AC-1.4: Classification is deterministic given the same inputs (no temperature-dependent variance).

---

## DR-SH-2: Parallel Fix-Agent Dispatch

**Requirement:** For each non-architecture cluster, the shepherd dispatches a dedicated fix agent in an isolated git worktree. Fix agents run concurrently and produce independent commits.

**Design:** Each fix agent is spawned via the existing subagent dispatch infrastructure (`exarchos:delegate`). The agent receives: (1) the cluster definition (category, threads, affected files), (2) a fresh worktree branched from the PR's head commit, and (3) the fix strategy from `references/fix-strategies.md` matching the cluster category. On completion, the fix agent produces a single commit on its worktree branch. The shepherd collects all fix branches and cherry-picks them onto the PR branch in cluster-ID order (deterministic).

Worktree lifecycle:
```
PR branch HEAD ──┬── worktree/cluster-abc (style fixes)
                 ├── worktree/cluster-def (bug fixes)
                 └── worktree/cluster-ghi (bug fixes)
```

Each worktree is created with `git worktree add` and removed after cherry-pick or revert. Maximum concurrent fix agents is configurable (`maxParallelFixes`, default 3) to bound resource consumption.

**Acceptance criteria:**
- AC-2.1: Fix agents run in isolated worktrees; no two agents modify the same worktree.
- AC-2.2: Cherry-pick order is deterministic (sorted by cluster ID).
- AC-2.3: If a fix agent fails (timeout, crash), its cluster is marked `failed` and the remaining clusters proceed.
- AC-2.4: Worktrees are cleaned up after use regardless of success or failure.
- AC-2.5: `maxParallelFixes` is respected; excess clusters queue rather than spawn unbounded agents.

---

## DR-SH-3: Auto-Revert on Test Regression

**Requirement:** After cherry-picking each cluster's fix onto the PR branch, the test suite runs. If tests regress (new failures not present before the cherry-pick), the cluster's commit is reverted automatically.

**Design:** The revert check runs incrementally after each cherry-pick in sequence:

1. Run test suite after cherry-picking cluster N.
2. Compare results against the baseline (test results at PR HEAD before any fixes).
3. If new failures appear, `git revert --no-edit <cluster-N-commit>` and emit `shepherd.fix.reverted`.
4. If no regression, proceed to cluster N+1.

This sequential verification after parallel fix generation preserves the speed benefit of parallel work while ensuring each fix is validated in the integrated context. A cluster that is reverted emits detailed diagnostics (failing test names, regression diff) for inclusion in the escalation report.

**Acceptance criteria:**
- AC-3.1: Test baseline is captured before any cherry-picks are applied.
- AC-3.2: A reverted cluster does not block subsequent clusters from being applied.
- AC-3.3: `shepherd.fix.reverted` event includes the cluster ID, failing tests, and revert commit SHA.
- AC-3.4: If all clusters are reverted, the PR branch returns to its original HEAD (no net change).

---

## DR-SH-4: Escalation Thresholds

**Requirement:** The autonomous shepherd escalates to the user when automated remediation cannot make further progress. Escalation criteria extend the existing `references/escalation-criteria.md` with autonomous-specific triggers.

**Design:** Escalation triggers (any one is sufficient):

| Trigger | Condition |
|---------|-----------|
| Architecture feedback | Any cluster classified as `architecture` |
| Low confidence | Any cluster with `confidence < threshold` (default 0.6) |
| Repeated revert | Same cluster reverted in 2+ consecutive autonomous runs |
| All clusters reverted | Every fix in a run was reverted (test suite incompatible with all fixes) |
| Unrelated CI failure | CI fails on a check unrelated to the classified clusters (infra, flaky) |
| Iteration budget exhausted | `autonomousIteration >= maxAutonomousIterations` |
| Conflicting fixes | Two clusters modify the same file region (detected at cherry-pick time via merge conflict) |

On escalation, the shepherd emits `shepherd.escalated` with the trigger reason and a structured report following the existing escalation report format. The user can then override with `--continue` or switch to manual shepherd mode.

**Acceptance criteria:**
- AC-4.1: Each escalation trigger from the table above is implemented and tested individually.
- AC-4.2: Escalation report includes per-cluster status (applied, reverted, skipped, escalated).
- AC-4.3: After escalation, the PR branch is in a consistent state (no partial cherry-picks).
- AC-4.4: User can resume autonomous mode after resolving the escalation cause.

---

## DR-SH-5: Iteration Budgets

**Requirement:** The autonomous shepherd operates within configurable resource bounds to prevent runaway loops.

**Design:** Two budget dimensions:

1. **Autonomous iterations** (`maxAutonomousIterations`, default 3): How many full classify-dispatch-verify cycles the autonomous shepherd runs before escalating. This is distinct from the existing `maxIterations` (default 5) which governs the outer sequential shepherd loop.

2. **Confidence threshold** (`confidenceThreshold`, default 0.6): Minimum classifier confidence required to dispatch a fix agent. Clusters below this threshold are escalated.

Configuration is provided via workflow state or CLI flags:
```typescript
exarchos_orchestrate({
  action: "shepherd-auto",
  args: {
    featureId: "<id>",
    prNumbers: [123],
    maxAutonomousIterations: 3,     // default: 3
    confidenceThreshold: 0.6,       // default: 0.6
    maxParallelFixes: 3,            // default: 3
    testCommand: "npm run test:run" // default: auto-detect
  }
})
```

Budget state is persisted in the shepherd view so that resumption after escalation continues from the correct iteration count rather than restarting.

**Acceptance criteria:**
- AC-5.1: Autonomous iteration count persists across session boundaries via the shepherd status view.
- AC-5.2: Budget configuration is accepted from both CLI flags and MCP args with identical semantics.
- AC-5.3: Default values produce safe behavior (3 iterations, 0.6 confidence = conservative).
- AC-5.4: Budget exhaustion triggers escalation, not silent termination.

---

## DR-SH-6: CLI Command and MCP Action Surface

**Requirement:** The autonomous shepherd is accessible as both a CLI command and an MCP orchestrate action, with identical behavior per #1109 MCP parity constraint.

**Design:**

**CLI surface:**
```bash
exarchos shepherd-auto [--feature-id <id>] [--pr <number>...] \
  [--max-iterations <n>] [--confidence <0.0-1.0>] [--max-parallel <n>]
```

The CLI command is implemented as a new command markdown file (`commands/shepherd-auto.md`) that invokes the MCP action. This follows the existing pattern where CLI commands are thin wrappers over MCP actions.

**MCP surface:**
```typescript
exarchos_orchestrate({
  action: "shepherd-auto",
  args: { featureId, prNumbers, maxAutonomousIterations, confidenceThreshold, maxParallelFixes }
})
```

The orchestrate handler lives at `servers/exarchos-mcp/src/orchestrate/shepherd-auto.ts`. It accepts typed args matching a Zod schema registered in `registry.ts`. Both facades route through this single handler.

**Acceptance criteria:**
- AC-6.1: CLI and MCP produce identical `ToolResult` output for the same inputs (parity test).
- AC-6.2: All configuration parameters are available on both surfaces.
- AC-6.3: The orchestrate handler has no CLI-specific or MCP-specific code paths.
- AC-6.4: Action is registered in `registry.ts` with full Zod schema.

---

## DR-SH-7: Extends Existing Infrastructure

**Requirement:** The autonomous shepherd builds on top of the existing shepherd view and skill rather than replacing them.

**Design:** Extensions to existing components:

1. **`shepherd-status-view.ts`** -- Add new event handlers for the autonomous event types. The `ShepherdStatusState` interface gains:
   ```typescript
   readonly autonomousIteration: number;
   readonly clusters: ReadonlyArray<{
     id: string;
     category: 'style' | 'bug' | 'architecture';
     status: 'pending' | 'dispatched' | 'applied' | 'reverted' | 'escalated';
   }>;
   ```
   The existing `overallStatus` computation gains a new `'auto-fixing'` value when autonomous fixes are in progress.

2. **`skills-src/shepherd/SKILL.md`** -- Add a section documenting the `shepherd-auto` command and its relationship to the existing shepherd loop. The skill does not change behavior; it gains documentation for the new path.

3. **`assess_stack`** -- No changes. The autonomous shepherd calls `assess_stack` for initial PR health assessment before classification, reusing the existing composite action.

**Acceptance criteria:**
- AC-7.1: Existing shepherd tests continue to pass without modification.
- AC-7.2: The sequential shepherd loop is unaffected when autonomous mode is not invoked.
- AC-7.3: `shepherd-status-view.ts` handles both old and new event types via the existing `apply` switch.

---

## DR-SH-8: Event Catalog

All events follow the existing event-sourcing conventions. Each event is appended via `exarchos_event({ action: "append" })` and is reconstructable from the event store (DIM-1 per #1109).

| Event Type | Emitted When | Data Schema |
|------------|-------------|-------------|
| `shepherd.auto.started` | Autonomous shepherd begins a run | `{ featureId, prNumbers, config: { maxIterations, confidenceThreshold, maxParallelFixes } }` |
| `shepherd.cluster.classified` | Classifier completes thread analysis | `{ featureId, pr, clusters: ClassifiedCluster[], classifierDurationMs }` |
| `shepherd.fix.dispatched` | Fix agent spawned for a cluster | `{ featureId, pr, clusterId, category, worktreePath, agentId }` |
| `shepherd.fix.applied` | Fix agent commit cherry-picked and tests pass | `{ featureId, pr, clusterId, commitSha, testsRun, testsPassed }` |
| `shepherd.fix.reverted` | Cherry-picked fix caused test regression | `{ featureId, pr, clusterId, revertCommitSha, failingTests: string[] }` |
| `shepherd.escalated` | Autonomous shepherd cannot proceed | `{ featureId, pr, reason, clusterStatuses, autonomousIteration }` |
| `shepherd.auto.completed` | All clusters resolved or escalated | `{ featureId, pr, outcome: 'all-applied' \| 'partial' \| 'escalated', appliedCount, revertedCount, escalatedCount }` |

Events integrate with the existing `ShepherdStatusView` projection via new cases in the `apply` switch statement. The `shepherd.auto.*` events are additive -- they do not replace the existing `shepherd.started`, `shepherd.iteration`, or `shepherd.completed` events, which continue to track the outer loop.

---

## DR-SH-9: #1109 Compliance Matrix

| Constraint | Requirement | How This Design Complies |
|------------|------------|--------------------------|
| Event-sourcing integrity | All state reconstructable from event store | Every state transition emits an event (DR-SH-8). Cluster statuses, revert decisions, and escalation triggers are fully captured. No out-of-band state mutations. The `shepherd-status-view.ts` projection rebuilds from events on startup. |
| MCP parity | Identical output from CLI and MCP | Single orchestrate handler (`shepherd-auto.ts`) with no facade-specific branches (DR-SH-6, AC-6.3). Parity test asserts identical `ToolResult` from both entry points. |
| Basileus-forward | Both facades first-class | CLI command is a thin markdown wrapper; MCP action is registered in `registry.ts`. Basileus can invoke `shepherd-auto` through either facade. No CLI-only features or MCP-only features. Agent dispatch uses the existing `exarchos:delegate` path which basileus already consumes. |

---

## Testing Strategy

Three test layers matching the project convention:

**Unit tests:** Classifier logic (thread-to-cluster mapping, confidence computation, category assignment). Cherry-pick/revert logic (baseline comparison, regression detection). Budget enforcement (iteration counting, threshold gating). Each in co-located `*.test.ts` files.

**Integration tests:** Full autonomous loop with mock `assess_stack` and mock subagent dispatch. Verifies event emission sequence, worktree lifecycle, and escalation triggers. Uses in-memory event store.

**Parity tests:** `shepherd-auto.parity.test.ts` invokes the handler through both CLI and MCP adapters, asserts byte-identical `ToolResult` JSON. Follows the pattern established by `doctor.parity.test.ts`.

---

## Risks and Mitigations

- **Risk:** Parallel worktrees exhaust disk space on large repos. **Mitigation:** `maxParallelFixes` defaults to 3; worktrees use shallow clones with `--no-checkout` + sparse checkout of affected files only.
- **Risk:** Cherry-pick conflicts between clusters that touch adjacent (but not overlapping) lines. **Mitigation:** Conflict at cherry-pick time triggers escalation for the conflicting cluster; remaining clusters proceed.
- **Risk:** Classifier miscategorizes a bug as style, leading to an inadequate fix. **Mitigation:** Confidence threshold gates dispatch; post-fix test regression auto-reverts bad fixes; escalation captures the failure for human review.
- **Risk:** Test suite is slow, making sequential post-cherry-pick verification expensive. **Mitigation:** Run only tests in files affected by the cluster's changes (test file discovery via co-location convention). Full suite runs once at the end.

---

## Migration Path

1. **v2.8.5:** Ship classifier subagent and `shepherd-auto` orchestrate handler with `maxAutonomousIterations: 1` default (single pass, conservative). Event catalog lands. View extensions land.
2. **v2.9.0:** Increase default to `maxAutonomousIterations: 3`. Add worktree-based parallel dispatch. Add auto-revert.
3. **v3.0:** Full integration with basileus remote dispatch. Confidence threshold tuning based on telemetry from v2.8.5-v2.9.0 usage.
