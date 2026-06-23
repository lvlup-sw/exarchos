import { z } from 'zod';
import { describe, it, expect, afterEach } from 'vitest';
import { zodToJsonSchema } from '../adapters/json-schema.js';
import {
  validateAgentEvent,
  AGENT_EVENT_TYPES,
  EventTypes,
  WorkflowEventBase,
  TaskAssignedData,
  TeamSpawnedData,
  TeamTaskAssignedData,
  TeamTaskCompletedData,
  TeamTaskFailedData,
  TeamDisbandedData,
  TeamTaskPlannedData,
  TeamTeammateDispatchedData,
  QualityRegressionData,
  WorkflowCasFailedData,
  ReviewRoutedData,
  ReviewFindingData,
  ReviewEscalatedData,
  QualityHintGeneratedData,
  EvalRunStartedData,
  EvalCaseCompletedData,
  EvalRunCompletedData,
  ShepherdStartedData,
  ShepherdIterationData,
  ShepherdApprovalRequestedData,
  ShepherdCompletedData,
  TaskProgressedData,
  TaskCompletedData,
  TaskFailedData,
  WorkflowPrunedData,
  SynthesizeRequestedData,
  WorkflowCheckpointRequestedData,
  SessionTaggedData,
  StackRestackedData,
  WorktreeCreatedData,
  WorktreeBaselineData,
  TestResultData,
  TypecheckResultData,
  StackSubmittedData,
  CiStatusData,
  CommentPostedData,
  CommentResolvedData,
  MergePreflightData,
  MergeExecutedData,
  MergeRollbackData,
  MergeCompletedData,
  CommandResolvedEventSchema,
  HsmDeprecatedActionInvokedData,
  SpecLegacyCapabilitiesArrayData,
  PhaseContractMissingData,
  MigrationLegacyJsonlImportedData,
  MigrationCompletedData,
  MigrationFailedData,
  SessionMachineryConsumedDataSchema,
  EVENT_EMISSION_REGISTRY,
  EVENT_DATA_SCHEMAS,
  type EventEmissionSource,
  registerEventType,
  unregisterEventType,
  getValidEventTypes,
  isBuiltInEventType,
  serializeEventCatalog,
  // Wave B (#1342) two-event split schemas
  PrCreateRequestedData,
  PrCreateExecutedData,
  PrCommentRequestedData,
  PrCommentExecutedData,
  IssueCreateRequestedData,
  IssueCreateExecutedData,
  BranchDeleteRequestedData,
  BranchDeleteExecutedData,
  WorktreeRemoveRequestedData,
  WorktreeRemoveExecutedData,
} from './schemas.js';

// ─── T1: EventEmissionSource + EVENT_EMISSION_REGISTRY ──────────────────────

describe('EVENT_EMISSION_REGISTRY', () => {
  it('EventEmissionRegistry_AllEventTypes_HaveClassification', () => {
    for (const eventType of EventTypes) {
      expect(EVENT_EMISSION_REGISTRY).toHaveProperty(eventType);
      const source = EVENT_EMISSION_REGISTRY[eventType];
      expect(['auto', 'model', 'hook', 'planned']).toContain(source);
    }
  });

  it('EventEmissionRegistry_ModelEvents_IncludesTeamAndReview', () => {
    const modelSpotChecks: Array<typeof EventTypes[number]> = [
      'team.spawned',
      'team.task.assigned',
      'team.disbanded',
      'review.finding',
      'review.escalated',
      'session.tagged',
      'task.assigned',
      'task.progressed',
    ];
    for (const eventType of modelSpotChecks) {
      expect(EVENT_EMISSION_REGISTRY[eventType]).toBe('model');
    }
  });

  it('EventEmissionRegistry_AutoEvents_IncludesWorkflowAndTask', () => {
    const autoSpotChecks: Array<typeof EventTypes[number]> = [
      'workflow.started',
      'workflow.transition',
      'workflow.checkpoint',
      'task.claimed',
      'task.completed',
      'task.failed',
      'gate.executed',
      'state.patched',
      'tool.invoked',
      // RC2 (#1395) — migrated model → auto: the runtime already emits these
      // deterministically from a dispatch-core handler (review/tools.ts,
      // assess-stack.ts, views/tools.ts respectively), so the model must no
      // longer be nagged to hand-maintain them.
      'review.routed',
      'ci.status',
      'quality.regression',
    ];
    for (const eventType of autoSpotChecks) {
      expect(EVENT_EMISSION_REGISTRY[eventType]).toBe('auto');
    }
  });

  it('EventTypes_PreflightEventsRegistered_BothNamesPresent', () => {
    // Regression: #1129. `prepare_delegation` emits preflight.executed and
    // preflight.blocked, but without registration the event store rejects
    // the append — and fire-and-forget `.catch(()=>{})` silently swallows
    // the rejection. Every preflight event ends up in the bit bucket.
    expect(EventTypes).toContain('preflight.executed');
    expect(EventTypes).toContain('preflight.blocked');
    expect(EVENT_EMISSION_REGISTRY['preflight.executed']).toBe('auto');
    expect(EVENT_EMISSION_REGISTRY['preflight.blocked']).toBe('auto');
  });
});

// ─── T2: EVENT_DATA_SCHEMAS map ─────────────────────────────────────────────

describe('EVENT_DATA_SCHEMAS', () => {
  it('EventDataSchemas_AllEventTypes_HaveEntry', () => {
    // Every EventType should either be in EVENT_DATA_SCHEMAS or be explicitly absent.
    // We verify that the keys in EVENT_DATA_SCHEMAS are all valid EventTypes.
    const schemaKeys = Object.keys(EVENT_DATA_SCHEMAS);
    for (const key of schemaKeys) {
      expect(EventTypes).toContain(key);
    }
  });

  it('EventDataSchemas_ModelEvents_HaveNonNullSchemas', () => {
    // Every model-emitted type must have a non-null schema
    for (const eventType of EventTypes) {
      if (EVENT_EMISSION_REGISTRY[eventType] === 'model') {
        expect(
          EVENT_DATA_SCHEMAS[eventType],
          `Model event '${eventType}' should have a data schema`,
        ).toBeDefined();
      }
    }
  });

  it('EventDataSchemas_ValidData_ParsesSuccessfully', () => {
    // For each entry with a schema, parse known-valid data samples
    const validDataSamples: Partial<Record<string, Record<string, unknown>>> = {
      'workflow.started': { featureId: 'f1', workflowType: 'feature' },
      'task.assigned': { taskId: 't1', title: 'Test task' },
      'task.claimed': { taskId: 't1', agentId: 'a1', claimedAt: '2025-01-01T00:00:00Z' },
      'task.progressed': { taskId: 't1', tddPhase: 'red' },
      'task.completed': { taskId: 't1' },
      'task.failed': { taskId: 't1', error: 'something broke' },
      'team.spawned': { teamSize: 2, teammateNames: ['a', 'b'], taskCount: 3, dispatchMode: 'agent-team' },
      'team.task.assigned': { taskId: 't1', teammateName: 'w1', worktreePath: '/tmp/wt', modules: ['m1'] },
      'team.task.completed': { taskId: 't1', teammateName: 'w1', durationMs: 1000, filesChanged: ['f.ts'], testsPassed: true, qualityGateResults: {} },
      'team.task.failed': { taskId: 't1', teammateName: 'w1', failureReason: 'build', gateResults: {} },
      'team.disbanded': { totalDurationMs: 5000, tasksCompleted: 2, tasksFailed: 0 },
      'review.routed': { pr: 1, riskScore: 0.5, factors: ['f'], destination: 'coderabbit', velocityTier: 'normal', semanticAugmented: false },
      'session.tagged': { tag: 'test', sessionId: 'sess-1' },
    };

    for (const [eventType, data] of Object.entries(validDataSamples)) {
      const schema = EVENT_DATA_SCHEMAS[eventType as typeof EventTypes[number]];
      if (schema) {
        const result = schema.safeParse(data);
        expect(result.success, `Schema for '${eventType}' should parse valid data: ${JSON.stringify(result)}`).toBe(true);
      }
    }
  });
});

describe('validateAgentEvent', () => {
  describe('agent event types', () => {
    it('should reject task.claimed when agentId is missing', () => {
      expect(() =>
        validateAgentEvent({ type: 'task.claimed', source: 'test' }),
      ).toThrow();
    });

    it('should reject task.claimed when source is missing', () => {
      expect(() =>
        validateAgentEvent({ type: 'task.claimed', agentId: 'agent-1' }),
      ).toThrow();
    });

    it('should reject task.progressed when source is missing', () => {
      expect(() =>
        validateAgentEvent({ type: 'task.progressed', agentId: 'agent-1' }),
      ).toThrow();
    });

    it('should pass task.claimed when both agentId and source are present', () => {
      expect(
        validateAgentEvent({ type: 'task.claimed', agentId: 'agent-1', source: 'test' }),
      ).toBe(true);
    });

    it('should pass task.progressed when both agentId and source are present', () => {
      expect(
        validateAgentEvent({ type: 'task.progressed', agentId: 'agent-1', source: 'test' }),
      ).toBe(true);
    });
  });

  describe('system event types', () => {
    it('should pass workflow.started without agentId or source', () => {
      expect(
        validateAgentEvent({ type: 'workflow.started' }),
      ).toBe(true);
    });

    it('should pass workflow.transition without agentId or source', () => {
      expect(
        validateAgentEvent({ type: 'workflow.transition' }),
      ).toBe(true);
    });

    it('should pass task.assigned without agentId or source', () => {
      expect(
        validateAgentEvent({ type: 'task.assigned' }),
      ).toBe(true);
    });
  });

  describe('AGENT_EVENT_TYPES constant', () => {
    it('should contain all agent event types', () => {
      expect(AGENT_EVENT_TYPES).toEqual([
        'task.claimed',
        'task.progressed',
        'team.task.completed',
        'team.task.failed',
      ]);
    });
  });
});

describe('Team Event Data Schemas', () => {
  describe('TeamSpawnedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamSpawnedData.safeParse({
        teamSize: 3,
        teammateNames: ['a', 'b', 'c'],
        taskCount: 5,
        dispatchMode: 'agent-team',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamTaskCompletedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamTaskCompletedData.safeParse({
        taskId: 'task-001',
        teammateName: 'worker-1',
        durationMs: 5000,
        filesChanged: ['a.ts'],
        testsPassed: true,
        qualityGateResults: {},
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamTaskFailedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamTaskFailedData.safeParse({
        taskId: 'task-001',
        teammateName: 'worker-1',
        failureReason: 'typecheck',
        gateResults: {},
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamDisbandedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamDisbandedData.safeParse({
        totalDurationMs: 60000,
        tasksCompleted: 5,
        tasksFailed: 0,
      });
      expect(result.success).toBe(true);
    });

    it('TeamDisbandedData_ValidData_ParsesSuccessfully', () => {
      const result = TeamDisbandedData.safeParse({
        totalDurationMs: 5000,
        tasksCompleted: 3,
        tasksFailed: 0,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamTaskAssignedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamTaskAssignedData.safeParse({
        taskId: 'task-001',
        teammateName: 'worker-1',
        worktreePath: '/tmp/wt',
        modules: ['auth'],
      });
      expect(result.success).toBe(true);
    });
  });
});

describe('EventTypes', () => {
  it('should include all 7 team event types', () => {
    const teamEventTypes = [
      'team.spawned',
      'team.task.assigned',
      'team.task.completed',
      'team.task.failed',
      'team.disbanded',
      'team.task.planned',
      'team.teammate.dispatched',
    ];
    for (const eventType of teamEventTypes) {
      expect(EventTypes).toContain(eventType);
    }
  });
});

// ─── Task 002: team.task.planned and team.teammate.dispatched ────────────────

describe('TeamTaskPlannedData', () => {
  it('EventSchema_TeamTaskPlanned_ValidatesPayload', () => {
    const result = TeamTaskPlannedData.safeParse({
      taskId: 'task-001',
      title: 'Implement event store',
      modules: ['event-store', 'schemas'],
      blockedBy: ['task-000'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.taskId).toBe('task-001');
      expect(result.data.title).toBe('Implement event store');
      expect(result.data.modules).toEqual(['event-store', 'schemas']);
      expect(result.data.blockedBy).toEqual(['task-000']);
    }
  });

  it('EventSchema_TeamTaskPlanned_RejectsWithoutTaskId', () => {
    const result = TeamTaskPlannedData.safeParse({
      title: 'Implement event store',
      modules: ['event-store'],
      blockedBy: [],
    });
    expect(result.success).toBe(false);
  });

  it('EventSchema_TeamTaskPlanned_IncludedInEventTypeUnion', () => {
    expect(EventTypes).toContain('team.task.planned');
  });

  it('EventSchema_TeamTaskPlanned_ParsesAsBaseEvent', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'team.task.planned',
      data: {
        taskId: 'task-001',
        title: 'Implement event store',
        modules: ['event-store'],
        blockedBy: [],
      },
    });
    expect(event.success).toBe(true);
  });
});

describe('TeamTeammateDispatchedData', () => {
  it('EventSchema_TeamTeammateDispatched_ValidatesPayload', () => {
    const result = TeamTeammateDispatchedData.safeParse({
      teammateName: 'worker-1',
      worktreePath: '/path/.worktrees/wt-001',
      assignedTaskIds: ['task-001', 'task-002'],
      model: 'claude-sonnet-4-20250514',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.teammateName).toBe('worker-1');
      expect(result.data.worktreePath).toBe('/path/.worktrees/wt-001');
      expect(result.data.assignedTaskIds).toEqual(['task-001', 'task-002']);
      expect(result.data.model).toBe('claude-sonnet-4-20250514');
    }
  });

  it('EventSchema_TeamTeammateDispatched_RejectsWithoutTeammateName', () => {
    const result = TeamTeammateDispatchedData.safeParse({
      worktreePath: '/path/.worktrees/wt-001',
      assignedTaskIds: ['task-001'],
      model: 'claude-sonnet-4-20250514',
    });
    expect(result.success).toBe(false);
  });

  it('EventSchema_TeamTeammateDispatched_IncludedInEventTypeUnion', () => {
    expect(EventTypes).toContain('team.teammate.dispatched');
  });

  it('EventSchema_TeamTeammateDispatched_ParsesAsBaseEvent', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'team.teammate.dispatched',
      data: {
        teammateName: 'worker-1',
        worktreePath: '/tmp/wt',
        assignedTaskIds: ['task-001'],
        model: 'claude-sonnet-4-20250514',
      },
    });
    expect(event.success).toBe(true);
  });
});

// ─── T11: quality.regression Event Type ──────────────────────────────────────

describe('QualityRegressionData', () => {
  it('QualityRegressionData_Valid_Parses', () => {
    const result = QualityRegressionData.safeParse({
      skill: 'delegation',
      gate: 'typecheck',
      consecutiveFailures: 3,
      firstFailureCommit: 'abc',
      lastFailureCommit: 'def',
      detectedAt: '2026-02-17T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skill).toBe('delegation');
      expect(result.data.gate).toBe('typecheck');
      expect(result.data.consecutiveFailures).toBe(3);
      expect(result.data.firstFailureCommit).toBe('abc');
      expect(result.data.lastFailureCommit).toBe('def');
      expect(result.data.detectedAt).toBe('2026-02-17T00:00:00.000Z');
    }
  });
});

// ─── T26: workflow.cas-failed Event Schema ───────────────────────────────────

describe('WorkflowCasFailedData', () => {
  it('WorkflowCasFailedData_Valid_Parses', () => {
    const result = WorkflowCasFailedData.safeParse({
      featureId: 'test',
      phase: 'delegate',
      retries: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.featureId).toBe('test');
      expect(result.data.phase).toBe('delegate');
      expect(result.data.retries).toBe(3);
    }
  });
});

describe('EventTypes', () => {
  it('EventTypes_IncludesQualityRegression', () => {
    expect(EventTypes).toContain('quality.regression');
  });

  it('EventTypes_IncludesWorkflowCasFailed', () => {
    expect(EventTypes).toContain('workflow.cas-failed');
  });

  it('EventTypes_HasExpectedCount', () => {
    // Bumped from 104 → 105 with #1262: `turn.completed` carries the
    // per-turn output-token sample the `output_tokens_high` quality hint
    // fires on (see `telemetry/quality-hints.ts`).
    // Previous (103 → 104): PR3/T7 (#1364) `tool.action_errored` splits
    // structured action-level failures out from `tool.errored` (which now
    // counts transport/protocol failures only).
    // Previous (93 → 103): Wave B (#1342) 5×{requested,executed} two-event
    // split schemas for non-idempotent VCS handlers (B1–B5):
    //   pr.create.requested, pr.create.executed,
    //   pr.comment.requested, pr.comment.executed,
    //   issue.create.requested, issue.create.executed,
    //   branch.delete.requested, branch.delete.executed,
    //   worktree.remove.requested, worktree.remove.executed.
    // Previous (93): merge.requested (Wave 2B.2 / #1304 — audit §F1.2).
    // Previous (92): migration.workflow_type_unknown (Wave 1, R-1 Marten #1313).
    // Previous (91): session.machinery_consumed (T-11, rehydration-machinery-refactor).
    // Previous (84 → 90): six durable event-store substrate types (#1259 T02/T03/T04).
    // Previous (105 → 106): workspace.resolved (#1290 — roots-based workspace
    //   discovery; emitted by `src/workspace/discovery.ts`).
    // Bumped 106 → 108: elicitation.requested + elicitation.fulfilled
    // (#1274 — elicitation form mode for missing-required-param hand-off
    //   in the dispatch boundary).
    // Bumped 108 → 109: elicitation.declined (Sentry MEDIUM #1424 — client
    //   decline carries a distinct audit-trail event instead of collapsing
    //   into `fulfilled` with a falsy payload).
    // Bumped 109 → 113: task.created + task.polled + task.result +
    //   task.cancelled (#1272 — EventSourcedTaskStore lifecycle; SDK
    //   `TaskStore` interface as a projection over the event store).
    //   Distinct from the orchestrated-task family above; see
    //   `event-store/task-events.test.ts` for the schema-shape contracts
    //   and `task-store/event-sourced-task-store.test.ts` for the
    //   end-to-end lifecycle + REPLAY (INV-1) acceptance test.
    // Bumped 113 → 115: dispatch.preflight + stash.detected (#1261 —
    //   dispatch-guard preflight observability emitted by
    //   `orchestrate/dispatch-guard.ts`).
    // Bumped 115 → 116: migration.correlation_backfill_progress (#1437 —
    //   chunked V5→V6 backfill progress emitted on the `__migration__`
    //   stream from `SqliteBackend.backfillCorrelationColumnsChunked`).
    // Bumped 116 → 118: invariant.authored + catalog.registered
    //   (invariants-catalog-wizard P2 — invariant-authoring lifecycle
    //   emitted by the `invariants_add` composite handler; see
    //   `orchestrate/invariants/add.ts`).
    // Bumped 118 → 119: merge.completed (#1304 INV-10 terminal marker —
    //   emitted by `handleExecuteMerge` adjacent to `merge.executed`;
    //   folded by `merge-orchestrator@v1` as the transition into the
    //   `completed` terminal phase).
    // Bumped 119 → 121: onboard.requested + onboard.executed (#1510 DR-7 task
    //   008 — the two-event onboard contract, INV-1 / INV-13, emitted by the
    //   `onboard` composite).
    // Bumped 121 → 120: init.executed retired (#1510 DR-5 task 018 — the init
    //   verb/handler was removed; `onboard.*` is the audit trail now).
    // Bumped 120 → 122: mutation.executing_started + mutation.executed
    //   (verification-ladder slice 1 task 020 — the run-mutation liveness pair,
    //   INV-10, emitted by the `exarchos run-mutation` CLI verb).
    // Bumped 122 → 123: phase.blocked (phase-kind binding DR-7, epic #1546 —
    //   fail-closed at the gate-set boundary; emitted by the wave-dispatch
    //   boundary when the IMPLEMENT-kind gate-set resolver throws, refusing the
    //   dispatch instead of failing open).
    // Bumped 123 → 125: phase.entered + phase.exited (phase-kind binding DR-13,
    //   epic #1546 — resolve-then-freeze; the executeTransition boundary freezes
    //   the resolved obligation as `phase.entered` and records the aggregate
    //   gate status as `phase.exited` on advance).
    // Bumped 125 → 126: subagent.tokens_used (#1525 W2 Half 1 — per-subagent
    //   output-token total emitted by the restored SubagentStop hook
    //   `cli-commands/subagent-stop.ts`, folded by team-performance /
    //   delegation-timeline for the token-reduction acceptance gate).
    // Bumped 126 → 127: merge.recovered (#1306 — successor to merge.rollback,
    //   dual-emitted during the v2.11.x deprecation window; legacy removed v2.12).
    // Bumped 127 → 128: merge.retry_attempt (#1308 — audit record of a
    //   transient-failure retry of the merge attempt; emission lands later).
    // Bumped 128 → 129: merge.executing_started (#1309 — merge-executor liveness
    //   event; emitted after the recovery point is recorded, before the first
    //   vcsMerge, so a long-running merge is observable as started-but-unterminated,
    //   the INV-10 executing_started + paired terminal pattern).
    // Bumped 129 → 130: shepherd.escalated (DR-3 #1595 — structured bound-hit
    //   escalation emitted by assess-stack on the escalate path; a structured
    //   terminal (NOT a hang) surfaced via shepherd_status/ps, INV-10).
    expect(EventTypes).toHaveLength(130);
    expect(EventTypes).toContain('merge.recovered');
    expect(EventTypes).toContain('merge.retry_attempt');
    expect(EventTypes).toContain('merge.executing_started');
    expect(EventTypes).toContain('subagent.tokens_used');
    expect(EventTypes).toContain('onboard.requested');
    expect(EventTypes).toContain('onboard.executed');
    expect(EventTypes).toContain('mutation.executing_started');
    expect(EventTypes).toContain('mutation.executed');
    expect(EventTypes).toContain('phase.blocked');
    // Retirement guard: init.executed removed in DR-5 (task 018).
    expect(EventTypes as readonly string[]).not.toContain('init.executed');
  });

  it('eventSchemas_SubagentTokensUsed_ValidateAndRegister', () => {
    // #1525 W2 Half 1 — the restored SubagentStop hook emits subagent.tokens_used
    // to the feature stream (the handler owns the append) → 'auto' classification.
    expect(EventTypes).toContain('subagent.tokens_used');
    expect(EVENT_EMISSION_REGISTRY['subagent.tokens_used']).toBe('auto');

    const schema = EVENT_DATA_SCHEMAS['subagent.tokens_used'];
    expect(schema).toBeDefined();

    // Minimal valid payload: the hook always has agentId + summed outputTokens.
    expect(schema!.safeParse({ agentId: 'agent-abc', outputTokens: 1234 }).success).toBe(true);

    // Fully-correlated payload (teammate resolved via worktree↔cwd at emit time).
    const full = schema!.safeParse({
      agentId: 'agent-abc',
      agentType: 'exarchos-implementer',
      outputTokens: 5000,
      teammateName: 'alice',
      taskId: 'W2-6',
      sessionId: 'sess-1',
      cwd: '/tmp/wt',
    });
    expect(full.success).toBe(true);

    // Reject missing agentId / negative tokens / fractional tokens (#1560 — token
    // counts are integers; fractional values would corrupt downstream aggregates).
    expect(schema!.safeParse({ outputTokens: 10 }).success).toBe(false);
    expect(schema!.safeParse({ agentId: 'a', outputTokens: -1 }).success).toBe(false);
    expect(schema!.safeParse({ agentId: 'a', outputTokens: 12.5 }).success).toBe(false);
  });

  it('eventSchemas_PhaseEnteredExited_ValidateAndRegister', () => {
    // Phase-kind binding S4 (DR-13, epic #1546): resolve-then-freeze records the
    // resolved obligation as a durable `phase.entered` event; `phase.exited`
    // records the aggregate gate outcome on phase advance. Both are emitted by
    // the runtime at the executeTransition boundary → 'auto' classification
    // (mirrors pr.create.requested / pr.create.executed registration).
    expect(EventTypes).toContain('phase.entered');
    expect(EventTypes).toContain('phase.exited');
    expect(EVENT_EMISSION_REGISTRY['phase.entered']).toBe('auto');
    expect(EVENT_EMISSION_REGISTRY['phase.exited']).toBe('auto');

    const enteredSchema = EVENT_DATA_SCHEMAS['phase.entered'];
    const exitedSchema = EVENT_DATA_SCHEMAS['phase.exited'];
    expect(enteredSchema).toBeDefined();
    expect(exitedSchema).toBeDefined();

    // phase.entered carries the frozen obligation (resolver + resolved gate-set
    // + policy provenance + resolved mode + POLA posture).
    expect(
      enteredSchema?.safeParse({
        phase: 'implement',
        kind: 'IMPLEMENT',
        resolver: 'verification-ladder',
        resolvedGates: [{ family: 'ladder', gate: 'check_static_analysis' }],
        policySource: 'builtin',
        mode: 'enforce',
        posture: 'task-isolated',
      }).success,
    ).toBe(true);

    // A GATHER phase carries no gates: null resolver + empty obligation.
    expect(
      enteredSchema?.safeParse({
        phase: 'gather',
        kind: 'GATHER',
        resolver: null,
        resolvedGates: [],
        policySource: 'builtin',
        mode: 'enforce',
        posture: 'read-only',
      }).success,
    ).toBe(true);

    // Unknown policySource is rejected at the persisted-event boundary rather
    // than laundered onto the durable log.
    expect(
      enteredSchema?.safeParse({
        phase: 'plan',
        kind: 'PLAN',
        resolver: 'plan-structure',
        resolvedGates: [],
        policySource: 'whoknows',
        mode: 'enforce',
        posture: 'read-only',
      }).success,
    ).toBe(false);

    // An unknown ResolvedGate family is rejected (the four-family discriminant
    // is pinned to phase-kind.ts's ResolvedGate union by a drift-guard test).
    expect(
      enteredSchema?.safeParse({
        phase: 'review',
        kind: 'REVIEW',
        resolver: 'review-contract',
        resolvedGates: [{ family: 'bogus', gate: 'x' }],
        policySource: 'builtin',
        mode: 'enforce',
        posture: 'read-only',
      }).success,
    ).toBe(false);

    // An unknown posture is rejected at the persisted-event boundary.
    expect(
      enteredSchema?.safeParse({
        phase: 'plan',
        kind: 'PLAN',
        resolver: 'plan-structure',
        resolvedGates: [],
        policySource: 'builtin',
        mode: 'enforce',
        posture: 'god-mode',
      }).success,
    ).toBe(false);

    // phase.exited carries the aggregate required-gate status (non-optional).
    expect(
      exitedSchema?.safeParse({ phase: 'implement', allRequiredGatesPassed: true }).success,
    ).toBe(true);
    expect(exitedSchema?.safeParse({ phase: 'implement' }).success).toBe(false);
  });

  it('EventTypes_IncludesElicitation', () => {
    // #1274 — all three events carry the elicitation request/response on a
    // per-operation pseudo-stream so dispatch can correlate by operationId.
    // `elicitation.declined` was added by the Sentry MEDIUM fix (#1424) so
    // client decline carries a distinct audit-trail entry instead of
    // collapsing into `fulfilled` with a falsy payload.
    expect(EventTypes).toContain('elicitation.requested');
    expect(EventTypes).toContain('elicitation.fulfilled');
    expect(EventTypes).toContain('elicitation.declined');
  });

  it('EventTypes_IncludesSessionTagged', () => {
    expect(EventTypes).toContain('session.tagged');
  });

  it('EventTypes_StatePatchedType_IsValidEventType', () => {
    expect(EventTypes).toContain('state.patched');
  });

  it('EventTypes_StatePatchedType_ParsesAsBaseEvent', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'state.patched',
      data: {
        fields: { 'tasks[0].status': 'complete' },
      },
    });
    expect(event.success).toBe(true);
  });

  it('EventTypes_IncludesReviewRouted', () => {
    expect(EventTypes).toContain('review.routed');
  });

  it('EventTypes_IncludesReviewFinding', () => {
    expect(EventTypes).toContain('review.finding');
  });

  it('EventTypes_IncludesReviewEscalated', () => {
    expect(EventTypes).toContain('review.escalated');
  });
});

// ─── T3: Review Event Schemas ───────────────────────────────────────────────

describe('ReviewRoutedData', () => {
  it('reviewRoutedEvent_ValidPayload_PassesValidation', () => {
    const result = ReviewRoutedData.safeParse({
      pr: 42,
      riskScore: 0.75,
      factors: ['large-diff', 'security-sensitive'],
      destination: 'coderabbit',
      velocityTier: 'normal',
      semanticAugmented: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pr).toBe(42);
      expect(result.data.riskScore).toBe(0.75);
      expect(result.data.factors).toEqual(['large-diff', 'security-sensitive']);
      expect(result.data.destination).toBe('coderabbit');
      expect(result.data.velocityTier).toBe('normal');
      expect(result.data.semanticAugmented).toBe(true);
    }
  });

  it('reviewRoutedEvent_MissingFields_FailsValidation', () => {
    const result = ReviewRoutedData.safeParse({
      pr: 42,
      riskScore: 0.75,
      // missing factors, destination, velocityTier, semanticAugmented
    });
    expect(result.success).toBe(false);
  });
});

describe('ReviewFindingData', () => {
  it('reviewFindingEvent_ValidPayload_PassesValidation', () => {
    const result = ReviewFindingData.safeParse({
      pr: 42,
      source: 'coderabbit',
      severity: 'major',
      filePath: 'src/merge-gate.ts',
      lineRange: [10, 20],
      message: 'Function too complex',
      rule: 'solid-srp',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pr).toBe(42);
      expect(result.data.source).toBe('coderabbit');
      expect(result.data.severity).toBe('major');
      expect(result.data.filePath).toBe('src/merge-gate.ts');
      expect(result.data.lineRange).toEqual([10, 20]);
      expect(result.data.message).toBe('Function too complex');
      expect(result.data.rule).toBe('solid-srp');
    }
  });

  it('reviewFindingEvent_OptionalFieldsOmitted_PassesValidation', () => {
    const result = ReviewFindingData.safeParse({
      pr: 42,
      source: 'self-hosted',
      severity: 'minor',
      filePath: 'src/utils.ts',
      message: 'Consider renaming variable',
    });
    expect(result.success).toBe(true);
  });

  it('reviewFindingEvent_InvalidSeverity_FailsValidation', () => {
    const result = ReviewFindingData.safeParse({
      pr: 42,
      source: 'coderabbit',
      severity: 'high',  // invalid — not in enum
      filePath: 'src/merge-gate.ts',
      message: 'Something wrong',
    });
    expect(result.success).toBe(false);
  });
});

describe('ReviewEscalatedData', () => {
  it('reviewEscalatedEvent_ValidPayload_PassesValidation', () => {
    const result = ReviewEscalatedData.safeParse({
      pr: 42,
      reason: 'Self-hosted found major issue on velocity-triaged PR',
      originalScore: 0.3,
      triggeringFinding: 'Function too complex',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pr).toBe(42);
      expect(result.data.reason).toBe('Self-hosted found major issue on velocity-triaged PR');
      expect(result.data.originalScore).toBe(0.3);
      expect(result.data.triggeringFinding).toBe('Function too complex');
    }
  });
});

// ─── T5: quality.hint.generated Event Type ──────────────────────────────────

describe('QualityHintGeneratedData', () => {
  it('QualityHintGeneratedData_ValidData_PassesValidation', () => {
    const result = QualityHintGeneratedData.safeParse({
      skill: 'delegation',
      hintCount: 3,
      categories: ['gate', 'pbt', 'benchmark'],
      generatedAt: '2026-02-20T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skill).toBe('delegation');
      expect(result.data.hintCount).toBe(3);
      expect(result.data.categories).toEqual(['gate', 'pbt', 'benchmark']);
      expect(result.data.generatedAt).toBe('2026-02-20T00:00:00.000Z');
    }
  });

  it('QualityHintGeneratedData_ZeroHints_PassesValidation', () => {
    const result = QualityHintGeneratedData.safeParse({
      skill: 'quality-review',
      hintCount: 0,
      categories: [],
      generatedAt: '2026-02-20T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('QualityHintGeneratedData_MissingSkill_FailsValidation', () => {
    const result = QualityHintGeneratedData.safeParse({
      hintCount: 1,
      categories: ['gate'],
      generatedAt: '2026-02-20T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('EventTypes', () => {
  it('EventTypes_IncludesQualityHintGenerated', () => {
    expect(EventTypes).toContain('quality.hint.generated');
  });
});

// ─── T07: WorkflowEventBase multi-tenant fields ──────────────────────────────

describe('WorkflowEventBase multi-tenant fields', () => {
  it('WorkflowEventBase_WithTenantId_ParsesSuccessfully', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'workflow.started',
      tenantId: 'tenant-123',
      organizationId: 'org-456',
    };
    const result = WorkflowEventBase.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tenantId).toBe('tenant-123');
      expect(result.data.organizationId).toBe('org-456');
    }
  });

  it('WorkflowEventBase_EmptyTenantId_RejectsValidation', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'workflow.started',
      tenantId: '',
    };
    const result = WorkflowEventBase.safeParse(event);
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_EmptyOrganizationId_RejectsValidation', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'workflow.started',
      organizationId: '',
    };
    const result = WorkflowEventBase.safeParse(event);
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_WithoutTenantId_ParsesSuccessfully', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'workflow.started',
    };
    const result = WorkflowEventBase.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tenantId).toBeUndefined();
      expect(result.data.organizationId).toBeUndefined();
    }
  });
});

// ─── T07: Eval Event Type Schemas ──────────────────────────────────────────

describe('EvalRunStartedData', () => {
  it('EvalRunStartedData_ValidPayload_Parses', () => {
    const result = EvalRunStartedData.safeParse({
      runId: crypto.randomUUID(),
      suiteId: 'delegation',
      trigger: 'local',
      caseCount: 10,
    });
    expect(result.success).toBe(true);
  });

  it('EvalRunStartedData_MissingRunId_Fails', () => {
    const result = EvalRunStartedData.safeParse({
      suiteId: 'delegation',
      trigger: 'local',
      caseCount: 10,
    });
    expect(result.success).toBe(false);
  });

  it('EvalRunStartedData_InvalidTrigger_Fails', () => {
    const result = EvalRunStartedData.safeParse({
      runId: crypto.randomUUID(),
      suiteId: 'delegation',
      trigger: 'unknown',
      caseCount: 10,
    });
    expect(result.success).toBe(false);
  });

  it('EvalRunStartedData_WithOptionalLayer_Parses', () => {
    const result = EvalRunStartedData.safeParse({
      runId: crypto.randomUUID(),
      suiteId: 'delegation',
      trigger: 'local',
      caseCount: 10,
      layer: 'regression',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layer).toBe('regression');
    }
  });
});

describe('EvalCaseCompletedData', () => {
  it('EvalCaseCompletedData_ValidPayload_Parses', () => {
    const result = EvalCaseCompletedData.safeParse({
      runId: crypto.randomUUID(),
      caseId: 'case-001',
      suiteId: 'delegation',
      passed: true,
      score: 0.95,
      assertions: [
        { name: 'check-output', type: 'exact-match', passed: true, score: 0.95, reason: 'matched' },
      ],
      duration: 1200,
    });
    expect(result.success).toBe(true);
  });

  it('EvalCaseCompletedData_ScoreOutOfRange_Fails', () => {
    const result = EvalCaseCompletedData.safeParse({
      runId: crypto.randomUUID(),
      caseId: 'case-001',
      suiteId: 'delegation',
      passed: true,
      score: 1.5,
      assertions: [],
      duration: 1200,
    });
    expect(result.success).toBe(false);
  });

  it('EvalCaseCompletedData_EmptyAssertions_Parses', () => {
    const result = EvalCaseCompletedData.safeParse({
      runId: crypto.randomUUID(),
      caseId: 'case-001',
      suiteId: 'delegation',
      passed: true,
      score: 1.0,
      assertions: [],
      duration: 500,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.assertions).toEqual([]);
    }
  });
});

describe('EvalRunCompletedData', () => {
  it('EvalRunCompletedData_ValidPayload_Parses', () => {
    const result = EvalRunCompletedData.safeParse({
      runId: crypto.randomUUID(),
      suiteId: 'delegation',
      total: 10,
      passed: 8,
      failed: 2,
      avgScore: 0.85,
      duration: 5000,
      regressions: ['case-003'],
    });
    expect(result.success).toBe(true);
  });

  it('EvalRunCompletedData_NegativeFailed_Fails', () => {
    const result = EvalRunCompletedData.safeParse({
      runId: crypto.randomUUID(),
      suiteId: 'delegation',
      total: 10,
      passed: 8,
      failed: -1,
      avgScore: 0.85,
      duration: 5000,
      regressions: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('WorkflowEventBase — eval event types', () => {
  it('WorkflowEventBase_EvalRunStartedType_Parses', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'eval-stream',
      sequence: 1,
      type: 'eval.run.started',
      data: {
        runId: crypto.randomUUID(),
        suiteId: 'delegation',
        trigger: 'local',
        caseCount: 5,
      },
    });
    expect(event.success).toBe(true);
  });

  it('WorkflowEventBase_EvalCaseCompletedType_Parses', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'eval-stream',
      sequence: 2,
      type: 'eval.case.completed',
      data: {
        runId: crypto.randomUUID(),
        caseId: 'case-001',
        suiteId: 'delegation',
        passed: true,
        score: 1.0,
        assertions: [],
        duration: 100,
      },
    });
    expect(event.success).toBe(true);
  });

  it('WorkflowEventBase_EvalRunCompletedType_Parses', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'eval-stream',
      sequence: 3,
      type: 'eval.run.completed',
      data: {
        runId: crypto.randomUUID(),
        suiteId: 'delegation',
        total: 5,
        passed: 5,
        failed: 0,
        avgScore: 1.0,
        duration: 3000,
        regressions: [],
      },
    });
    expect(event.success).toBe(true);
  });
});

// ─── Task 3.1: quality.hint.generated @planned removal ──────────────────────

describe('schemas_QualityHintGenerated_NotMarkedPlanned', () => {
  it('schemas_QualityHintGenerated_NotMarkedPlanned', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const schemasPath = path.resolve(
      import.meta.dirname,
      'schemas.ts',
    );
    const source = fs.readFileSync(schemasPath, 'utf-8');

    // Find the QualityHintGeneratedData declaration and check
    // that no @planned annotation appears in the JSDoc immediately
    // preceding it
    const lines = source.split('\n');
    const declIndex = lines.findIndex((l) =>
      l.includes('QualityHintGeneratedData'),
    );
    expect(declIndex).toBeGreaterThan(0);

    // Check the 3 lines before the declaration for @planned
    const preceding = lines
      .slice(Math.max(0, declIndex - 3), declIndex)
      .join('\n');
    expect(preceding).not.toContain('@planned');
  });
});

// ─── Task 3: @planned removal promotion tests ──────────────────────

describe('schemas_ReviewFindingData_NotMarkedPlanned', () => {
  it('schemas_ReviewFindingData_NotMarkedPlanned', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const schemasPath = path.resolve(import.meta.dirname, 'schemas.ts');
    const source = fs.readFileSync(schemasPath, 'utf-8');
    const lines = source.split('\n');
    const declIndex = lines.findIndex((l) => l.includes('ReviewFindingData'));
    expect(declIndex).toBeGreaterThan(0);
    const preceding = lines.slice(Math.max(0, declIndex - 3), declIndex).join('\n');
    expect(preceding).not.toContain('@planned');
  });
});

describe('schemas_ReviewEscalatedData_NotMarkedPlanned', () => {
  it('schemas_ReviewEscalatedData_NotMarkedPlanned', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const schemasPath = path.resolve(import.meta.dirname, 'schemas.ts');
    const source = fs.readFileSync(schemasPath, 'utf-8');
    const lines = source.split('\n');
    const declIndex = lines.findIndex((l) => l.includes('ReviewEscalatedData'));
    expect(declIndex).toBeGreaterThan(0);
    const preceding = lines.slice(Math.max(0, declIndex - 3), declIndex).join('\n');
    expect(preceding).not.toContain('@planned');
  });
});

describe('schemas_QualityRegressionData_NotMarkedPlanned', () => {
  it('schemas_QualityRegressionData_NotMarkedPlanned', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const schemasPath = path.resolve(import.meta.dirname, 'schemas.ts');
    const source = fs.readFileSync(schemasPath, 'utf-8');
    const lines = source.split('\n');
    const declIndex = lines.findIndex((l) => l.includes('QualityRegressionData'));
    expect(declIndex).toBeGreaterThan(0);
    const preceding = lines.slice(Math.max(0, declIndex - 3), declIndex).join('\n');
    expect(preceding).not.toContain('@planned');
  });
});

// ─── Task 4: Schema validation tests ──────────────────────────────

describe('ReviewFindingData validation', () => {
  it('ReviewFindingData_ValidPayload_PassesValidation', () => {
    const payload = {
      pr: 123,
      source: 'coderabbit',
      severity: 'major',
      filePath: 'src/foo.ts',
      lineRange: [10, 20],
      message: 'Unused import',
      rule: 'no-unused-imports',
    };
    expect(ReviewFindingData.safeParse(payload).success).toBe(true);
  });
});

describe('ReviewEscalatedData validation', () => {
  it('ReviewEscalatedData_ValidPayload_PassesValidation', () => {
    const payload = {
      pr: 123,
      reason: 'Critical finding detected',
      originalScore: 0.4,
      triggeringFinding: 'SQL injection in query builder',
    };
    expect(ReviewEscalatedData.safeParse(payload).success).toBe(true);
  });
});

describe('QualityRegressionData validation', () => {
  it('QualityRegressionData_ValidPayload_PassesValidation', () => {
    const payload = {
      skill: 'delegation',
      gate: 'test-coverage',
      consecutiveFailures: 3,
      firstFailureCommit: 'abc123',
      lastFailureCommit: 'def456',
      detectedAt: new Date().toISOString(),
    };
    expect(QualityRegressionData.safeParse(payload).success).toBe(true);
  });
});

// ─── Task 5+6: Shepherd schema tests ──────────────────────────────

describe('ShepherdStartedData validation', () => {
  it('ShepherdStartedData_ValidPayload_PassesValidation', () => {
    const payload = { featureId: 'feat-001' };
    expect(ShepherdStartedData.safeParse(payload).success).toBe(true);
  });
});

describe('ShepherdIterationData validation', () => {
  it('ShepherdIterationData_ValidPayload_PassesValidation', () => {
    const payload = { iteration: 2, prsAssessed: 3, fixesApplied: 1, status: 'in-progress' };
    expect(ShepherdIterationData.safeParse(payload).success).toBe(true);
  });
});

describe('ShepherdApprovalRequestedData validation', () => {
  it('ShepherdApprovalRequestedData_ValidPayload_PassesValidation', () => {
    const payload = { prUrl: 'https://github.com/org/repo/pull/1' };
    expect(ShepherdApprovalRequestedData.safeParse(payload).success).toBe(true);
  });
});

describe('ShepherdCompletedData validation', () => {
  it('ShepherdCompletedData_ValidPayload_PassesValidation', () => {
    const payload = { prUrl: 'https://github.com/org/repo/pull/1', outcome: 'merged' };
    expect(ShepherdCompletedData.safeParse(payload).success).toBe(true);
  });
});

describe('EventType_ShepherdTypes_ExistInUnion', () => {
  it('EventType_ShepherdTypes_ExistInUnion', () => {
    const shepherdTypes = ['shepherd.started', 'shepherd.iteration', 'shepherd.approval_requested', 'shepherd.escalated', 'shepherd.completed'];
    for (const t of shepherdTypes) {
      expect(EventTypes).toContain(t);
    }
  });
});

// ─── Task 5: WorkflowEventBase max-length constraints ──────────────────────

describe('WorkflowEventBase max-length constraints', () => {
  const validBase = {
    streamId: 'test-stream',
    sequence: 1,
    type: 'workflow.started' as const,
  };

  it('WorkflowEventBase_OversizedStreamId_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      streamId: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_MaxLengthStreamId_PassesValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      streamId: 'a'.repeat(100),
    });
    expect(result.success).toBe(true);
  });

  it('WorkflowEventBase_OversizedAgentId_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      agentId: 'a'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_OversizedCorrelationId_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      correlationId: 'a'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_ValidEvent_StillPasses', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      correlationId: 'corr-123',
      causationId: 'cause-456',
      agentId: 'agent-789',
      agentRole: 'implementer',
      source: 'test-runner',
      schemaVersion: '1.0',
      idempotencyKey: 'key-abc',
      data: { key: 'value' },
    });
    expect(result.success).toBe(true);
  });

  it('WorkflowEventBase_OversizedCausationId_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      causationId: 'a'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_OversizedAgentRole_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      agentRole: 'a'.repeat(51),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_OversizedSource_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      source: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_OversizedSchemaVersion_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      schemaVersion: 'a'.repeat(21),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_OversizedIdempotencyKey_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      idempotencyKey: 'a'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_MaxLengthAgentRole_PassesValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      agentRole: 'a'.repeat(50),
    });
    expect(result.success).toBe(true);
  });

  it('WorkflowEventBase_OversizedTenantId_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      tenantId: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_MaxLengthTenantId_PassesValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      tenantId: 'a'.repeat(100),
    });
    expect(result.success).toBe(true);
  });

  it('WorkflowEventBase_OversizedOrganizationId_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      organizationId: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_MaxLengthOrganizationId_PassesValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      organizationId: 'a'.repeat(100),
    });
    expect(result.success).toBe(true);
  });

  it('WorkflowEventBase_EmptyAgentId_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      agentId: '',
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_EmptyIdempotencyKey_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      idempotencyKey: '',
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_EmptySchemaVersion_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      schemaVersion: '',
    });
    expect(result.success).toBe(false);
  });
});

// ─── Task 1: Max-length constraints on unbounded event payload fields ────────

describe('TaskProgressedData max-length constraints', () => {
  it('TaskProgressedData_MaxDetail_PassesValidation', () => {
    const data = { taskId: 'task-1', tddPhase: 'red', detail: 'a'.repeat(500) };
    expect(() => TaskProgressedData.parse(data)).not.toThrow();
  });

  it('TaskProgressedData_OversizedDetail_FailsValidation', () => {
    const data = { taskId: 'task-1', tddPhase: 'red', detail: 'a'.repeat(501) };
    expect(() => TaskProgressedData.parse(data)).toThrow();
  });
});

describe('TaskFailedData max-length constraints', () => {
  it('TaskFailedData_MaxError_PassesValidation', () => {
    const data = { taskId: 'task-1', error: 'a'.repeat(500) };
    expect(() => TaskFailedData.parse(data)).not.toThrow();
  });

  it('TaskFailedData_OversizedError_FailsValidation', () => {
    const data = { taskId: 'task-1', error: 'a'.repeat(501) };
    expect(() => TaskFailedData.parse(data)).toThrow();
  });
});

describe('EvalCaseCompletedData max-length constraints', () => {
  it('EvalCaseCompletedData_MaxAssertions_PassesValidation', () => {
    const assertions = Array.from({ length: 50 }, (_, i) => ({
      name: `assertion-${i}`, type: 'equality', passed: true, score: 1, reason: 'ok'
    }));
    const data = {
      runId: '11111111-1111-4111-8111-111111111111',
      caseId: 'case-1', suiteId: 'suite-1',
      passed: true, score: 1, assertions, duration: 100
    };
    expect(() => EvalCaseCompletedData.parse(data)).not.toThrow();
  });

  it('EvalCaseCompletedData_OversizedAssertions_FailsValidation', () => {
    const assertions = Array.from({ length: 51 }, (_, i) => ({
      name: `assertion-${i}`, type: 'equality', passed: true, score: 1, reason: 'ok'
    }));
    const data = {
      runId: '11111111-1111-4111-8111-111111111111',
      caseId: 'case-1', suiteId: 'suite-1',
      passed: true, score: 1, assertions, duration: 100
    };
    expect(() => EvalCaseCompletedData.parse(data)).toThrow();
  });
});

describe('SessionTaggedData', () => {
  it('SessionTaggedData_ValidPayload_PassesValidation', () => {
    const data = { tag: 'feature-auth', sessionId: 'sess-123' };
    const result = SessionTaggedData.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('SessionTaggedData_WithOptionalFields_PassesValidation', () => {
    const data = {
      tag: 'feature-auth',
      sessionId: 'sess-123',
      description: 'Adding JWT token validation',
      branch: 'main',
    };
    const result = SessionTaggedData.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe('Adding JWT token validation');
      expect(result.data.branch).toBe('main');
    }
  });

  it('SessionTaggedData_MissingTag_FailsValidation', () => {
    const data = { sessionId: 'sess-123' };
    const result = SessionTaggedData.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('SessionTaggedData_MissingSessionId_FailsValidation', () => {
    const data = { tag: 'feature-auth' };
    const result = SessionTaggedData.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('SessionTaggedData_OversizedTag_FailsValidation', () => {
    const data = { tag: 'a'.repeat(101), sessionId: 'sess-123' };
    const result = SessionTaggedData.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('SessionTaggedData_OversizedDescription_FailsValidation', () => {
    const data = { tag: 'feature-auth', sessionId: 'sess-123', description: 'a'.repeat(501) };
    const result = SessionTaggedData.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('sessionTaggedEvent_ValidPayload_ParsesAsBaseEvent', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'tags',
      sequence: 1,
      type: 'session.tagged',
      data: { tag: 'feature-auth', sessionId: 'sess-123' },
    });
    expect(event.success).toBe(true);
  });
});

// ─── Readiness Event Types ──────────────────────────────────────────────────

describe('Readiness EventTypes', () => {
  it('EventTypes_Contains_WorktreeCreated', () => {
    expect(EventTypes).toContain('worktree.created');
  });

  it('EventTypes_Contains_WorktreeBaseline', () => {
    expect(EventTypes).toContain('worktree.baseline');
  });

  it('EventTypes_Contains_TestResult', () => {
    expect(EventTypes).toContain('test.result');
  });

  it('EventTypes_Contains_TypecheckResult', () => {
    expect(EventTypes).toContain('typecheck.result');
  });

  it('EventTypes_Contains_StackSubmitted', () => {
    expect(EventTypes).toContain('stack.submitted');
  });

  it('EventTypes_Contains_CiStatus', () => {
    expect(EventTypes).toContain('ci.status');
  });

  it('EventTypes_Contains_CommentPosted', () => {
    expect(EventTypes).toContain('comment.posted');
  });

  it('EventTypes_Contains_CommentResolved', () => {
    expect(EventTypes).toContain('comment.resolved');
  });
});

// ─── WorktreeCreatedData ────────────────────────────────────────────────────

describe('WorktreeCreatedData', () => {
  it('WorktreeCreatedData_ValidPayload_Parses', () => {
    const result = WorktreeCreatedData.safeParse({
      taskId: 'task-001',
      path: '/tmp/.worktrees/wt-001',
      branch: 'feature/task-001',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.taskId).toBe('task-001');
      expect(result.data.path).toBe('/tmp/.worktrees/wt-001');
      expect(result.data.branch).toBe('feature/task-001');
    }
  });

  it('WorktreeCreatedData_MissingFields_Rejects', () => {
    const result = WorktreeCreatedData.safeParse({
      taskId: 'task-001',
      // missing path and branch
    });
    expect(result.success).toBe(false);
  });
});

// ─── WorktreeBaselineData ───────────────────────────────────────────────────

describe('WorktreeBaselineData', () => {
  it('WorktreeBaselineData_ValidPayload_Parses', () => {
    const result = WorktreeBaselineData.safeParse({
      taskId: 'task-001',
      path: '/tmp/.worktrees/wt-001',
      status: 'passed',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.taskId).toBe('task-001');
      expect(result.data.status).toBe('passed');
    }
  });

  it('WorktreeBaselineData_WithOptionalOutput_Parses', () => {
    const result = WorktreeBaselineData.safeParse({
      taskId: 'task-001',
      path: '/tmp/.worktrees/wt-001',
      status: 'failed',
      output: 'Build error on line 42',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.output).toBe('Build error on line 42');
    }
  });

  it('WorktreeBaselineData_InvalidStatus_Rejects', () => {
    const result = WorktreeBaselineData.safeParse({
      taskId: 'task-001',
      path: '/tmp/.worktrees/wt-001',
      status: 'unknown',
    });
    expect(result.success).toBe(false);
  });

  it('WorktreeBaselineData_MissingFields_Rejects', () => {
    const result = WorktreeBaselineData.safeParse({
      taskId: 'task-001',
      // missing path and status
    });
    expect(result.success).toBe(false);
  });
});

// ─── TestResultData ─────────────────────────────────────────────────────────

describe('TestResultData', () => {
  it('TestResultData_ValidPayload_Parses', () => {
    const result = TestResultData.safeParse({
      passed: true,
      passCount: 42,
      failCount: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
      expect(result.data.passCount).toBe(42);
      expect(result.data.failCount).toBe(0);
    }
  });

  it('TestResultData_WithOptionalFields_Parses', () => {
    const result = TestResultData.safeParse({
      passed: false,
      passCount: 38,
      failCount: 4,
      coveragePercent: 87.5,
      output: 'FAIL src/utils.test.ts',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.coveragePercent).toBe(87.5);
      expect(result.data.output).toBe('FAIL src/utils.test.ts');
    }
  });

  it('TestResultData_MissingFields_Rejects', () => {
    const result = TestResultData.safeParse({
      passed: true,
      // missing passCount and failCount
    });
    expect(result.success).toBe(false);
  });
});

// ─── TypecheckResultData ────────────────────────────────────────────────────

describe('TypecheckResultData', () => {
  it('TypecheckResultData_ValidPayload_Parses', () => {
    const result = TypecheckResultData.safeParse({
      passed: true,
      errorCount: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
      expect(result.data.errorCount).toBe(0);
    }
  });

  it('TypecheckResultData_WithErrors_Parses', () => {
    const result = TypecheckResultData.safeParse({
      passed: false,
      errorCount: 2,
      errors: ['TS2322: Type string not assignable to number', 'TS2304: Cannot find name foo'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.errors).toHaveLength(2);
    }
  });

  it('TypecheckResultData_MissingFields_Rejects', () => {
    const result = TypecheckResultData.safeParse({
      passed: true,
      // missing errorCount
    });
    expect(result.success).toBe(false);
  });
});

// ─── StackSubmittedData ─────────────────────────────────────────────────────

describe('StackSubmittedData', () => {
  it('StackSubmittedData_ValidPayload_Parses', () => {
    const result = StackSubmittedData.safeParse({
      branches: ['feature/task-001', 'feature/task-002'],
      prNumbers: [101, 102],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branches).toEqual(['feature/task-001', 'feature/task-002']);
      expect(result.data.prNumbers).toEqual([101, 102]);
    }
  });

  it('StackSubmittedData_MissingFields_Rejects', () => {
    const result = StackSubmittedData.safeParse({
      branches: ['feature/task-001'],
      // missing prNumbers
    });
    expect(result.success).toBe(false);
  });
});

// ─── CiStatusData ───────────────────────────────────────────────────────────

describe('CiStatusData', () => {
  it('CiStatusData_ValidPayload_Parses', () => {
    const result = CiStatusData.safeParse({
      pr: 101,
      status: 'passing',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pr).toBe(101);
      expect(result.data.status).toBe('passing');
    }
  });

  it('CiStatusData_WithJobUrl_Parses', () => {
    const result = CiStatusData.safeParse({
      pr: 101,
      status: 'failing',
      jobUrl: 'https://github.com/org/repo/actions/runs/123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jobUrl).toBe('https://github.com/org/repo/actions/runs/123');
    }
  });

  it('CiStatusData_InvalidStatus_Rejects', () => {
    const result = CiStatusData.safeParse({
      pr: 101,
      status: 'unknown',
    });
    expect(result.success).toBe(false);
  });

  it('CiStatusData_MissingFields_Rejects', () => {
    const result = CiStatusData.safeParse({
      // missing pr and status
    });
    expect(result.success).toBe(false);
  });
});

// ─── CommentPostedData ──────────────────────────────────────────────────────

describe('CommentPostedData', () => {
  it('CommentPostedData_ValidPayload_Parses', () => {
    const result = CommentPostedData.safeParse({
      pr: 101,
      commentId: 'ic_123',
      body: 'LGTM',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pr).toBe(101);
      expect(result.data.commentId).toBe('ic_123');
      expect(result.data.body).toBe('LGTM');
    }
  });

  it('CommentPostedData_WithInReplyTo_Parses', () => {
    const result = CommentPostedData.safeParse({
      pr: 101,
      commentId: 'ic_124',
      body: 'Fixed in latest push',
      inReplyTo: 'ic_123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inReplyTo).toBe('ic_123');
    }
  });

  it('CommentPostedData_MissingFields_Rejects', () => {
    const result = CommentPostedData.safeParse({
      pr: 101,
      // missing commentId and body
    });
    expect(result.success).toBe(false);
  });
});

// ─── CommentResolvedData ────────────────────────────────────────────────────

describe('CommentResolvedData', () => {
  it('CommentResolvedData_ValidPayload_Parses', () => {
    const result = CommentResolvedData.safeParse({
      pr: 101,
      threadId: 'thread-abc',
      resolvedBy: 'author',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pr).toBe(101);
      expect(result.data.threadId).toBe('thread-abc');
      expect(result.data.resolvedBy).toBe('author');
    }
  });

  it('CommentResolvedData_InvalidResolvedBy_Rejects', () => {
    const result = CommentResolvedData.safeParse({
      pr: 101,
      threadId: 'thread-abc',
      resolvedBy: 'bot',
    });
    expect(result.success).toBe(false);
  });

  it('CommentResolvedData_MissingFields_Rejects', () => {
    const result = CommentResolvedData.safeParse({
      pr: 101,
      // missing threadId and resolvedBy
    });
    expect(result.success).toBe(false);
  });
});

// ─── Modified StackRestackedData ────────────────────────────────────────────

describe('StackRestackedData (updated)', () => {
  it('StackRestackedData_NewFields_Parses', () => {
    const result = StackRestackedData.safeParse({
      branches: ['feature/task-001', 'feature/task-002'],
      conflicts: false,
      reconstructed: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branches).toEqual(['feature/task-001', 'feature/task-002']);
      expect(result.data.conflicts).toBe(false);
      expect(result.data.reconstructed).toBe(true);
    }
  });

  it('StackRestackedData_OldFields_Rejects', () => {
    const result = StackRestackedData.safeParse({
      affectedPositions: [1, 2, 3],
    });
    expect(result.success).toBe(false);
  });
});

// ─── Modified ShepherdIterationData ─────────────────────────────────────────

describe('ShepherdIterationData (updated)', () => {
  it('ShepherdIterationData_NewFields_Parses', () => {
    const result = ShepherdIterationData.safeParse({
      iteration: 2,
      prsAssessed: 3,
      fixesApplied: 1,
      status: 'in-progress',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.iteration).toBe(2);
      expect(result.data.prsAssessed).toBe(3);
      expect(result.data.fixesApplied).toBe(1);
      expect(result.data.status).toBe('in-progress');
    }
  });

  it('ShepherdIterationData_OldFields_Rejects', () => {
    const result = ShepherdIterationData.safeParse({
      prUrl: 'https://github.com/org/repo/pull/1',
      iteration: 2,
      action: 'fix-ci',
      outcome: 'resolved',
    });
    expect(result.success).toBe(false);
  });
});

// ─── T8: team.context.injected removal ──────────────────────────────────────

describe('EventTypes_DoesNotInclude_TeamContextInjected', () => {
  it('EventTypes_DoesNotInclude_TeamContextInjected', () => {
    expect(EventTypes).not.toContain('team.context.injected');
  });

  it('EVENT_EMISSION_REGISTRY_DoesNotInclude_TeamContextInjected', () => {
    expect(EVENT_EMISSION_REGISTRY).not.toHaveProperty('team.context.injected');
  });

  it('EVENT_DATA_SCHEMAS_DoesNotInclude_TeamContextInjected', () => {
    expect(EVENT_DATA_SCHEMAS).not.toHaveProperty('team.context.injected');
  });
});

// ─── T9: registerEventType / unregisterEventType / getValidEventTypes ────

describe('registerEventType', () => {
  afterEach(() => {
    // Clean up any custom event types registered during tests
    try { unregisterEventType('deploy.started'); } catch { /* ignore */ }
    try { unregisterEventType('deploy.finished'); } catch { /* ignore */ }
    try { unregisterEventType('custom.hello'); } catch { /* ignore */ }
  });

  it('RegisterEventType_CustomType_AddsToValidEventTypes', () => {
    registerEventType('deploy.started', { source: 'model' });

    const valid = getValidEventTypes();
    expect(valid).toContain('deploy.started');
  });

  it('RegisterEventType_BuiltInType_ThrowsCollisionError', () => {
    expect(() =>
      registerEventType('workflow.started', { source: 'auto' }),
    ).toThrow(/built-in/i);
  });

  it('RegisterEventType_DuplicateCustomType_Throws', () => {
    registerEventType('deploy.started', { source: 'model' });

    expect(() =>
      registerEventType('deploy.started', { source: 'hook' }),
    ).toThrow(/already registered/i);
  });

  it('RegisterEventType_InvalidNameFormat_Throws', () => {
    // No dot separator
    expect(() =>
      registerEventType('nodot', { source: 'model' }),
    ).toThrow(/dot separator/i);

    // Uppercase
    expect(() =>
      registerEventType('Deploy.Started', { source: 'model' }),
    ).toThrow(/lowercase/i);

    // Empty
    expect(() =>
      registerEventType('', { source: 'model' }),
    ).toThrow();
  });

  it('RegisterEventType_WithSchema_RegistersInDataSchemas', () => {
    const schema = z.object({ url: z.string() });
    registerEventType('deploy.started', { source: 'hook', schema });

    // The schema should be accessible in EVENT_DATA_SCHEMAS
    expect(EVENT_DATA_SCHEMAS['deploy.started']).toBe(schema);
  });

  it('RegisterEventType_WithSource_RegistersInEmissionRegistry', () => {
    registerEventType('deploy.started', { source: 'hook' });

    expect(EVENT_EMISSION_REGISTRY['deploy.started']).toBe('hook');
  });
});

describe('unregisterEventType', () => {
  afterEach(() => {
    try { unregisterEventType('deploy.started'); } catch { /* ignore */ }
  });

  it('UnregisterEventType_CustomType_RemovesIt', () => {
    registerEventType('deploy.started', { source: 'model' });
    expect(getValidEventTypes()).toContain('deploy.started');

    unregisterEventType('deploy.started');
    expect(getValidEventTypes()).not.toContain('deploy.started');
  });

  it('UnregisterEventType_BuiltInType_Throws', () => {
    expect(() =>
      unregisterEventType('workflow.started'),
    ).toThrow(/built-in/i);
  });
});

describe('getValidEventTypes', () => {
  afterEach(() => {
    try { unregisterEventType('custom.hello'); } catch { /* ignore */ }
  });

  it('GetValidEventTypes_ReturnsBuiltInPlusCustom', () => {
    const beforeCount = getValidEventTypes().length;

    registerEventType('custom.hello', { source: 'model' });

    const after = getValidEventTypes();
    expect(after.length).toBe(beforeCount + 1);
    expect(after).toContain('custom.hello');

    // All built-in types should still be present
    for (const builtIn of EventTypes) {
      expect(after).toContain(builtIn);
    }
  });
});

describe('isBuiltInEventType', () => {
  it('IsBuiltInEventType_BuiltInType_ReturnsTrue', () => {
    expect(isBuiltInEventType('workflow.started')).toBe(true);
    expect(isBuiltInEventType('task.completed')).toBe(true);
  });

  it('IsBuiltInEventType_CustomType_ReturnsFalse', () => {
    expect(isBuiltInEventType('deploy.started')).toBe(false);
  });
});

// ─── serializeEventCatalog ──────────────────────────────────────────────────

describe('serializeEventCatalog', () => {
  it('SerializeEventCatalog_ReturnsAllBuiltInEventTypes', () => {
    const catalog = serializeEventCatalog();
    for (const eventType of EventTypes) {
      expect(catalog.types).toHaveProperty(eventType);
    }
  });

  it('SerializeEventCatalog_IncludesEmissionSource', () => {
    const catalog = serializeEventCatalog();
    expect(catalog.types['workflow.started'].source).toBe('auto');
    expect(catalog.types['team.spawned'].source).toBe('model');
  });

  it('SerializeEventCatalog_GroupsBySource', () => {
    const catalog = serializeEventCatalog();
    expect(catalog.bySource.auto).toContain('workflow.started');
    expect(catalog.bySource.model).toContain('team.spawned');
  });

  it('SerializeEventCatalog_IncludesBuiltInFlag', () => {
    const catalog = serializeEventCatalog();
    expect(catalog.types['workflow.started'].isBuiltIn).toBe(true);
    expect(catalog.types['task.completed'].isBuiltIn).toBe(true);
    expect(catalog.types['team.spawned'].isBuiltIn).toBe(true);
  });

  it('SerializeEventCatalog_IncludesHasSchemaFlag', () => {
    const catalog = serializeEventCatalog();
    // task.completed has a schema in EVENT_DATA_SCHEMAS
    expect(catalog.types['task.completed'].hasSchema).toBe(true);
    // state.patched does NOT have a schema in EVENT_DATA_SCHEMAS
    expect(catalog.types['state.patched'].hasSchema).toBe(false);
  });

  it('SerializeEventCatalog_TotalCount_MatchesTypeCount', () => {
    const catalog = serializeEventCatalog();
    expect(catalog.totalCount).toBe(Object.keys(catalog.types).length);
  });
});

// ─── Task 005/006: Model-emitted event schema description drift tests ────────

describe('Model-emitted event schema descriptions', () => {
  // Get all model-emitted event types
  const modelEmittedTypes = Object.entries(EVENT_EMISSION_REGISTRY)
    .filter(([, source]) => source === 'model')
    .map(([type]) => type);

  /** Narrowing helper for JSON Schema property objects. */
  interface JsonSchemaProperty {
    properties?: Record<string, { description?: string }>;
  }

  function isJsonSchemaWithProperties(
    value: unknown,
  ): value is Required<JsonSchemaProperty> {
    return (
      typeof value === 'object' &&
      value !== null &&
      'properties' in value &&
      typeof (value as JsonSchemaProperty).properties === 'object'
    );
  }

  it('modelEmittedEventSchemas_AllFields_HaveDescriptions', () => {
    const missing: string[] = [];

    for (const eventType of modelEmittedTypes) {
      const schema = (EVENT_DATA_SCHEMAS as Record<string, unknown>)[eventType];
      if (!schema) continue; // skip types without schemas

      const jsonSchema: unknown = zodToJsonSchema(schema as z.ZodSchema);
      if (!isJsonSchemaWithProperties(jsonSchema)) continue;

      for (const [field, fieldSchema] of Object.entries(jsonSchema.properties)) {
        if (!fieldSchema.description) {
          missing.push(`${eventType}.${field}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('modelEmittedEventSchemas_Descriptions_AreReasonableLength', () => {
    const issues: string[] = [];

    for (const eventType of modelEmittedTypes) {
      const schema = (EVENT_DATA_SCHEMAS as Record<string, unknown>)[eventType];
      if (!schema) continue;

      const jsonSchema: unknown = zodToJsonSchema(schema as z.ZodSchema);
      if (!isJsonSchemaWithProperties(jsonSchema)) continue;

      for (const [field, fieldSchema] of Object.entries(jsonSchema.properties)) {
        const desc = fieldSchema.description;
        if (desc && (desc.length < 5 || desc.length > 80)) {
          issues.push(`${eventType}.${field}: ${desc.length} chars`);
        }
      }
    }

    expect(issues).toEqual([]);
  });
});

// ─── DR-6: review.completed event type ──────────────────────────────────────

describe('review.completed event type', () => {
  it('EventTypes_ContainsReviewCompleted', () => {
    expect(EventTypes).toContain('review.completed');
  });

  it('ReviewCompletedSchema_ValidData_Passes', async () => {
    const schemas = await import('./schemas.js');
    const ReviewCompletedData = (schemas as Record<string, z.ZodSchema>)['ReviewCompletedData'];
    expect(ReviewCompletedData).toBeDefined();
    const result = ReviewCompletedData.safeParse({
      stage: 'spec-review',
      verdict: 'pass',
      findingsCount: 0,
      summary: 'All checks passed',
    });
    expect(result.success).toBe(true);
  });

  it('ReviewCompletedSchema_InvalidVerdict_Fails', async () => {
    const schemas = await import('./schemas.js');
    const ReviewCompletedData = (schemas as Record<string, z.ZodSchema>)['ReviewCompletedData'];
    expect(ReviewCompletedData).toBeDefined();
    const result = ReviewCompletedData.safeParse({
      stage: 'spec-review',
      verdict: 'maybe',
      findingsCount: 0,
      summary: 'All checks passed',
    });
    expect(result.success).toBe(false);
  });

  it('EventEmissionRegistry_ReviewCompleted_IsModelSource', () => {
    expect(
      (EVENT_EMISSION_REGISTRY as Record<string, string>)['review.completed'],
    ).toBe('model');
  });
});

// ─── TaskCompletedData acceptanceTestRef (DR-4) ────────────────────────────

describe('TaskCompletedData acceptanceTestRef', () => {
  it('TaskCompletedData_WithAcceptanceTestRef_ParsesSuccessfully', () => {
    const result = TaskCompletedData.safeParse({
      taskId: 'T-001',
      acceptanceTestRef: 'T-000',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.acceptanceTestRef).toBe('T-000');
    }
  });

  it('TaskCompletedData_WithoutAcceptanceTestRef_StillParses', () => {
    const result = TaskCompletedData.safeParse({
      taskId: 'T-001',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.acceptanceTestRef).toBeUndefined();
    }
  });
});

// ─── T1: workflow.pruned event type ─────────────────────────────────────────

describe('WorkflowPrunedData', () => {
  it('eventSchema_workflowPruned_acceptsValidPayload', () => {
    const result = WorkflowPrunedData.safeParse({
      featureId: 'stale-feature',
      stalenessMinutes: 10080,
      triggeredBy: 'manual',
      skippedSafeguards: ['open-pr'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.featureId).toBe('stale-feature');
      expect(result.data.stalenessMinutes).toBe(10080);
      expect(result.data.triggeredBy).toBe('manual');
      expect(result.data.skippedSafeguards).toEqual(['open-pr']);
    }
  });

  it('eventSchema_workflowPruned_acceptsPayloadWithoutSkippedSafeguards', () => {
    const result = WorkflowPrunedData.safeParse({
      featureId: 'stale-feature',
      stalenessMinutes: 60,
      triggeredBy: 'scheduled',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skippedSafeguards).toBeUndefined();
    }
  });

  it('eventSchema_workflowPruned_rejectsMissingFeatureId', () => {
    const result = WorkflowPrunedData.safeParse({
      stalenessMinutes: 60,
      triggeredBy: 'manual',
    });
    expect(result.success).toBe(false);
  });

  it('eventSchema_workflowPruned_rejectsInvalidTriggeredBy', () => {
    const result = WorkflowPrunedData.safeParse({
      featureId: 'stale-feature',
      stalenessMinutes: 60,
      triggeredBy: 'automatic',
    });
    expect(result.success).toBe(false);
  });

  it('eventSchema_workflowPruned_isRegisteredInEventTypeUnion', () => {
    expect(EventTypes).toContain('workflow.pruned');
  });

  it('eventSchema_workflowPruned_hasEmissionSourceClassification', () => {
    expect(EVENT_EMISSION_REGISTRY).toHaveProperty('workflow.pruned');
  });

  it('eventSchema_workflowPruned_isListedInEventDataSchemas', () => {
    expect(EVENT_DATA_SCHEMAS['workflow.pruned']).toBeDefined();
  });
});

// ─── T2: synthesize.requested event type ────────────────────────────────────

describe('SynthesizeRequestedData', () => {
  it('eventSchema_synthesizeRequested_acceptsValidPayload', () => {
    const result = SynthesizeRequestedData.safeParse({
      featureId: 'feat-1',
      reason: 'user requested PR instead of direct commit',
      timestamp: '2026-04-11T12:00:00Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.featureId).toBe('feat-1');
      expect(result.data.reason).toBe('user requested PR instead of direct commit');
      expect(result.data.timestamp).toBe('2026-04-11T12:00:00Z');
    }
  });

  it('eventSchema_synthesizeRequested_acceptsPayloadWithoutReason', () => {
    const result = SynthesizeRequestedData.safeParse({
      featureId: 'feat-1',
      timestamp: '2026-04-11T12:00:00Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBeUndefined();
    }
  });

  it('eventSchema_synthesizeRequested_rejectsMissingFeatureId', () => {
    const result = SynthesizeRequestedData.safeParse({
      timestamp: '2026-04-11T12:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('eventSchema_synthesizeRequested_rejectsMissingTimestamp', () => {
    const result = SynthesizeRequestedData.safeParse({
      featureId: 'feat-1',
    });
    expect(result.success).toBe(false);
  });

  it('eventSchema_synthesizeRequested_isRegisteredInEventTypeUnion', () => {
    expect(EventTypes).toContain('synthesize.requested');
  });

  it('eventSchema_synthesizeRequested_hasEmissionSourceClassification', () => {
    expect(EVENT_EMISSION_REGISTRY).toHaveProperty('synthesize.requested');
  });

  it('eventSchema_synthesizeRequested_isListedInEventDataSchemas', () => {
    expect(EVENT_DATA_SCHEMAS['synthesize.requested']).toBeDefined();
  });
});

// ─── diagnostic.executed (exarchos doctor) ──────────────────────────────────

describe('diagnostic.executed event', () => {
  it('EventSchema_DiagnosticExecuted_ParsesSuccessfully', () => {
    expect(EventTypes).toContain('diagnostic.executed');

    const schema = EVENT_DATA_SCHEMAS['diagnostic.executed' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const valid = {
      summary: { passed: 3, warnings: 1, failed: 0, skipped: 1 },
      checkCount: 5,
      failedCheckNames: [],
      durationMs: 42,
    };

    const result = schema!.safeParse(valid);
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('EventSchema_DiagnosticExecuted_MissingSummary_ThrowsValidationError', () => {
    const schema = EVENT_DATA_SCHEMAS['diagnostic.executed' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const invalid = {
      checkCount: 5,
      failedCheckNames: [],
      durationMs: 42,
    };

    const result = schema!.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

// ─── workflow.checkpoint_requested (T005, DR-4) ─────────────────────────────

describe('WorkflowCheckpointRequestedData', () => {
  it('CheckpointRequested_ValidData_Parses', () => {
    const result = WorkflowCheckpointRequestedData.safeParse({
      trigger: 'manual',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trigger).toBe('manual');
    }
  });

  it('CheckpointRequested_UnknownTrigger_Rejects', () => {
    const result = WorkflowCheckpointRequestedData.safeParse({
      trigger: 'auto-cadence',
    });
    expect(result.success).toBe(false);
  });
});

// ─── workflow.checkpoint_written (T006, DR-4) ───────────────────────────────

describe('WorkflowCheckpointWrittenData', () => {
  it('CheckpointWritten_ValidData_Parses', () => {
    // DR-4: { projectionId: string, projectionSequence: number, byteSize: number }
    // Emitted after projection materialized + snapshot written, closing the
    // checkpoint_requested → checkpoint_written loop.
    expect(EventTypes).toContain('workflow.checkpoint_written');

    const schema = EVENT_DATA_SCHEMAS['workflow.checkpoint_written' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionId: 'rehydrate-foundation',
      projectionSequence: 42,
      byteSize: 1024,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });
});

// ─── workflow.checkpoint_superseded (T007, DR-4) ────────────────────────────

describe('WorkflowCheckpointSupersededData', () => {
  it('CheckpointSuperseded_ValidData_Parses', () => {
    // DR-4: { priorSequence: number, reason: string }
    // Emitted when a newer checkpoint supersedes an earlier one — the
    // priorSequence references the projectionSequence of the checkpoint
    // now invalidated, and the reason explains why (e.g., 'stale-projection',
    // 'schema-version-bump').
    expect(EventTypes).toContain('workflow.checkpoint_superseded');

    const schema = EVENT_DATA_SCHEMAS['workflow.checkpoint_superseded' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      priorSequence: 41,
      reason: 'stale-projection',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });
});

// ─── workflow.rehydrated (T008, DR-4) ───────────────────────────────────────

describe('WorkflowRehydratedData', () => {
  it('Rehydrated_ValidData_Parses', () => {
    // DR-4: { projectionSequence: number, deliveryPath: "direct"|"ndjson"|"snapshot", tokenEstimate: number }
    // Emitted when a workflow projection is rehydrated into a session. The
    // projectionSequence identifies the restored checkpoint, deliveryPath
    // records the transport (direct embed, streamed ndjson, or snapshot read),
    // and tokenEstimate captures the approximate context cost of delivery.
    expect(EventTypes).toContain('workflow.rehydrated');

    const schema = EVENT_DATA_SCHEMAS['workflow.rehydrated' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionSequence: 42,
      deliveryPath: 'direct',
      tokenEstimate: 1500,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('Rehydrated_InvalidDeliveryPath_Rejects', () => {
    // deliveryPath must be one of: "direct" | "ndjson" | "snapshot".
    // An unknown value is rejected by the z.enum() validator.
    const schema = EVENT_DATA_SCHEMAS['workflow.rehydrated' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionSequence: 42,
      deliveryPath: 'telepathy',
      tokenEstimate: 1500,
    });
    expect(result.success).toBe(false);
  });

  // T-10: optional playbook fields (phaseHasPlaybook, phasePlaybookComposed)

  it('Rehydrated_LegacyPayload_ParsesWithoutPlaybookFields', () => {
    // Legacy events emitted before T-10 lack both optional fields.
    // The schema must remain backward-compatible — absence of the fields is valid.
    const schema = EVENT_DATA_SCHEMAS['workflow.rehydrated' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionSequence: 7,
      deliveryPath: 'snapshot',
      tokenEstimate: 800,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('Rehydrated_BothPlaybookFieldsTrue_Parses', () => {
    // T-10: phaseHasPlaybook and phasePlaybookComposed are both present and true.
    // This is the "playbook found and composed" path.
    const schema = EVENT_DATA_SCHEMAS['workflow.rehydrated' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionSequence: 42,
      deliveryPath: 'direct',
      tokenEstimate: 1500,
      phaseHasPlaybook: true,
      phasePlaybookComposed: true,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('Rehydrated_AsymmetricPlaybookFields_Parses', () => {
    // T-10: phaseHasPlaybook=true, phasePlaybookComposed=false.
    // Playbook exists but was not composed into the envelope (e.g. suppressed).
    const schema = EVENT_DATA_SCHEMAS['workflow.rehydrated' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionSequence: 42,
      deliveryPath: 'ndjson',
      tokenEstimate: 2000,
      phaseHasPlaybook: true,
      phasePlaybookComposed: false,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('Rehydrated_PlaybookFieldStringValue_Rejects', () => {
    // T-10: phaseHasPlaybook must be boolean — string "yes" is rejected.
    const schema = EVENT_DATA_SCHEMAS['workflow.rehydrated' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionSequence: 42,
      deliveryPath: 'direct',
      tokenEstimate: 1500,
      phaseHasPlaybook: 'yes',
    });
    expect(result.success).toBe(false);
  });
});

// ─── workflow.snapshot_taken (T009, DR-4) ───────────────────────────────────

describe('WorkflowSnapshotTakenData', () => {
  it('SnapshotTaken_ValidData_Parses', () => {
    // DR-4: { projectionId: string, sequence: number }
    // Emitted when a workflow projection snapshot is persisted. The
    // projectionId identifies the projection being snapshotted, and the
    // sequence records the projection sequence captured by the snapshot —
    // later rehydration can skip replaying events up to that sequence.
    expect(EventTypes).toContain('workflow.snapshot_taken');

    const schema = EVENT_DATA_SCHEMAS['workflow.snapshot_taken' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionId: 'proj-001',
      sequence: 42,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });
});

// ─── workflow.projection_degraded (T010, DR-4, DR-18) ───────────────────────

describe('WorkflowProjectionDegradedData', () => {
  it('ProjectionDegraded_ValidData_Parses', () => {
    // DR-4, DR-18: { projectionId: string, cause: string, fallbackSource: string }
    // Emitted when workflow projection rehydration is degraded (e.g.
    // reducer throw, corrupt snapshot, missing event stream). The cause
    // records why the degraded path was taken, and fallbackSource identifies
    // the alternative data source that serviced the request (e.g.
    // "state-store-only", "full-replay").
    expect(EventTypes).toContain('workflow.projection_degraded');

    const schema = EVENT_DATA_SCHEMAS['workflow.projection_degraded' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionId: 'proj-001',
      cause: 'reducer-throw',
      fallbackSource: 'state-store-only',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('ProjectionDegraded_ExposedInEmissionGuide_True', () => {
    // DR-18: projection_degraded is a server-emitted degradation signal.
    // It must be registered in EVENT_EMISSION_REGISTRY (the emission-guide
    // enumeration) with an 'auto' source, matching the T005
    // workflow.checkpoint_requested precedent for infrastructure-emitted events.
    expect(EVENT_EMISSION_REGISTRY).toHaveProperty('workflow.projection_degraded');
    expect(EVENT_EMISSION_REGISTRY['workflow.projection_degraded']).toBe('auto');

    // Also surface via the serializeEventCatalog emission guide output.
    const catalog = serializeEventCatalog();
    expect(catalog.bySource.auto).toContain('workflow.projection_degraded');
  });
});

// ─── T03: merge.preflight / merge.executed / merge.rollback (DR-MO-2) ───────

describe('MergePreflightData', () => {
  it('MergePreflightEventSchema_ValidPayload_Parses', () => {
    // DR-MO-2: merge.preflight payload — captures the preflight outcome for
    // a candidate merge. Preflight failures DO NOT route through merge.rollback;
    // they surface as `phase: 'aborted'` with `abortReason: 'preflight-failed'`.
    expect(EventTypes).toContain('merge.preflight');

    const schema = EVENT_DATA_SCHEMAS['merge.preflight' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = MergePreflightData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      passed: true,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.taskId).toBe('T11');
      expect(result.data.sourceBranch).toBe('feat/x');
      expect(result.data.targetBranch).toBe('main');
      expect(result.data.passed).toBe(true);
    }
  });

  it('MergePreflightEventSchema_NestedSubResults_RoundTrip', () => {
    // DR-MO-1 AC#1: the structured guard sub-results (ancestry, worktree,
    // currentBranchProtection, drift) must round-trip through the event
    // schema so event-sourced timeline reconstruction works without
    // reading the workflow state file.
    const payload = {
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      passed: false,
      ancestry: {
        passed: false,
        reason: 'ancestry' as const,
        missing: ['main'],
      },
      currentBranchProtection: {
        blocked: false,
      },
      worktree: {
        isMain: true,
        actual: '/repo',
        expected: '/repo',
      },
      drift: {
        clean: true,
        uncommittedFiles: [],
        indexStale: false,
        detachedHead: false,
      },
      failureReasons: ['ancestry missing: main'],
    };
    const result = MergePreflightData.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.ancestry?.missing).toEqual(['main']);
      expect(result.data.worktree?.isMain).toBe(true);
      expect(result.data.drift?.clean).toBe(true);
      expect(result.data.currentBranchProtection?.blocked).toBe(false);
      expect(result.data.failureReasons).toEqual(['ancestry missing: main']);
    }
  });

  it('MergePreflightEventSchema_LegacyPayloadWithoutSubResults_StillParses', () => {
    // Backward-compatibility: events emitted before the schema widening
    // omit the nested sub-results. They must still parse.
    const result = MergePreflightData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      passed: true,
    });
    expect(result.success).toBe(true);
  });

  // ─── #1362 phase 1 — optional debug branch ────────────────────────────
  //
  // The Windows ancestry-mismatch instrumentation attaches a structured
  // `debug` block to `merge.preflight` events when
  // `EXARCHOS_PREFLIGHT_DEBUG=1` AND ancestry failed. The branch is
  // `.optional()` so:
  //   1. legacy events emitted without it remain parseable
  //      (`MergePreflightData_WithoutDebugBlock_ValidatesAgainstSchema`).
  //   2. new events carrying the full payload also parse
  //      (`MergePreflightData_WithDebugBlock_ValidatesAgainstSchema`).
  it('MergePreflightData_WithoutDebugBlock_ValidatesAgainstSchema', () => {
    const result = MergePreflightData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      passed: false,
      ancestry: { passed: false, reason: 'ancestry', missing: ['main'] },
      currentBranchProtection: { blocked: false },
      worktree: { isMain: true, actual: '/repo', expected: '/repo' },
      drift: {
        clean: true,
        uncommittedFiles: [],
        indexStale: false,
        detachedHead: false,
      },
      failureReasons: ['ancestry missing: main'],
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('MergePreflightData_WithDebugBlock_ValidatesAgainstSchema', () => {
    const result = MergePreflightData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      passed: false,
      ancestry: { passed: false, reason: 'ancestry', missing: ['main'] },
      currentBranchProtection: { blocked: false },
      worktree: { isMain: true, actual: '/repo', expected: '/repo' },
      drift: {
        clean: true,
        uncommittedFiles: [],
        indexStale: false,
        detachedHead: false,
      },
      failureReasons: ['ancestry missing: main'],
      debug: {
        gitVersion: 'git version 2.45.1',
        repoRoot: 'C:\\repos\\example',
        worktreeList: 'worktree C:/repos/example\nHEAD a\nbranch refs/heads/main\n',
        refsHeadsSource: { sha: 'a'.repeat(40), packed: false },
        refsHeadsTarget: { sha: 'b'.repeat(40), packed: false },
        mergeBaseCommand: ['git', 'merge-base', '--is-ancestor', 'main', 'feat/x'],
        mergeBaseExitCode: 1,
        mergeBaseStdout: '',
        mergeBaseStderr: '',
      },
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.debug?.gitVersion).toBe('git version 2.45.1');
      expect(result.data.debug?.refsHeadsSource.packed).toBe(false);
      expect(result.data.debug?.mergeBaseExitCode).toBe(1);
    }
  });
});

describe('MergeExecutedData', () => {
  it('MergeExecutedEventSchema_ValidPayload_Parses', () => {
    // DR-MO-2: merge.executed payload — records the post-merge SHA along with
    // the rollbackSha (the parent commit on the target branch prior to merge)
    // so a subsequent rollback handler can `git reset --hard <rollbackSha>`.
    expect(EventTypes).toContain('merge.executed');

    const schema = EVENT_DATA_SCHEMAS['merge.executed' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = MergeExecutedData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      mergeSha: 'a'.repeat(40),
      rollbackSha: 'b'.repeat(40),
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.mergeSha).toBe('a'.repeat(40));
      expect(result.data.rollbackSha).toBe('b'.repeat(40));
    }
  });
});

describe('MergeRollbackData', () => {
  it('MergeRollbackEventSchema_ValidPayload_Parses', () => {
    // DR-MO-2: merge.rollback payload — emitted when a merge is reverted.
    // reason is a closed enum: 'merge-failed' | 'verification-failed' | 'timeout'.
    expect(EventTypes).toContain('merge.rollback');

    const schema = EVENT_DATA_SCHEMAS['merge.rollback' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = MergeRollbackData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      rollbackSha: 'b'.repeat(40),
      reason: 'merge-failed',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe('merge-failed');
    }
  });

  it('MergeRollbackEventSchema_UnknownReason_Rejects', () => {
    // DR-MO-2: reason enum is closed — bogus values must fail parsing so
    // observability isn't fragmented by free-form rollback reasons.
    const result = MergeRollbackData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      rollbackSha: 'b'.repeat(40),
      reason: 'bogus',
    });
    expect(result.success).toBe(false);
  });

  it('MergeRollbackEventSchema_ValidRecoveryError_Parses', () => {
    // #1304 INV-14 discriminator — closed enum on the substrate-undo
    // outcome. The 'reset-failed' variant is what the current pure
    // executor emits when `git reset --hard` exits non-zero.
    const result = MergeRollbackData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      rollbackSha: 'b'.repeat(40),
      reason: 'verification-failed',
      rollbackError: 'git reset --hard exited 128',
      recoveryError: 'reset-failed',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.recoveryError).toBe('reset-failed');
    }
  });

  it('MergeRollbackEventSchema_UnknownRecoveryError_Rejects', () => {
    // INV-14 discriminator is a closed enum — values outside the registered
    // set must fail parsing so observability sees indeterminate worktrees
    // via the three sanctioned cases rather than via free-form strings.
    const result = MergeRollbackData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      rollbackSha: 'b'.repeat(40),
      reason: 'merge-failed',
      recoveryError: 'bogus',
    });
    expect(result.success).toBe(false);
  });
});

describe('MergeCompletedData', () => {
  it('MergeCompletedEventSchema_RegisteredInEventTypesAndDataSchemas', () => {
    expect(EventTypes).toContain('merge.completed');
    const schema = EVENT_DATA_SCHEMAS['merge.completed' as typeof EventTypes[number]];
    expect(schema).toBeDefined();
  });

  it('MergeCompletedEventSchema_ValidPayload_Parses', () => {
    // #1304 INV-10 terminal marker — emitted adjacent to merge.executed by
    // `handleExecuteMerge`. Carries the same shape as merge.executed
    // (taskId, branches, mergeSha) plus an optional featureId for
    // cross-stream observability.
    const result = MergeCompletedData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      featureId: 'feat-1',
      mergeSha: 'a'.repeat(40),
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.mergeSha).toBe('a'.repeat(40));
      expect(result.data.featureId).toBe('feat-1');
    }
  });

  it('MergeCompletedEventSchema_MissingMergeSha_Rejects', () => {
    // mergeSha is required (inherited from MergeExecutedData.pick) — without
    // it, the projection's terminal state loses the link to the merge SHA.
    const result = MergeCompletedData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
    });
    expect(result.success).toBe(false);
  });
});

// ─── T15 (#1199): command.resolved event schema ─────────────────────────────

describe('CommandResolvedEventSchema', () => {
  // Audit-only event emitted by the test/typecheck/install runtime resolver
  // (#1199). Records where each command resolution came from so downstream
  // graceful-skip semantics (T17) can distinguish a configured `null` from
  // an unresolved command for which we should bail with remediation guidance.

  it('CommandResolved_Registered_InEventTypesAndRegistry', () => {
    expect(EventTypes).toContain('command.resolved');
    expect(EVENT_EMISSION_REGISTRY['command.resolved']).toBe('auto');
    const schema = EVENT_DATA_SCHEMAS['command.resolved' as typeof EventTypes[number]];
    expect(schema).toBeDefined();
  });

  it('commandResolved_AllFieldsValid_AcceptsConfigSource', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'test',
      command: 'pytest',
      source: 'config',
      repoRoot: '/x',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.field).toBe('test');
      expect(result.data.command).toBe('pytest');
      expect(result.data.source).toBe('config');
      expect(result.data.repoRoot).toBe('/x');
    }
  });

  it('commandResolved_DetectionSource_Validates', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'typecheck',
      command: 'tsc --noEmit',
      source: 'detection',
      repoRoot: '/x',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('detection');
    }
  });

  it('commandResolved_ToolchainConfigSource_Validates', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'test',
      command: 'zig build test',
      source: 'toolchain-config',
      repoRoot: '/x',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('toolchain-config');
    }
  });

  it('commandResolved_TaskRunnerSource_Validates', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'test',
      command: 'task test',
      source: 'task-runner',
      repoRoot: '/x',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('task-runner');
    }
  });

  it('commandResolved_OverrideSource_Validates', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'install',
      command: 'npm ci',
      source: 'override',
      repoRoot: '/x',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('override');
    }
  });

  it('commandResolved_UnresolvedWithNullCommandAndRemediation_Validates', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'test',
      command: null,
      source: 'unresolved',
      repoRoot: '/x',
      remediation: 'set commands.test in .exarchos.yml',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.command).toBeNull();
      expect(result.data.source).toBe('unresolved');
      expect(result.data.remediation).toBe('set commands.test in .exarchos.yml');
    }
  });

  it('commandResolved_UnknownSource_Rejected', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'test',
      command: 'pytest',
      source: 'magic',
      repoRoot: '/x',
    });
    expect(result.success).toBe(false);
  });

  it('commandResolved_UnknownField_Rejected', () => {
    // Only test/typecheck/install are valid fields — a hypothetical 'lint'
    // resolver doesn't exist yet; if it ever does, the enum is widened
    // intentionally rather than via a free-form string.
    const result = CommandResolvedEventSchema.safeParse({
      field: 'lint',
      command: 'eslint .',
      source: 'config',
      repoRoot: '/x',
    });
    expect(result.success).toBe(false);
  });

  it('commandResolved_EmptyCommand_Rejected', () => {
    // Empty string isn't a meaningful command — the resolver should emit
    // command: null with source: 'unresolved' instead.
    const result = CommandResolvedEventSchema.safeParse({
      field: 'test',
      command: '',
      source: 'config',
      repoRoot: '/x',
    });
    expect(result.success).toBe(false);
  });

  it('commandResolved_MissingRepoRoot_Rejected', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'test',
      command: 'pytest',
      source: 'config',
    });
    expect(result.success).toBe(false);
  });
});

// ─── T-17 (DR-8b): task.assigned hint catalog includes optional `branch` ────
//
// Orchestrators discover the `task.assigned` event shape via the published
// schema (rendered as JSON-schema by `handleEventTypeDescribe` /
// `serializeEventCatalog`'s `hasSchema` flag). The dogfood report flagged
// that callers couldn't tell whether `branch` was supported on
// `task.assigned`; this test pins the contract so the catalog stays aligned
// with `setup_worktree`'s branch-resolution priority (T-09) and with
// `skills-src/delegation/SKILL.md`'s pre-emit example.
describe('TaskAssignedData hint catalog', () => {
  it('eventEmissionCatalog_TaskAssigned_OptionalBranchField', () => {
    // Schema must accept a payload that includes branch...
    const withBranch = TaskAssignedData.safeParse({
      taskId: 'T-001',
      title: 'Wire setup_worktree branch resolution',
      branch: 'feature/v290/T-001-branch-resolution',
    });
    expect(withBranch.success).toBe(true);

    // ...and a payload that omits it (branch must be optional, not required).
    const withoutBranch = TaskAssignedData.safeParse({
      taskId: 'T-002',
      title: 'No branch yet',
    });
    expect(withoutBranch.success).toBe(true);

    // Catalog rendering: the JSON-schema view that callers consume via
    // `event.describe({ eventTypes: ['task.assigned'] })` must list `branch`
    // as a property and must NOT mark it required.
    const json = zodToJsonSchema(TaskAssignedData) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(json.properties).toBeDefined();
    expect(json.properties).toHaveProperty('branch');
    // `branch` must be present and optional (i.e., not in the required[]
    // array — required[] may be absent entirely if no fields are required).
    const required = json.required ?? [];
    expect(required).not.toContain('branch');
  });
});

// ─── T02 (DR-4, DR-10): hsm.deprecated_action_invoked event schema ──────────
//
// Telemetry signal for the HSM API single-path migration (DR-4). Each invocation
// of a deprecated action (e.g., `workflow.set({phase})`) emits this event so the
// migration window can be measured before removing the legacy path. Plan task T02.

describe('HsmDeprecatedActionInvokedData', () => {
  it('EventSchemas_HsmDeprecatedActionInvoked_ValidatesAndRoundtrips', () => {
    expect(EventTypes).toContain('hsm.deprecated_action_invoked');
    const schema = EVENT_DATA_SCHEMAS['hsm.deprecated_action_invoked' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const payload = {
      action: 'set({phase})',
      invokedBy: 'orchestrator',
    };
    const result = HsmDeprecatedActionInvokedData.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.action).toBe('set({phase})');
      expect(result.data.invokedBy).toBe('orchestrator');
    }
  });

  it('EventSchemas_HsmDeprecatedActionInvoked_MissingFields_Rejects', () => {
    const missingAction = HsmDeprecatedActionInvokedData.safeParse({ invokedBy: 'orchestrator' });
    expect(missingAction.success).toBe(false);

    const missingInvokedBy = HsmDeprecatedActionInvokedData.safeParse({ action: 'set({phase})' });
    expect(missingInvokedBy.success).toBe(false);
  });
});

// ─── T03 (DR-6, DR-7, DR-10): spec.legacy_capabilities_array + ─────────────
//                                phase.contract_missing event schemas
//
// `spec.legacy_capabilities_array` (DR-6) — emitted when a spec uses the legacy
// `capabilities[]` array shape during the transition window so capability-posture
// telemetry can drive the migration.
// `phase.contract_missing` (DR-7) — emitted once at startup per phase that
// lacks a typed contract so the phase-contract migration is observable.

describe('SpecLegacyCapabilitiesArrayData', () => {
  it('EventSchemas_SpecLegacyCapabilitiesArray_ValidatesAndRoundtrips', () => {
    expect(EventTypes).toContain('spec.legacy_capabilities_array');
    const schema = EVENT_DATA_SCHEMAS['spec.legacy_capabilities_array' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const payload = {
      specName: 'orchestrator-spec',
      capabilities: ['plan', 'delegate', 'merge'],
    };
    const result = SpecLegacyCapabilitiesArrayData.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.specName).toBe('orchestrator-spec');
      expect(result.data.capabilities).toEqual(['plan', 'delegate', 'merge']);
    }
  });

  it('EventSchemas_SpecLegacyCapabilitiesArray_EmptyCapabilitiesAccepted', () => {
    // A legacy spec with an empty capabilities array is still a legacy-shape
    // signal worth recording.
    const result = SpecLegacyCapabilitiesArrayData.safeParse({
      specName: 'empty-spec',
      capabilities: [],
    });
    expect(result.success).toBe(true);
  });

  it('EventSchemas_SpecLegacyCapabilitiesArray_MissingFields_Rejects', () => {
    const missingSpecName = SpecLegacyCapabilitiesArrayData.safeParse({ capabilities: ['x'] });
    expect(missingSpecName.success).toBe(false);

    const missingCapabilities = SpecLegacyCapabilitiesArrayData.safeParse({ specName: 's' });
    expect(missingCapabilities.success).toBe(false);
  });
});

describe('PhaseContractMissingData', () => {
  it('EventSchemas_PhaseContractMissing_ValidatesAndRoundtrips', () => {
    expect(EventTypes).toContain('phase.contract_missing');
    const schema = EVENT_DATA_SCHEMAS['phase.contract_missing' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const payload = { phaseName: 'design' };
    const result = PhaseContractMissingData.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.phaseName).toBe('design');
    }
  });

  it('EventSchemas_PhaseContractMissing_MissingPhaseName_Rejects', () => {
    const result = PhaseContractMissingData.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ─── T04 (DR-9, DR-10): migration.* event schemas ──────────────────────────
//
// Migration pipeline observability for the JSONL→SQLite import (DR-9).
// `migration.legacy_jsonl_imported` — per-file completion event.
// `migration.completed` — final aggregate event after the import succeeds.
// `migration.failed` — emitted on failure; includes partial-progress counters
// so operators can resume or retry from a known point.

describe('MigrationLegacyJsonlImportedData', () => {
  it('EventSchemas_MigrationLegacyJsonlImported_ValidatesAndRoundtrips', () => {
    expect(EventTypes).toContain('migration.legacy_jsonl_imported');
    const schema = EVENT_DATA_SCHEMAS['migration.legacy_jsonl_imported' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    // T65: sourcePath is state-dir-relative for INV-1 portability (no
    // absolute paths in the durable event log).
    const payload = {
      sourcePath: 'wf-1.events.jsonl',
      eventCount: 142,
      durationMs: 318,
    };
    const result = MigrationLegacyJsonlImportedData.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.sourcePath).toBe('wf-1.events.jsonl');
      expect(result.data.eventCount).toBe(142);
      expect(result.data.durationMs).toBe(318);
    }
  });

  it('EventSchemas_MigrationLegacyJsonlImported_NegativeCount_Rejects', () => {
    const result = MigrationLegacyJsonlImportedData.safeParse({
      sourcePath: 'streams/x.jsonl',
      eventCount: -1,
      durationMs: 10,
    });
    expect(result.success).toBe(false);
  });

  // T65 (CodeRabbit #3): persisting absolute paths into the source-of-truth
  // event log leaks machine-specific identifiers (home directories, usernames)
  // into the durable archive and breaks INV-1 portability — events should be
  // replayable across machines (e.g. a developer pulling the SQLite from a
  // teammate's setup) and across the future basileus-remote shared store
  // (#1081). The schema must therefore reject absolute paths in `sourcePath`.
  it('EventSchemas_MigrationLegacyJsonlImported_AbsolutePosixPath_Rejects', () => {
    const result = MigrationLegacyJsonlImportedData.safeParse({
      sourcePath: '/var/exarchos/streams/wf-1.events.jsonl',
      eventCount: 0,
      durationMs: 0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toMatch(/relative/i);
    }
  });

  it('EventSchemas_MigrationLegacyJsonlImported_AbsoluteWindowsPath_Rejects', () => {
    const result = MigrationLegacyJsonlImportedData.safeParse({
      sourcePath: 'C:\\Users\\dev\\.exarchos\\wf-1.events.jsonl',
      eventCount: 0,
      durationMs: 0,
    });
    expect(result.success).toBe(false);
  });

  it('EventSchemas_MigrationLegacyJsonlImported_RelativePath_Accepts', () => {
    const result = MigrationLegacyJsonlImportedData.safeParse({
      sourcePath: 'wf-1.events.jsonl',
      eventCount: 3,
      durationMs: 5,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.sourcePath).toBe('wf-1.events.jsonl');
    }
  });
});

describe('MigrationCompletedData', () => {
  it('EventSchemas_MigrationCompleted_ValidatesAndRoundtrips', () => {
    expect(EventTypes).toContain('migration.completed');
    const schema = EVENT_DATA_SCHEMAS['migration.completed' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const payload = {
      filesImported: 12,
      eventsImported: 4_532,
      totalDurationMs: 12_417,
    };
    const result = MigrationCompletedData.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.filesImported).toBe(12);
      expect(result.data.eventsImported).toBe(4_532);
      expect(result.data.totalDurationMs).toBe(12_417);
    }
  });

  it('EventSchemas_MigrationCompleted_ZeroFilesAccepted', () => {
    // Completing a no-op migration (no JSONL files present) is still a valid
    // outcome — the lock holder should record completion so siblings unblock.
    const result = MigrationCompletedData.safeParse({
      filesImported: 0,
      eventsImported: 0,
      totalDurationMs: 4,
    });
    expect(result.success).toBe(true);
  });
});

describe('MigrationFailedData', () => {
  it('EventSchemas_MigrationFailed_ValidatesAndRoundtrips', () => {
    expect(EventTypes).toContain('migration.failed');
    const schema = EVENT_DATA_SCHEMAS['migration.failed' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const payload = {
      reason: 'corrupt jsonl: parse error at line 42',
      partialFilesImported: 3,
      partialEventsImported: 211,
    };
    const result = MigrationFailedData.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe('corrupt jsonl: parse error at line 42');
      expect(result.data.partialFilesImported).toBe(3);
      expect(result.data.partialEventsImported).toBe(211);
    }
  });

  it('EventSchemas_MigrationFailed_EmptyReason_Rejects', () => {
    // The reason field is the operator-facing diagnostic; an empty string
    // would fragment observability with information-free failure events.
    const result = MigrationFailedData.safeParse({
      reason: '',
      partialFilesImported: 0,
      partialEventsImported: 0,
    });
    expect(result.success).toBe(false);
  });
});

// ─── T-11: session.machinery_consumed ────────────────────────────────────────

describe('SessionMachineryConsumedDataSchema', () => {
  it('EventEmissionRegistry_SessionMachineryConsumed_IsAutoSource', () => {
    // T-11: The event must be registered in the emission registry as 'auto'
    // so the dispatch-core interceptor (T-12) can emit it without model involvement.
    expect(EVENT_EMISSION_REGISTRY).toHaveProperty('session.machinery_consumed');
    expect(EVENT_EMISSION_REGISTRY['session.machinery_consumed' as keyof typeof EVENT_EMISSION_REGISTRY]).toBe('auto');
  });

  it('EventSchemas_SessionMachineryConsumed_ValidPayload_ParsesSuccessfully', () => {
    // T-11: Canonical valid payload — all three required fields present.
    const result = SessionMachineryConsumedDataSchema.safeParse({
      rehydrateSequence: 0,
      firstActionVerb: 'task_complete',
      firstActionAt: '2026-05-09T20:00:00.000Z',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('EventSchemas_SessionMachineryConsumed_NegativeRehydrateSequence_Rejects', () => {
    // T-11: rehydrateSequence must be non-negative — a negative counter is
    // nonsensical and would corrupt lifecycle ordering downstream.
    const result = SessionMachineryConsumedDataSchema.safeParse({
      rehydrateSequence: -1,
      firstActionVerb: 'task_complete',
      firstActionAt: '2026-05-09T20:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('EventSchemas_SessionMachineryConsumed_NonIsoTimestamp_Rejects', () => {
    // T-11: firstActionAt must be a valid ISO 8601 datetime — free-form
    // strings would break timeline reconstruction and the `wait --condition`
    // comparators that depend on this field.
    const result = SessionMachineryConsumedDataSchema.safeParse({
      rehydrateSequence: 0,
      firstActionVerb: 'task_complete',
      firstActionAt: 'not-an-iso-timestamp',
    });
    expect(result.success).toBe(false);
  });

  it('EventSchemas_SessionMachineryConsumed_MissingRehydrateSequence_Rejects', () => {
    // T-11: rehydrateSequence is required — absence prevents `wait --condition=machinery_consumed`
    // from correlating to the right rehydration cycle.
    const result = SessionMachineryConsumedDataSchema.safeParse({
      firstActionVerb: 'task_complete',
      firstActionAt: '2026-05-09T20:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('EventSchemas_SessionMachineryConsumed_MissingFirstActionVerb_Rejects', () => {
    // T-11: firstActionVerb is required — it records what the agent did first
    // after consuming machinery, providing actionable observability context.
    const result = SessionMachineryConsumedDataSchema.safeParse({
      rehydrateSequence: 0,
      firstActionAt: '2026-05-09T20:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('EventSchemas_SessionMachineryConsumed_MissingFirstActionAt_Rejects', () => {
    // T-11: firstActionAt is required — the timestamp anchors the machinery
    // consumption to wall-clock time for ps/wait lifecycle queries.
    const result = SessionMachineryConsumedDataSchema.safeParse({
      rehydrateSequence: 0,
      firstActionVerb: 'task_complete',
    });
    expect(result.success).toBe(false);
  });
});

// ─── B6: Wave B two-event split schema registration regression ───────────────
//
// Asserts that all 10 Wave B event types are registered in EVENT_DATA_SCHEMAS
// and accept / reject canonical payloads. This is a schema-level regression
// check — it does NOT test handler idempotency (B*.3), which is handled by
// the per-handler agents B1–B5.

describe('EventSchemaRegistry_RegistersAllNewTwoEventSplitTypes', () => {
  const TWO_EVENT_TYPES = [
    'pr.create.requested',
    'pr.create.executed',
    'pr.comment.requested',
    'pr.comment.executed',
    'issue.create.requested',
    'issue.create.executed',
    'branch.delete.requested',
    'branch.delete.executed',
    'worktree.remove.requested',
    'worktree.remove.executed',
  ] as const;

  // B6.1 — all 10 types are in the EventTypes const tuple (built-in)
  it('B6_AllTenTypes_RegisteredInEventTypesArray', () => {
    for (const eventType of TWO_EVENT_TYPES) {
      expect(EventTypes).toContain(eventType);
    }
  });

  // B6.2 — all 10 types have schemas in EVENT_DATA_SCHEMAS (not undefined)
  it('B6_AllTenTypes_HaveSchemaInEventDataSchemas', () => {
    for (const eventType of TWO_EVENT_TYPES) {
      expect(EVENT_DATA_SCHEMAS).toHaveProperty(eventType);
      expect(
        (EVENT_DATA_SCHEMAS as Partial<Record<string, unknown>>)[eventType],
      ).toBeDefined();
    }
  });

  // B6.3 — all 10 types are classified as 'auto' in the emission registry
  it('B6_AllTenTypes_HaveAutoEmissionSource', () => {
    for (const eventType of TWO_EVENT_TYPES) {
      expect(
        (EVENT_EMISSION_REGISTRY as Record<string, EventEmissionSource>)[eventType],
      ).toBe('auto');
    }
  });

  // B6.4 — canonical valid payload accepted for each schema

  it('B6_PrCreateRequested_ValidPayload_Accepts', () => {
    const result = PrCreateRequestedData.safeParse({
      operationId: '11111111-1111-4111-8111-111111111111',
      title: 'feat: add new feature',
      body: 'This PR adds a new feature.',
      base: 'main',
      head: 'feature/my-feature',
      draft: false,
      labels: ['enhancement'],
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_PrCreateExecuted_ValidPayload_Accepts', () => {
    const result = PrCreateExecutedData.safeParse({
      operationId: '11111111-1111-4111-8111-111111111111',
      prNumber: 42,
      url: 'https://github.com/lvlup-sw/exarchos/pull/42',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_PrCommentRequested_ValidPayload_Accepts', () => {
    const result = PrCommentRequestedData.safeParse({
      operationId: '22222222-2222-4222-8222-222222222222',
      prNumber: 42,
      body: 'LGTM! Approved.',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_PrCommentExecuted_ValidPayload_Accepts', () => {
    const result = PrCommentExecutedData.safeParse({
      operationId: '22222222-2222-4222-8222-222222222222',
      commentId: 99001,
      url: 'https://github.com/lvlup-sw/exarchos/pull/42#issuecomment-99001',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_IssueCreateRequested_ValidPayload_Accepts', () => {
    const result = IssueCreateRequestedData.safeParse({
      operationId: '33333333-3333-4333-8333-333333333333',
      title: 'Bug: something is broken',
      body: 'Steps to reproduce...',
      labels: ['bug'],
      assignees: ['reed'],
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_IssueCreateExecuted_ValidPayload_Accepts', () => {
    const result = IssueCreateExecutedData.safeParse({
      operationId: '33333333-3333-4333-8333-333333333333',
      issueNumber: 1342,
      url: 'https://github.com/lvlup-sw/exarchos/issues/1342',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_BranchDeleteRequested_ValidPayload_Accepts', () => {
    const result = BranchDeleteRequestedData.safeParse({
      operationId: '44444444-4444-4444-8444-444444444444',
      branch: 'feature/old-branch',
      remote: 'origin',
      localOnly: false,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_BranchDeleteExecuted_ValidPayload_Accepts', () => {
    const result = BranchDeleteExecutedData.safeParse({
      operationId: '44444444-4444-4444-8444-444444444444',
      branch: 'feature/old-branch',
      deletedLocally: true,
      deletedRemote: true,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_WorktreeRemoveRequested_ValidPayload_Accepts', () => {
    const result = WorktreeRemoveRequestedData.safeParse({
      operationId: '55555555-5555-4555-8555-555555555555',
      worktreePath: '/home/user/repo/.claude/worktrees/agent-abc123',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_WorktreeRemoveExecuted_ValidPayload_Accepts', () => {
    const result = WorktreeRemoveExecutedData.safeParse({
      operationId: '55555555-5555-4555-8555-555555555555',
      worktreePath: '/home/user/repo/.claude/worktrees/agent-abc123',
      removed: true,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  // B6.5 — negative tests: each *.requested type rejects when operationId is missing
  // (operationId is required on all *.requested types — it's the idempotency anchor)

  it('B6_PrCreateRequested_MissingOperationId_Rejects', () => {
    const result = PrCreateRequestedData.safeParse({
      title: 'feat: add new feature',
      body: 'This PR adds a new feature.',
      base: 'main',
      head: 'feature/my-feature',
    });
    expect(result.success).toBe(false);
  });

  it('B6_PrCommentRequested_MissingOperationId_Rejects', () => {
    const result = PrCommentRequestedData.safeParse({
      prNumber: 42,
      body: 'LGTM! Approved.',
    });
    expect(result.success).toBe(false);
  });

  it('B6_IssueCreateRequested_MissingOperationId_Rejects', () => {
    const result = IssueCreateRequestedData.safeParse({
      title: 'Bug: something is broken',
      body: 'Steps to reproduce...',
    });
    expect(result.success).toBe(false);
  });

  it('B6_BranchDeleteRequested_MissingOperationId_Rejects', () => {
    const result = BranchDeleteRequestedData.safeParse({
      branch: 'feature/old-branch',
    });
    expect(result.success).toBe(false);
  });

  it('B6_WorktreeRemoveRequested_MissingOperationId_Rejects', () => {
    const result = WorktreeRemoveRequestedData.safeParse({
      worktreePath: '/home/user/repo/.claude/worktrees/agent-abc123',
    });
    expect(result.success).toBe(false);
  });

  // B6.6 — *.requested types reject a malformed (non-uuid) operationId
  it('B6_PrCreateRequested_InvalidOperationId_Rejects', () => {
    const result = PrCreateRequestedData.safeParse({
      operationId: 'not-a-uuid',
      title: 'feat: add new feature',
      body: 'This PR adds a new feature.',
      base: 'main',
      head: 'feature/my-feature',
    });
    expect(result.success).toBe(false);
  });
});

// ─── PR3 T7: tool.action_errored event type registration (#1364) ────────────

describe('EventStoreSchemas_ToolActionErrored_HasRegisteredType', () => {
  it('includes tool.action_errored in the EventType union', () => {
    expect((EventTypes as readonly string[])).toContain('tool.action_errored');
  });

  it('classifies tool.action_errored as auto-emitted', () => {
    expect(
      EVENT_EMISSION_REGISTRY['tool.action_errored' as keyof typeof EVENT_EMISSION_REGISTRY],
    ).toBe('auto');
  });

  it('has a data schema accepting the action-errored shape', () => {
    const schema = EVENT_DATA_SCHEMAS['tool.action_errored' as keyof typeof EVENT_DATA_SCHEMAS];
    expect(schema).toBeDefined();
    if (!schema) return;
    const valid = schema.safeParse({
      tool: 'exarchos_orchestrate',
      durationMs: 12,
      errorCode: 'RESERVED_FIELD',
      responseBytes: 220,
      tokenEstimate: 55,
    });
    expect(valid.success).toBe(true);

    // Reject when required fields are missing
    const missingCode = schema.safeParse({
      tool: 'exarchos_orchestrate',
      durationMs: 12,
      responseBytes: 220,
      tokenEstimate: 55,
    });
    expect(missingCode.success).toBe(false);

    const missingTool = schema.safeParse({
      durationMs: 12,
      errorCode: 'X',
      responseBytes: 0,
      tokenEstimate: 0,
    });
    expect(missingTool.success).toBe(false);
  });

  it('accepts a full WorkflowEventBase append carrying tool.action_errored', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'telemetry',
      sequence: 1,
      timestamp: '2026-05-15T00:00:00.000Z',
      type: 'tool.action_errored',
      schemaVersion: '1.0',
      data: {
        tool: 'exarchos_orchestrate',
        durationMs: 12,
        errorCode: 'MERGE_ROLLED_BACK',
        responseBytes: 220,
        tokenEstimate: 55,
      },
    });
    expect(event.success).toBe(true);
  });
});

describe('merge.recovered (#1306 successor to merge.rollback)', () => {
  const recoveredSchema = (
    EVENT_DATA_SCHEMAS as Record<string, { parse: (v: unknown) => unknown } | undefined>
  )['merge.recovered'];

  it('MergeRecovered_RegisteredWithRecoveryShape_ParsesValidPayload', () => {
    expect(recoveredSchema).toBeDefined();
    const parsed = recoveredSchema!.parse({
      taskId: 't-1',
      sourceBranch: 'feat/x',
      targetBranch: 'integration',
      recoveryPointSha: 'abc123',
      reason: 'timeout',
      recoveryErrorDetail: 'git reset --keep abc123 exited 1',
      recoveryError: 'reset-failed',
    });
    expect(parsed).toMatchObject({
      recoveryPointSha: 'abc123',
      recoveryError: 'reset-failed',
    });
  });

  it('MergeRecovered_RejectsMissingRecoveryPointSha', () => {
    expect(recoveredSchema).toBeDefined();
    expect(() =>
      recoveredSchema!.parse({ sourceBranch: 'a', targetBranch: 'b', reason: 'merge-failed' }),
    ).toThrow();
  });
});

describe('merge.retry_attempt (#1308 transient-failure retry)', () => {
  const retrySchema = (
    EVENT_DATA_SCHEMAS as Record<string, { parse: (v: unknown) => unknown } | undefined>
  )['merge.retry_attempt'];

  it('Schemas_MergeRetryAttempt_Registered', () => {
    // Registered as an event type with the expected retry payload shape.
    expect(EventTypes).toContain('merge.retry_attempt');
    expect(retrySchema).toBeDefined();
    const parsed = retrySchema!.parse({
      attempt: 2,
      delayMs: 500,
      reason: 'timeout',
    });
    expect(parsed).toMatchObject({
      attempt: 2,
      delayMs: 500,
      reason: 'timeout',
    });
  });
});

describe('merge.executing_started (#1309 liveness event)', () => {
  const startedSchema = (
    EVENT_DATA_SCHEMAS as Record<string, { parse: (v: unknown) => unknown } | undefined>
  )['merge.executing_started'];

  it('Schemas_MergeExecutingStarted_Registered', () => {
    // Registered as an event type carrying the liveness payload shape
    // { taskId, sourceBranch, targetBranch, recoveryPointSha, startedAt }.
    expect(EventTypes).toContain('merge.executing_started');
    expect(startedSchema).toBeDefined();
    const parsed = startedSchema!.parse({
      taskId: 't-1',
      sourceBranch: 'feat/x',
      targetBranch: 'integration',
      recoveryPointSha: 'abc123',
      startedAt: '2026-06-21T00:00:00.000Z',
    });
    expect(parsed).toMatchObject({
      sourceBranch: 'feat/x',
      targetBranch: 'integration',
      recoveryPointSha: 'abc123',
      startedAt: '2026-06-21T00:00:00.000Z',
    });
  });

  it('MergeExecutingStarted_TaskIdOptional_ParsesWithoutIt', () => {
    // taskId is optional (CLI direct-invocation has no task context), mirroring
    // the other merge events.
    expect(startedSchema).toBeDefined();
    const parsed = startedSchema!.parse({
      sourceBranch: 'feat/x',
      targetBranch: 'integration',
      recoveryPointSha: 'abc123',
      startedAt: '2026-06-21T00:00:00.000Z',
    });
    expect(parsed).toMatchObject({ recoveryPointSha: 'abc123' });
  });

  it('MergeExecutingStarted_RejectsMissingRecoveryPointSha', () => {
    expect(startedSchema).toBeDefined();
    expect(() =>
      startedSchema!.parse({
        sourceBranch: 'feat/x',
        targetBranch: 'integration',
        startedAt: '2026-06-21T00:00:00.000Z',
      }),
    ).toThrow();
  });
});
