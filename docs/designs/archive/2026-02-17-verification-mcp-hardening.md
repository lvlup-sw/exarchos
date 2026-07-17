# Design: Verification Infrastructure + MCP Hardening Bundle

## Problem Statement

The prioritization plan identified a clear execution sequence for exarchos's open issues. Tier 1 priority #368 (event cleanup) is complete and #344 (benchmark gate) has all deliverables merged. The next highest-leverage work is:

1. **Complete the PBT verification chain** (#341, #342, #343) — three small issues that finish the property-based testing vertical in the #339 verification infrastructure tracker
2. **Unblock the critical path** (#345 CodeQualityView) — the critical junction gating #346 (verification flywheel) and the entire productization pipeline
3. **Harden the MCP server** (#408 P0+P1) — fix data corruption risks before building more on the event store

This bundle closes/resolves 6 issues and advances both the verification infrastructure and MCP server reliability.

## Chosen Approach

Three parallel streams with a single sequential dependency (#341 → #342):

```
Stream A (PBT):    #341 ──→ #342    (sequential: #342 needs testingStrategy field)
                   #343              (parallel with #341, standalone)

Stream B (Views):  #345              (parallel with all, no deps — #344 deliverables shipped)

Stream C (MCP):    #408 P0+P1       (parallel with all, independent subsystem)

Housekeeping:      Close #344       (all ACs met except trivial label criterion)
```

**Rationale:** Maximum parallelism across independent subsystems. Stream A is content-layer (schemas + markdown). Stream B is MCP server views. Stream C is MCP server event store. No cross-stream dependencies.

## Technical Design

### Stream A: PBT Verification Chain

#### A1: testingStrategy Schema Field (#341)

**Location:** `plugins/exarchos/servers/exarchos-mcp/src/workflow/schemas.ts`

Extend `TaskSchema` with a `testingStrategy` field:

```typescript
const PerformanceSLASchema = z.object({
  metric: z.string(),
  threshold: z.number(),
  unit: z.enum(['ms', 'ops/s', 'MB']),
});

const TestingStrategySchema = z.object({
  exampleTests: z.literal(true),
  propertyTests: z.boolean(),
  benchmarks: z.boolean(),
  properties: z.array(z.string()).optional(),
  performanceSLAs: z.array(PerformanceSLASchema).optional(),
});

// Add to TaskSchema
export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: TaskStatusSchema,
  branch: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  testingStrategy: TestingStrategySchema.optional(),
});
```

The field is optional for backward compatibility — existing tasks without `testingStrategy` remain valid.

**Skill update:** The `/plan` skill (`skills/implementation-planning/SKILL.md`) needs guidance on when to set `propertyTests: true` based on task categories: data transformations, state machines, collections, concurrency, serialization. Reference the design doc table at `docs/designs/2026-02-15-autonomous-code-verification.md#when-to-require-property-based-tests`.

#### A2: check-property-tests.sh (#343)

**Location:** `scripts/check-property-tests.sh` + `scripts/check-property-tests.test.sh`

Follows established validation script conventions. Core logic:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Parse plan JSON for tasks with testingStrategy.propertyTests: true
# Scan worktree for PBT patterns:
#   TypeScript: fc.property, fc.assert, it.prop, test.prop
#   .NET: Prop.ForAll, FsCheck, [Property]
# Cross-reference: every required task has >= 1 property test file
# Exit 0=pass, 1=fail, 2=usage
```

**Detection patterns:**
- TypeScript (fast-check): `fc\.property`, `fc\.assert`, `it\.prop`, `test\.prop`, `from 'fast-check'`
- .NET (FsCheck): `Prop\.ForAll`, `using FsCheck`, `\[Property\]`

The script accepts `--plan-file` and `--worktree-dir` arguments. It extracts task IDs with `propertyTests: true` from the plan, then greps the worktree for PBT patterns, mapping test files to tasks via directory structure or naming conventions.

#### A3: PBT Spawn Prompt Enrichment (#342)

**Location:** `skills/delegation/references/implementer-prompt.md`

Add a conditional `## Property-Based Testing Patterns` section after the existing TDD Requirements section. Injected by the `/delegate` skill when the task's `testingStrategy.propertyTests` is `true`.

**Section content:**
- Pattern catalog: roundtrip, invariant, idempotence, commutativity
- Framework-specific examples (fast-check for TypeScript, FsCheck for .NET)
- Integration with existing TDD workflow (property tests in RED phase)

**Conditional injection model:** The delegation skill already has a conditional section pattern (Schema Sync). Follow the same approach — the orchestrator includes or omits the PBT section based on the task's `testingStrategy` field.

### Stream B: CodeQualityView CQRS Projection (#345)

**Location:** `plugins/exarchos/servers/exarchos-mcp/src/views/`

#### New Files
- `code-quality-view.ts` — Projection + interface definitions
- `code-quality-view.test.ts` — Co-located tests

#### Interface Design

```typescript
interface SkillQualityMetrics {
  skill: string;
  totalExecutions: number;
  gatePassRate: number;
  selfCorrectionRate: number;
  avgRemediationAttempts: number;
  topFailureCategories: Array<{ category: string; count: number }>;
}

interface GateMetrics {
  gate: string;
  executionCount: number;
  passRate: number;
  avgDuration: number;
  failureReasons: Array<{ reason: string; count: number }>;
}

interface BenchmarkTrend {
  operation: string;
  metric: string;
  values: Array<{ value: number; commit: string; timestamp: string }>;
  trend: 'improving' | 'stable' | 'degrading';
}

interface QualityRegression {
  skill: string;
  gate: string;
  consecutiveFailures: number;
  firstFailureCommit: string;
  lastFailureCommit: string;
  detectedAt: string;
}

interface CodeQualityViewState {
  skills: Record<string, SkillQualityMetrics>;
  gates: Record<string, GateMetrics>;
  regressions: QualityRegression[];
  benchmarks: BenchmarkTrend[];
}
```

#### Materializer Pattern

Follow the existing `ViewProjection<T>` pattern from `materializer.ts`:

```typescript
export const codeQualityProjection: ViewProjection<CodeQualityViewState> = {
  init: () => ({ skills: {}, gates: {}, regressions: [], benchmarks: [] }),
  apply: (view, event) => {
    switch (event.type) {
      case 'gate.executed': // update gate metrics + skill metrics
      case 'gate.self-corrected': // increment self-correction rate
      case 'task.completed': // finalize task quality data
      case 'benchmark.completed': // append to benchmark trends
      default: return view;
    }
  },
};
```

#### Registry Integration

Add `code_quality` action to the `exarchos_view` composite tool:

```typescript
{
  name: 'code_quality',
  description: 'Quality metrics across skills, gates, and benchmarks',
  schema: z.object({
    workflowId: z.string().optional(),
    skill: z.string().optional(),
    gate: z.string().optional(),
    limit: z.number().optional(),
  }),
  phases: ALL_PHASES,
  roles: ROLE_ANY,
}
```

#### New Event Type

Add `QualityRegression` to the event store schema (`event-store/schemas.ts`):

```typescript
export const QualityRegressionData = z.object({
  skill: z.string(),
  gate: z.string(),
  consecutiveFailures: z.number(),
  firstFailureCommit: z.string(),
  lastFailureCommit: z.string(),
});
```

Register in the `EventTypeSchema` enum and `EventDataSchemas` map.

### Stream C: MCP Server Hardening (#408 P0+P1)

**Location:** `plugins/exarchos/servers/exarchos-mcp/src/`

#### C1: PID Lock Enforcement (P0)

**File:** `event-store/store.ts`

Add a PID lock file at EventStore creation to enforce the documented single-instance assumption:

```typescript
private async acquirePidLock(): Promise<void> {
  const lockPath = path.join(this.stateDir, '.event-store.lock');
  const pid = process.pid.toString();
  try {
    // O_CREAT | O_EXCL — atomic create-if-not-exists
    const fd = await fs.open(lockPath, 'wx');
    await fd.writeFile(pid);
    await fd.close();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Check if PID is still alive
      const existingPid = parseInt(await fs.readFile(lockPath, 'utf-8'), 10);
      if (isPidAlive(existingPid)) {
        throw new Error(`EventStore locked by PID ${existingPid}`);
      }
      // Stale lock — reclaim
      await fs.writeFile(lockPath, pid);
    } else {
      throw err;
    }
  }
  // Cleanup on exit
  process.on('exit', () => { try { fs.unlinkSync(lockPath); } catch {} });
}
```

Called during `EventStore` construction (or a new `initialize()` method).

#### C2: Sequence Invariant Validation (P0)

**File:** `event-store/store.ts`, `initializeSequence()` method

Add validation that verifies line N = sequence N during cold-start initialization:

```typescript
// During initializeSequence(), sample-validate the invariant
// Check first, last, and a random middle line
const lines = content.split('\n').filter(l => l.trim());
for (const [idx, line] of [[0, lines[0]], [lines.length - 1, lines[lines.length - 1]]]) {
  const event = JSON.parse(line as string);
  if (event.sequence !== (idx as number) + 1) {
    throw new Error(
      `Sequence invariant violated: line ${(idx as number) + 1} has sequence ${event.sequence}`
    );
  }
}
```

This catches compaction or manual editing that would break the fast-skip optimization.

#### C3: CAS Diagnostic Event (P1)

**File:** `workflow/tools.ts`

On CAS retry exhaustion, emit a `workflow.cas-failed` diagnostic event before throwing:

```typescript
if (retries >= MAX_CAS_RETRIES) {
  await eventStore.append(stream, {
    type: 'workflow.cas-failed',
    data: { featureId, phase, retries: MAX_CAS_RETRIES },
  });
  throw new Error(`CAS exhausted after ${MAX_CAS_RETRIES} retries`);
}
```

Add `workflow.cas-failed` to the event type schema.

#### C4: Configurable LRU Cache (P1)

**File:** `views/materializer.ts`

Make `maxCacheEntries` configurable via environment variable:

```typescript
const DEFAULT_MAX_CACHE = 100;
const maxCacheEntries = parseInt(
  process.env.EXARCHOS_MAX_CACHE_ENTRIES ?? String(DEFAULT_MAX_CACHE),
  10,
);
```

#### C5: Configurable Idempotency Cache (P1)

**File:** `event-store/store.ts`

Increase default from 100 to 200 and make configurable:

```typescript
const MAX_IDEMPOTENCY_KEYS = parseInt(
  process.env.EXARCHOS_MAX_IDEMPOTENCY_KEYS ?? '200',
  10,
);
```

#### C6: Task Claim Exponential Backoff (P1)

**File:** `tasks/tools.ts`

Replace fixed retry with exponential backoff:

```typescript
const baseDelay = 50; // ms
for (let attempt = 0; attempt < maxRetries; attempt++) {
  try {
    return await attemptClaim(taskId, agentId);
  } catch (err) {
    if (attempt === maxRetries - 1) throw err;
    const delay = baseDelay * Math.pow(2, attempt) + Math.random() * baseDelay;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}
```

## Integration Points

| Stream | Touches | Shared With |
|--------|---------|-------------|
| A1 (#341) | `workflow/schemas.ts`, planning skill | A3 (schema consumed by delegation) |
| A2 (#343) | `scripts/` only | None (standalone) |
| A3 (#342) | `skills/delegation/references/` | A1 (requires testingStrategy field) |
| B (#345) | `views/`, `event-store/schemas.ts`, `registry.ts` | C3 (new event type in same schema file) |
| C1-C6 (#408) | `event-store/store.ts`, `views/materializer.ts`, `tasks/tools.ts`, `workflow/tools.ts` | B (new event type) |

**Cross-stream coordination:** Streams B and C both add event types to `event-store/schemas.ts`. If dispatched to separate worktrees, the second to merge will need a trivial rebase to resolve the schema file.

## Testing Strategy

| Component | Test Type | Location |
|-----------|-----------|----------|
| A1: testingStrategy schema | Unit (Zod validation) | `workflow/schemas.test.ts` |
| A2: check-property-tests.sh | Integration (bash) | `scripts/check-property-tests.test.sh` |
| A3: PBT prompt enrichment | Content verification | Skill validation test |
| B: CodeQualityView | Unit (projection + materialization) | `views/code-quality-view.test.ts` |
| C1: PID lock | Unit (lock acquisition, stale reclaim) | `event-store/store.test.ts` |
| C2: Sequence validation | Unit (invariant check) | `event-store/store.test.ts` |
| C3: CAS diagnostic | Unit (event emission on exhaustion) | `workflow/tools.test.ts` |
| C4-C6: Config + backoff | Unit (env var parsing, retry timing) | Respective `.test.ts` files |

## Dispatch Strategy

**Parallel streams mapped to worktrees:**

| Worktree | Issues | Type | Effort |
|----------|--------|------|--------|
| `pbt-verification` | #341, #343, #342 | Sequential chain (A1 → A3, A2 parallel) | Low |
| `code-quality-view` | #345 | Single issue, medium complexity | Medium |
| `mcp-hardening` | #408 (P0+P1 only) | 6 discrete fixes | Medium |

Three worktrees, three agents, maximum parallelism. Each worktree is self-contained with no cross-worktree dependencies during development. Schema conflicts in `event-store/schemas.ts` resolved at synthesis time.

## Open Questions

1. **#344 closure:** Should we close #344 now (all deliverables merged) or leave it open for the trivial `has-benchmarks` label AC?
2. **#408 P2 scope:** P2 items (cold-start benchmarks, snapshot cleanup, configurable snapshot interval) are excluded from this bundle. Defer to a future cycle?
3. **Event type naming:** `QualityRegression` vs `quality.regression` — the existing convention uses dot-notation (`workflow.transition`, `benchmark.completed`). Use `quality.regression` and `workflow.cas-failed` for consistency.

## Issues Addressed

| Issue | Title | Stream |
|-------|-------|--------|
| [#341](https://github.com/lvlup-sw/exarchos/issues/341) | testingStrategy field | A |
| [#342](https://github.com/lvlup-sw/exarchos/issues/342) | PBT spawn prompt enrichment | A |
| [#343](https://github.com/lvlup-sw/exarchos/issues/343) | check-property-tests.sh | A |
| [#344](https://github.com/lvlup-sw/exarchos/issues/344) | Benchmark regression gate (close) | Housekeeping |
| [#345](https://github.com/lvlup-sw/exarchos/issues/345) | CodeQualityView CQRS projection | B |
| [#408](https://github.com/lvlup-sw/exarchos/issues/408) | MCP server hardening (P0+P1) | C |
