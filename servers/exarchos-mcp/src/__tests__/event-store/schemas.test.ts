import { describe, it, expect } from 'vitest';
import {
  WorkflowEventBase,
  WorkflowStartedData,
  TaskAssignedData,
  TaskClaimedData,
  TaskProgressedData,
  TaskCompletedData,
  TaskFailedData,
  GateExecutedData,
  StackPositionFilledData,
  StackRestackedData,
  StackEnqueuedData,
  WorkflowTransitionData,
  WorkflowFixCycleData,
  WorkflowGuardFailedData,
  WorkflowCheckpointData,
  WorkflowCompoundEntryData,
  WorkflowCompoundExitData,
  WorkflowCancelData,
  WorkflowCompensationData,
  WorkflowCircuitOpenData,
  BenchmarkCompletedData,
  EventTypes,
  PhaseBlockedKindSchema,
  PhaseEnteredResolverSchema,
  ResolvedGateFamilySchema,
  PhaseEnteredPostureSchema,
  type EventType,
} from '../../event-store/schemas.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum } from '../../workflow/schemas.js';
import { KIND_OBLIGATIONS, resolveGateSet, type PhaseKind } from '../../workflow/phase-kind.js';

// ─── Base Event Schema ──────────────────────────────────────────────────────

describe('WorkflowEventBase', () => {
  it('should parse a valid base event with all fields', () => {
    const event = {
      streamId: 'my-workflow',
      sequence: 1,
      timestamp: '2025-01-15T10:00:00.000Z',
      type: 'workflow.started',
      correlationId: 'corr-123',
      causationId: 'cause-456',
      agentId: 'agent-1',
      agentRole: 'orchestrator',
      source: 'exarchos',
      schemaVersion: '1.0',
      data: { featureId: 'my-feature' },
    };

    const parsed = WorkflowEventBase.parse(event);
    expect(parsed.streamId).toBe('my-workflow');
    expect(parsed.sequence).toBe(1);
    expect(parsed.type).toBe('workflow.started');
    expect(parsed.correlationId).toBe('corr-123');
    expect(parsed.causationId).toBe('cause-456');
    expect(parsed.agentId).toBe('agent-1');
    expect(parsed.agentRole).toBe('orchestrator');
    expect(parsed.source).toBe('exarchos');
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.data).toEqual({ featureId: 'my-feature' });
  });

  it('should reject event missing required fields', () => {
    // Missing streamId
    expect(() => WorkflowEventBase.parse({ sequence: 1, type: 'test' })).toThrow();
    // Missing sequence
    expect(() => WorkflowEventBase.parse({ streamId: 'x', type: 'test' })).toThrow();
    // Missing type
    expect(() => WorkflowEventBase.parse({ streamId: 'x', sequence: 1 })).toThrow();
  });

  it('should reject empty streamId', () => {
    expect(() =>
      WorkflowEventBase.parse({ streamId: '', sequence: 1, type: 'test' }),
    ).toThrow();
  });

  it('should reject non-positive sequence', () => {
    expect(() =>
      WorkflowEventBase.parse({ streamId: 'x', sequence: 0, type: 'test' }),
    ).toThrow();
    expect(() =>
      WorkflowEventBase.parse({ streamId: 'x', sequence: -1, type: 'test' }),
    ).toThrow();
  });

  it('should default schemaVersion to 1.0', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.started',
    });
    expect(event.schemaVersion).toBe('1.0');
  });

  it('should set default timestamp when not provided', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.started',
    });
    expect(event.timestamp).toBeDefined();
    // Should be a valid ISO datetime
    expect(() => new Date(event.timestamp)).not.toThrow();
  });

  it('should accept event with only required fields', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.started',
    });
    expect(event.correlationId).toBeUndefined();
    expect(event.causationId).toBeUndefined();
    expect(event.agentId).toBeUndefined();
    expect(event.agentRole).toBeUndefined();
    expect(event.source).toBeUndefined();
  });
});

// ─── Workflow-Level Events ──────────────────────────────────────────────────

describe('WorkflowStartedData', () => {
  it('should parse valid WorkflowStarted data', () => {
    const data = WorkflowStartedData.parse({
      featureId: 'my-feature',
      workflowType: 'feature',
      designPath: 'docs/designs/my-feature.md',
    });
    expect(data.featureId).toBe('my-feature');
    expect(data.workflowType).toBe('feature');
    expect(data.designPath).toBe('docs/designs/my-feature.md');
  });

  it('should accept all workflow types', () => {
    for (const wfType of ['feature', 'debug', 'refactor']) {
      const data = WorkflowStartedData.parse({
        featureId: 'test',
        workflowType: wfType,
      });
      expect(data.workflowType).toBe(wfType);
    }
  });

  it('should reject empty workflow type', () => {
    expect(() =>
      WorkflowStartedData.parse({
        featureId: 'test',
        workflowType: '',
      }),
    ).toThrow();
  });

  it('should reject unregistered workflow type', () => {
    expect(() =>
      WorkflowStartedData.parse({
        featureId: 'test',
        workflowType: 'unregistered-type',
      }),
    ).toThrow();
  });

  it('should accept registered custom workflow type', () => {
    extendWorkflowTypeEnum('deploy');
    try {
      const data = WorkflowStartedData.parse({
        featureId: 'test',
        workflowType: 'deploy',
      });
      expect(data.workflowType).toBe('deploy');
    } finally {
      unextendWorkflowTypeEnum('deploy');
    }
  });

  it('should allow optional designPath', () => {
    const data = WorkflowStartedData.parse({
      featureId: 'test',
      workflowType: 'debug',
    });
    expect(data.designPath).toBeUndefined();
  });
});

describe('TaskAssignedData', () => {
  it('should parse valid task assignment with worktree', () => {
    const data = TaskAssignedData.parse({
      taskId: 'task-001',
      title: 'Implement event store',
      branch: 'feat/event-store',
      worktree: '.worktrees/event-store',
      assignee: 'coder-agent',
    });
    expect(data.taskId).toBe('task-001');
    expect(data.title).toBe('Implement event store');
    expect(data.branch).toBe('feat/event-store');
    expect(data.worktree).toBe('.worktrees/event-store');
    expect(data.assignee).toBe('coder-agent');
  });

  it('should allow all optional fields', () => {
    const data = TaskAssignedData.parse({
      taskId: 'task-001',
      title: 'A task',
    });
    expect(data.branch).toBeUndefined();
    expect(data.worktree).toBeUndefined();
    expect(data.assignee).toBeUndefined();
  });
});

// ─── Task-Level Events (A02) ────────────────────────────────────────────────

describe('TaskClaimedData', () => {
  it('should parse valid task claim', () => {
    const data = TaskClaimedData.parse({
      taskId: 'task-001',
      agentId: 'coder-1',
      claimedAt: '2025-01-15T10:00:00.000Z',
    });
    expect(data.taskId).toBe('task-001');
    expect(data.agentId).toBe('coder-1');
    expect(data.claimedAt).toBe('2025-01-15T10:00:00.000Z');
  });

  it('should require all fields', () => {
    expect(() => TaskClaimedData.parse({ taskId: 'task-001' })).toThrow();
    expect(() => TaskClaimedData.parse({ agentId: 'coder-1' })).toThrow();
  });
});

describe('TaskProgressedData', () => {
  it('should parse valid task progress with TDD phase', () => {
    const data = TaskProgressedData.parse({
      taskId: 'task-001',
      tddPhase: 'red',
      detail: 'Writing failing test for event store',
    });
    expect(data.taskId).toBe('task-001');
    expect(data.tddPhase).toBe('red');
    expect(data.detail).toBe('Writing failing test for event store');
  });

  it('should accept all TDD phases', () => {
    for (const phase of ['red', 'green', 'refactor']) {
      const data = TaskProgressedData.parse({
        taskId: 'task-001',
        tddPhase: phase,
      });
      expect(data.tddPhase).toBe(phase);
    }
  });

  it('should reject invalid TDD phase', () => {
    expect(() =>
      TaskProgressedData.parse({ taskId: 'task-001', tddPhase: 'invalid' }),
    ).toThrow();
  });

  it('should allow optional detail', () => {
    const data = TaskProgressedData.parse({
      taskId: 'task-001',
      tddPhase: 'green',
    });
    expect(data.detail).toBeUndefined();
  });
});

describe('TaskCompletedData', () => {
  it('should parse valid task completion with artifacts', () => {
    const data = TaskCompletedData.parse({
      taskId: 'task-001',
      artifacts: ['src/event-store/schemas.ts', 'src/__tests__/event-store/schemas.test.ts'],
      duration: 3600,
    });
    expect(data.taskId).toBe('task-001');
    expect(data.artifacts).toHaveLength(2);
    expect(data.duration).toBe(3600);
  });

  it('should allow optional fields', () => {
    const data = TaskCompletedData.parse({
      taskId: 'task-001',
    });
    expect(data.artifacts).toBeUndefined();
    expect(data.duration).toBeUndefined();
  });

  it('TaskCompletedData_WithProvenance_ParsesSuccessfully', () => {
    const data = {
      taskId: 'T-3',
      implements: ['DR-1', 'DR-2'],
      tests: [{ name: 'Reset_Valid_Resets', file: 'src/reset.test.ts' }],
      files: ['src/reset.ts'],
    };
    expect(TaskCompletedData.parse(data)).toMatchObject(data);
  });

  it('TaskCompletedData_WithoutProvenance_StillParsesSuccessfully', () => {
    const data = { taskId: 'T-1' };
    expect(TaskCompletedData.parse(data)).toMatchObject({ taskId: 'T-1' });
  });

  it('TaskCompletedData_PartialProvenance_ParsesSuccessfully', () => {
    const data = { taskId: 'T-2', implements: ['DR-1'] };
    expect(TaskCompletedData.parse(data)).toMatchObject(data);
  });
});

describe('TaskFailedData', () => {
  it('should parse valid task failure', () => {
    const data = TaskFailedData.parse({
      taskId: 'task-001',
      error: 'Build failed: type error in schemas.ts',
      diagnostics: { exitCode: 1, stderr: 'TS2322' },
    });
    expect(data.taskId).toBe('task-001');
    expect(data.error).toBe('Build failed: type error in schemas.ts');
    expect(data.diagnostics).toEqual({ exitCode: 1, stderr: 'TS2322' });
  });

  it('should allow optional diagnostics', () => {
    const data = TaskFailedData.parse({
      taskId: 'task-001',
      error: 'Unknown error',
    });
    expect(data.diagnostics).toBeUndefined();
  });
});

// ─── Quality Gate Events (A03) ──────────────────────────────────────────────

describe('GateExecutedData', () => {
  it('should parse valid gate execution', () => {
    const data = GateExecutedData.parse({
      gateName: 'build',
      layer: 'ci',
      passed: true,
      duration: 12.5,
      details: { exitCode: 0 },
    });
    expect(data.gateName).toBe('build');
    expect(data.layer).toBe('ci');
    expect(data.passed).toBe(true);
    expect(data.duration).toBe(12.5);
    expect(data.details).toEqual({ exitCode: 0 });
  });

  it('should allow optional fields', () => {
    const data = GateExecutedData.parse({
      gateName: 'lint',
      layer: 'local',
      passed: false,
    });
    expect(data.duration).toBeUndefined();
    expect(data.details).toBeUndefined();
  });
});

// ─── Stack Events (A03) ─────────────────────────────────────────────────────

describe('StackPositionFilledData', () => {
  it('should parse valid stack position', () => {
    const data = StackPositionFilledData.parse({
      position: 1,
      taskId: 'task-001',
      branch: 'feat/event-store',
      prUrl: 'https://github.com/org/repo/pull/42',
    });
    expect(data.position).toBe(1);
    expect(data.taskId).toBe('task-001');
    expect(data.branch).toBe('feat/event-store');
    expect(data.prUrl).toBe('https://github.com/org/repo/pull/42');
  });

  it('should allow optional fields', () => {
    const data = StackPositionFilledData.parse({
      position: 1,
      taskId: 'task-001',
    });
    expect(data.branch).toBeUndefined();
    expect(data.prUrl).toBeUndefined();
  });
});

describe('StackRestackedData', () => {
  it('should parse valid restack event', () => {
    const data = StackRestackedData.parse({
      branches: ['feat/task-001', 'feat/task-002'],
      conflicts: false,
      reconstructed: true,
    });
    expect(data.branches).toEqual(['feat/task-001', 'feat/task-002']);
    expect(data.conflicts).toBe(false);
    expect(data.reconstructed).toBe(true);
  });
});

describe('StackEnqueuedData', () => {
  it('should parse valid enqueue event', () => {
    const data = StackEnqueuedData.parse({
      prNumbers: [42, 43, 44],
    });
    expect(data.prNumbers).toEqual([42, 43, 44]);
  });
});

// ─── EventTypes Discriminated Union (A03) ───────────────────────────────────

describe('EventTypes', () => {
  it('EventTypes_CountMatchesRegisteredTypes', () => {
    // Locked to the current registered-type count. Bumped to 93 with the
    // Bumped from 93 → 103 with Wave B (#1342) 5×{requested,executed} two-event
    // split schemas for non-idempotent VCS handlers (B1–B5):
    //   pr.create.requested, pr.create.executed,
    //   pr.comment.requested, pr.comment.executed,
    //   issue.create.requested, issue.create.executed,
    //   branch.delete.requested, branch.delete.executed,
    //   worktree.remove.requested, worktree.remove.executed.
    // Previous (93): merge.requested (Wave 2B.2 / #1304 — audit §F1.2 two-event
    // split: durable INTENT recorded before the non-idempotent GitHub merge
    // call). Previous (92) added migration.workflow_type_unknown (Wave 1,
    // R-1 Marten primitive #1313). Previous (91) added
    // session.machinery_consumed (T-11, rehydration-machinery-refactor).
    // Previous bump (90) was six durable event-store substrate event types
    // (#1259 T02 / T03 / T04): hsm.deprecated_action_invoked,
    // spec.legacy_capabilities_array, phase.contract_missing,
    // migration.legacy_jsonl_imported, migration.completed, migration.failed.
    // Previous bump (84) was command.resolved (#1199 T15) for the
    // test/typecheck/install runtime resolver. Earlier (83) was
    // merge.preflight / merge.executed / merge.rollback (T03, DR-MO-2). When
    // new event types are added, bump this number alongside their registration
    // in `event-store/schemas.ts`.
    // PR3/T7 (#1364): bumped 103 → 104 to include `tool.action_errored`,
    // which splits structured action-level failures off of `tool.errored`
    // (transport/protocol failures only).
    // #1262: bumped 104 → 105 to include `turn.completed`, which carries
    // the per-turn output-token sample the `output_tokens_high` quality
    // hint fires on (see `telemetry/quality-hints.ts`).
    // #1290: bumped 105 → 106 to include `workspace.resolved`, emitted
    // by `workspace/discovery.ts` on roots-based or cwd-walk featureId
    // inference at the dispatch boundary.
    // #1274: bumped 106 → 108 to include `elicitation.requested` +
    // `elicitation.fulfilled`, emitted by the dispatch elicitation
    // hand-off on the per-operation pseudo-stream
    // `elicitation/<operationId>`.
    // #1424: bumped 108 → 109 to include `elicitation.declined`, emitted
    // when the client returns `value === undefined` (decline/cancel) so
    // the audit trail distinguishes refusal from fulfillment.
    // #1272: bumped 109 → 113 to include `task.created` + `task.polled` +
    // `task.result` + `task.cancelled`, emitted by the
    // EventSourcedTaskStore (SDK `TaskStore` interface as a projection
    // over the event store; see
    // `src/task-store/event-sourced-task-store.ts`).
    // #1261: bumped 113 → 115 to include `dispatch.preflight` +
    // `stash.detected`, emitted by `orchestrate/dispatch-guard.ts`.
    // #1437: bumped 115 → 116 to include `migration.correlation_backfill_progress`,
    // emitted per-chunk by `sqlite-backend.ts:migrateV5ToV6` during the
    // V5→V6 correlation-column backfill (Wave 2 of correlation-indexed-columns).
    // invariants-catalog-wizard P2: bumped 116 → 118 to include
    // `invariant.authored` + `catalog.registered`, emitted by the
    // `invariants_add` composite handler (orchestrate/invariants/add.ts).
    // #1304 INV-10 alignment: bumped 118 → 119 to include `merge.completed`,
    // the terminal lifecycle marker emitted by `handleExecuteMerge` adjacent
    // to `merge.executed`. Folded by `merge-orchestrator@v1` as the
    // transition into the `completed` terminal phase.
    // #1510 DR-7 (task 008): bumped 119 → 121 to include `onboard.requested` +
    // `onboard.executed`, the two-event onboard contract (INV-1 / INV-13)
    // emitted by the `onboard` composite.
    // #1510 DR-5 (task 018): bumped 121 → 120 — `init.executed` was retired
    // alongside the init verb/handler. `onboard.*` is the audit trail now.
    // verification-ladder slice 1 (task 020): bumped 120 → 122 to include the
    // mutation-run liveness pair `mutation.executing_started` +
    // `mutation.executed`, emitted by the `exarchos run-mutation` CLI verb.
    // phase-kind binding DR-7 (task 007): bumped 122 → 123 to include
    // `phase.blocked`, the fail-closed marker appended when the IMPLEMENT
    // gate-set resolver throws at a phase boundary (orchestrate/prepare-delegation.ts).
    // phase-kind binding DR-13 (task 012): bumped 123 → 125 to include
    // `phase.entered` + `phase.exited`, the resolve-then-freeze pair appended at
    // the executeTransition boundary (workflow/state-machine.ts).
    // #1525 W2 Half 1 (task H1-C): bumped 125 → 126 to include
    // `subagent.tokens_used`, the per-subagent output-token total emitted by the
    // restored SubagentStop hook (cli-commands/subagent-stop.ts).
    // #1306: bumped 126 → 127 to include `merge.recovered` (successor to
    // `merge.rollback`, dual-emitted during the v2.11.x deprecation window).
    // #1308 T8: bumped 127 → 128 to include `merge.retry_attempt` (bounded
    // timeout-retry telemetry; registration-only, emission lands in later #1308 tasks).
    // #1309 T12: bumped 128 → 129 to include `merge.executing_started` (the
    // merge-executor liveness event, emitted after the recovery point is recorded
    // and before the first vcsMerge — INV-10 executing_started + paired terminal).
    // DR-3 #1595: bumped 129 → 130 to include `shepherd.escalated` (structured
    // bound-hit escalation emitted by assess-stack — a structured terminal, NOT a
    // hang, surfaced via shepherd_status/ps, INV-10).
    // #1319: bumped 130 → 131 to include `feedback.recorded`, the agent→runtime
    // friction back-channel emitted by `exarchos_workflow.feedback` onto the
    // shared `meta/feedback` stream (read back by `/exarchos:dogfood`).
    // #1242: bumped 131 → 132 to include `workflow.handoff_summarized`, the
    // auto-summarized handoff fallback folded by the rehydration reducer with
    // operator-precedence (operator checkpoint handoff always wins the slot).
    // WLM foundation: bumped 132 → 136 to include the worktree lifecycle
    // (lease/ownership) family — `worktree.adopted` / `worktree.reserved` /
    // `worktree.released` / `worktree.orphan_detected`. The GC half reuses the
    // existing `worktree.remove.*` pair (no `worktree.pruned` / `worktree.merge_*`).
    // DR-1: bumped 136 → 137 to include `workflow.plan-revision`, the counted
    // plan-review revise cycle (plan-review analog of `workflow.fix-cycle`,
    // folded into `state.planReview.revisionCount`).
    expect(EventTypes).toHaveLength(137);
    expect(EventTypes).toContain('merge.recovered');
    expect(EventTypes).toContain('merge.retry_attempt');
    expect(EventTypes).toContain('merge.executing_started');
    expect(EventTypes).toContain('subagent.tokens_used');
    // Explicit membership pin: a future replacement that swaps one event
    // for another would keep the length stable but silently lose the
    // migration progress type. The membership assert catches that.
    expect(EventTypes).toContain('migration.correlation_backfill_progress');
    expect(EventTypes).toContain('invariant.authored');
    expect(EventTypes).toContain('catalog.registered');
    expect(EventTypes).toContain('merge.completed');
    expect(EventTypes).toContain('onboard.requested');
    expect(EventTypes).toContain('onboard.executed');
    expect(EventTypes).toContain('mutation.executing_started');
    expect(EventTypes).toContain('mutation.executed');
    expect(EventTypes).toContain('phase.blocked');
    expect(EventTypes).toContain('phase.entered');
    expect(EventTypes).toContain('phase.exited');
    expect(EventTypes).toContain('worktree.adopted');
    expect(EventTypes).toContain('worktree.reserved');
    expect(EventTypes).toContain('worktree.released');
    expect(EventTypes).toContain('worktree.orphan_detected');
    expect(EventTypes).toContain('workflow.plan-revision');
    // Retirement guard: init.executed removed in DR-5 (task 018).
    expect(EventTypes as readonly string[]).not.toContain('init.executed');
  });

  it('PhaseEnteredResolver_MatchesKindObligationResolvers', () => {
    // Drift guard: `phase.entered.resolver` is an inlined z.enum in
    // event-store/schemas.ts (kept free of a workflow/config import). Pin it to
    // the resolver names actually referenced by `KIND_OBLIGATIONS` — adding a
    // kind→resolver binding without updating the event schema turns this red.
    const resolversInUse = Array.from(
      new Set(
        Object.values(KIND_OBLIGATIONS)
          .map((o) => o.gates?.resolver)
          .filter((r): r is NonNullable<typeof r> => typeof r === 'string'),
      ),
    ).sort();
    expect([...PhaseEnteredResolverSchema.options].sort()).toEqual(resolversInUse);
  });

  it('ResolvedGateFamily_MatchesResolverOutput', () => {
    // Drift guard: `phase.entered.resolvedGates[].family` is an inlined z.enum
    // in event-store/schemas.ts. Pin it to the families the resolvers actually
    // emit — collected by running `resolveGateSet` for every kind — so a new
    // ResolvedGate family that lands on the event log without a schema update
    // turns this red. (feature/high yields the review family; the other three
    // families come from IMPLEMENT/PLAN/SYNTHESIZE.)
    const ctx = { riskTier: 'high', boundaryTouching: true, workflowType: 'feature' } as const;
    const familiesEmitted = new Set<string>();
    for (const kind of Object.keys(KIND_OBLIGATIONS) as PhaseKind[]) {
      for (const g of resolveGateSet(kind, ctx)) {
        familiesEmitted.add(g.family);
      }
    }
    expect([...ResolvedGateFamilySchema.options].sort()).toEqual([...familiesEmitted].sort());
  });

  it('PhaseEnteredPosture_MatchesKindObligationPostures', () => {
    // Drift guard (DR-14): `phase.entered.posture` is an inlined z.enum in
    // event-store/schemas.ts (kept free of an agents/spec import). Pin it to the
    // postures actually declared by `KIND_OBLIGATIONS` so adding a kind with a
    // new posture without updating the event schema turns this red.
    const posturesInUse = Array.from(
      new Set(Object.values(KIND_OBLIGATIONS).map((o) => o.posture)),
    ).sort();
    expect([...PhaseEnteredPostureSchema.options].sort()).toEqual(posturesInUse);
  });

  it('PhaseBlockedKind_MatchesPhaseKindUnion', () => {
    // Drift guard: `phase.blocked.kind` is an inlined z.enum in
    // event-store/schemas.ts (kept free of a workflow/config import). Pin it to
    // the single source of truth — `KIND_OBLIGATIONS` keys ARE the `PhaseKind`
    // union (enforced by `satisfies Record<PhaseKind, …>`), so adding a kind
    // without updating the event schema turns this assertion red.
    expect([...PhaseBlockedKindSchema.options].sort()).toEqual(
      Object.keys(KIND_OBLIGATIONS).sort(),
    );
  });

  it('should include workflow-level types', () => {
    expect(EventTypes).toContain('workflow.started');
    expect(EventTypes).toContain('task.assigned');
  });

  it('should include task-level types', () => {
    expect(EventTypes).toContain('task.claimed');
    expect(EventTypes).toContain('task.progressed');
    expect(EventTypes).toContain('task.completed');
    expect(EventTypes).toContain('task.failed');
  });

  it('should include quality gate types', () => {
    expect(EventTypes).toContain('gate.executed');
  });

  it('should include stack types', () => {
    expect(EventTypes).toContain('stack.position-filled');
    expect(EventTypes).toContain('stack.restacked');
    expect(EventTypes).toContain('stack.enqueued');
  });

  it('should include workflow internal event types', () => {
    expect(EventTypes).toContain('workflow.transition');
    expect(EventTypes).toContain('workflow.fix-cycle');
    expect(EventTypes).toContain('workflow.guard-failed');
    expect(EventTypes).toContain('workflow.checkpoint');
    expect(EventTypes).toContain('workflow.compound-entry');
    expect(EventTypes).toContain('workflow.compound-exit');
    expect(EventTypes).toContain('workflow.cancel');
    expect(EventTypes).toContain('workflow.cleanup');
    expect(EventTypes).toContain('workflow.compensation');
    expect(EventTypes).toContain('workflow.circuit-open');
  });

  it('should include benchmark types', () => {
    expect(EventTypes).toContain('benchmark.completed');
  });

  it('should support type-safe assignment', () => {
    const eventType: EventType = 'workflow.started';
    expect(eventType).toBe('workflow.started');
  });
});

// ─── B3: Workflow Transition Event Data Schemas ─────────────────────────────

describe('WorkflowTransitionData', () => {
  it('WorkflowEventBase_WorkflowTransition_ParsesCorrectly', () => {
    const data = WorkflowTransitionData.parse({
      from: 'ideate',
      to: 'plan',
      trigger: 'design-approved',
      featureId: 'my-feature',
    });
    expect(data.from).toBe('ideate');
    expect(data.to).toBe('plan');
    expect(data.trigger).toBe('design-approved');
    expect(data.featureId).toBe('my-feature');
  });

  it('should parse event base with workflow.transition type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.transition',
      data: { from: 'ideate', to: 'plan', trigger: 'approved', featureId: 'test' },
    });
    expect(event.type).toBe('workflow.transition');
  });
});

describe('WorkflowFixCycleData', () => {
  it('WorkflowEventBase_WorkflowFixCycle_ParsesCorrectly', () => {
    const data = WorkflowFixCycleData.parse({
      compoundStateId: 'feature-delegate-review',
      count: 2,
      featureId: 'my-feature',
    });
    expect(data.compoundStateId).toBe('feature-delegate-review');
    expect(data.count).toBe(2);
    expect(data.featureId).toBe('my-feature');
  });

  it('should parse event base with workflow.fix-cycle type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.fix-cycle',
    });
    expect(event.type).toBe('workflow.fix-cycle');
  });
});

describe('WorkflowGuardFailedData', () => {
  it('WorkflowEventBase_WorkflowGuardFailed_ParsesCorrectly', () => {
    const data = WorkflowGuardFailedData.parse({
      guard: 'allTasksComplete',
      from: 'delegate',
      to: 'review',
      featureId: 'my-feature',
    });
    expect(data.guard).toBe('allTasksComplete');
    expect(data.from).toBe('delegate');
    expect(data.to).toBe('review');
    expect(data.featureId).toBe('my-feature');
  });

  it('should parse event base with workflow.guard-failed type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.guard-failed',
    });
    expect(event.type).toBe('workflow.guard-failed');
  });
});

describe('WorkflowCheckpointData', () => {
  it('WorkflowEventBase_WorkflowCheckpoint_ParsesCorrectly', () => {
    const data = WorkflowCheckpointData.parse({
      counter: 5,
      phase: 'delegate',
      featureId: 'my-feature',
    });
    expect(data.counter).toBe(5);
    expect(data.phase).toBe('delegate');
    expect(data.featureId).toBe('my-feature');
  });

  it('should parse event base with workflow.checkpoint type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.checkpoint',
    });
    expect(event.type).toBe('workflow.checkpoint');
  });
});

describe('WorkflowCompoundEntryData', () => {
  it('WorkflowEventBase_WorkflowCompoundEntry_ParsesCorrectly', () => {
    const data = WorkflowCompoundEntryData.parse({
      compoundStateId: 'feature-delegate-review',
      featureId: 'my-feature',
    });
    expect(data.compoundStateId).toBe('feature-delegate-review');
    expect(data.featureId).toBe('my-feature');
  });

  it('should parse event base with workflow.compound-entry type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.compound-entry',
    });
    expect(event.type).toBe('workflow.compound-entry');
  });
});

// ─── B3: Workflow Compound Exit Event Data Schema ────────────────────────────

describe('WorkflowCompoundExitData', () => {
  it('should parse valid compound exit data with all fields', () => {
    const data = WorkflowCompoundExitData.parse({
      compoundStateId: 'thorough-track',
      featureId: 'my-feature',
      from: 'thorough-track',
      to: 'synthesize',
      trigger: 'execute-transition',
    });
    expect(data.compoundStateId).toBe('thorough-track');
    expect(data.featureId).toBe('my-feature');
    expect(data.from).toBe('thorough-track');
    expect(data.to).toBe('synthesize');
    expect(data.trigger).toBe('execute-transition');
  });

  it('should allow optional from, to, and trigger fields', () => {
    const data = WorkflowCompoundExitData.parse({
      compoundStateId: 'hotfix-track',
      featureId: 'my-feature',
    });
    expect(data.from).toBeUndefined();
    expect(data.to).toBeUndefined();
    expect(data.trigger).toBeUndefined();
  });

  it('should parse event base with workflow.compound-exit type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.compound-exit',
    });
    expect(event.type).toBe('workflow.compound-exit');
  });
});

// ─── B3: Workflow Cancel Event Data Schema ───────────────────────────────────

describe('WorkflowCancelData', () => {
  it('should parse valid cancel data with all fields', () => {
    const data = WorkflowCancelData.parse({
      from: 'delegate',
      to: 'cancelled',
      trigger: 'user-cancel',
      featureId: 'my-feature',
      reason: 'Requirements changed',
    });
    expect(data.from).toBe('delegate');
    expect(data.to).toBe('cancelled');
    expect(data.trigger).toBe('user-cancel');
    expect(data.featureId).toBe('my-feature');
    expect(data.reason).toBe('Requirements changed');
  });

  it('should allow optional reason', () => {
    const data = WorkflowCancelData.parse({
      from: 'ideate',
      to: 'cancelled',
      trigger: 'user-cancel',
      featureId: 'my-feature',
    });
    expect(data.reason).toBeUndefined();
  });

  it('should parse event base with workflow.cancel type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.cancel',
    });
    expect(event.type).toBe('workflow.cancel');
  });
});

// ─── B3: Workflow Compensation Event Data Schema ─────────────────────────────

describe('WorkflowCompensationData', () => {
  it('should parse valid compensation data with all fields', () => {
    const data = WorkflowCompensationData.parse({
      featureId: 'my-feature',
      actionId: 'synthesize:close-pr',
      status: 'executed',
      message: 'Closed PR: https://github.com/org/repo/pull/42',
    });
    expect(data.featureId).toBe('my-feature');
    expect(data.actionId).toBe('synthesize:close-pr');
    expect(data.status).toBe('executed');
    expect(data.message).toBe('Closed PR: https://github.com/org/repo/pull/42');
  });

  it('should accept all valid status values', () => {
    for (const status of ['executed', 'skipped', 'failed', 'dry-run']) {
      const data = WorkflowCompensationData.parse({
        featureId: 'my-feature',
        actionId: 'test-action',
        status,
        message: 'test',
      });
      expect(data.status).toBe(status);
    }
  });

  it('should reject invalid status values', () => {
    expect(() =>
      WorkflowCompensationData.parse({
        featureId: 'my-feature',
        actionId: 'test-action',
        status: 'invalid',
        message: 'test',
      }),
    ).toThrow();
  });

  it('should parse event base with workflow.compensation type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.compensation',
    });
    expect(event.type).toBe('workflow.compensation');
  });
});

// ─── B3: Workflow Circuit Open Event Data Schema ─────────────────────────────

describe('WorkflowCircuitOpenData', () => {
  it('should parse valid circuit open data with all fields', () => {
    const data = WorkflowCircuitOpenData.parse({
      featureId: 'my-feature',
      compoundId: 'feature-delegate-review',
      fixCycleCount: 3,
      maxFixCycles: 3,
    });
    expect(data.featureId).toBe('my-feature');
    expect(data.compoundId).toBe('feature-delegate-review');
    expect(data.fixCycleCount).toBe(3);
    expect(data.maxFixCycles).toBe(3);
  });

  it('should allow optional fixCycleCount and maxFixCycles', () => {
    const data = WorkflowCircuitOpenData.parse({
      featureId: 'my-feature',
      compoundId: 'delegate',
    });
    expect(data.fixCycleCount).toBeUndefined();
    expect(data.maxFixCycles).toBeUndefined();
  });

  it('should parse event base with workflow.circuit-open type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.circuit-open',
    });
    expect(event.type).toBe('workflow.circuit-open');
  });
});

// ─── Benchmark Event Data ────────────────────────────────────────────────────

describe('BenchmarkCompletedData', () => {
  it('BenchmarkCompletedData_ValidResults_ParsesCorrectly', () => {
    const data = BenchmarkCompletedData.parse({
      taskId: 'task-001',
      results: [{
        operation: 'event-store-query',
        metric: 'p99',
        value: 45.2,
        unit: 'ms',
        baseline: 42.0,
        regressionPercent: 7.6,
        passed: true,
      }],
    });
    expect(data.taskId).toBe('task-001');
    expect(data.results).toHaveLength(1);
    expect(data.results[0].operation).toBe('event-store-query');
    expect(data.results[0].passed).toBe(true);
  });

  it('BenchmarkCompletedData_EmptyResults_Rejects', () => {
    expect(() => BenchmarkCompletedData.parse({
      taskId: 'task-001',
      results: [],
    })).toThrow();
  });

  it('BenchmarkCompletedData_MissingOperation_Rejects', () => {
    expect(() => BenchmarkCompletedData.parse({
      taskId: 'task-001',
      results: [{ metric: 'p99', value: 10, unit: 'ms', passed: true }],
    })).toThrow();
  });

  it('BenchmarkCompletedData_OptionalBaselineFields', () => {
    const data = BenchmarkCompletedData.parse({
      taskId: 'task-001',
      results: [{
        operation: 'view-materialize',
        metric: 'throughput',
        value: 500,
        unit: 'ops/sec',
        passed: true,
      }],
    });
    expect(data.results[0].baseline).toBeUndefined();
    expect(data.results[0].regressionPercent).toBeUndefined();
  });
});

// ─── Dead Event Types Removal Verification ──────────────────────────────────

describe('Dead event types removed', () => {
  it('should not contain removed event types', () => {
    const removedTypes = [
      'phase.transitioned',
      'task.routed',
      'context.assembled',
      'gate.self-corrected',
      'remediation.started',
    ];
    for (const type of removedTypes) {
      expect(EventTypes).not.toContain(type);
    }
  });

});
