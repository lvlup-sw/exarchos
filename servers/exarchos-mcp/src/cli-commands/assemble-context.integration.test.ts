import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleAssembleContext } from './assemble-context.js';
import { resetMaterializerCache } from '../views/tools.js';
import { getPlaybook } from '../workflow/playbooks.js';
import {
  FeaturePhaseSchema,
  DebugPhaseSchema,
  RefactorPhaseSchema,
} from '../workflow/schemas.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

async function createTempStateDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'assemble-ctx-integration-'));
}

async function writeMockState(
  stateDir: string,
  featureId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const state = {
    version: '1.1',
    featureId,
    workflowType: 'feature',
    phase: 'delegate',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    _version: 1,
    artifacts: {
      design: 'docs/designs/test.md',
      plan: 'docs/plans/test.md',
      pr: null,
    },
    tasks: [
      { id: 'T1', title: 'Task one', status: 'complete' },
      { id: 'T2', title: 'Task two', status: 'in_progress' },
    ],
    worktrees: {},
    reviews: {},
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
    _history: {},
    _checkpoint: {
      timestamp: '2026-01-01T00:00:00Z',
      phase: 'delegate',
      summary: '',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: '2026-01-01T00:00:00Z',
      staleAfterMinutes: 120,
    },
    ...overrides,
  };
  await fs.writeFile(
    path.join(stateDir, `${featureId}.state.json`),
    JSON.stringify(state, null, 2),
  );
}

async function writeMockEvents(
  stateDir: string,
  streamId: string,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  const lines = events.map((e, i) =>
    JSON.stringify({
      ...e,
      streamId,
      sequence: i + 1,
      timestamp: e.timestamp || '2026-01-01T00:00:00Z',
    }),
  );
  await fs.writeFile(
    path.join(stateDir, `${streamId}.events.jsonl`),
    lines.join('\n') + '\n',
  );
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ─── Integration Tests: Behavioral Guidance Round-Trip ──────────────────────

describe('assemble-context integration: behavioral guidance round-trip', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempStateDir();
    resetMaterializerCache();
  });

  afterEach(async () => {
    await cleanupDir(tempDir);
  });

  it('preCompactToSessionStart_DelegatePhase_BehavioralGuidanceIncluded', async () => {
    // Arrange — feature workflow in delegate phase
    const featureId = 'roundtrip-delegate';
    await writeMockState(tempDir, featureId, {
      phase: 'delegate',
      workflowType: 'feature',
    });
    await writeMockEvents(tempDir, featureId, [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      {
        type: 'workflow.transition',
        data: { featureId, from: 'ideate', to: 'delegate', trigger: 'auto' },
      },
    ]);

    // Act — assemble context
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — context document contains behavioral guidance section
    expect(result.contextDocument).toContain('### Behavioral Guidance');

    // Assert — contains tool names from the delegate playbook
    expect(result.contextDocument).toContain('exarchos_workflow');
    expect(result.contextDocument).toContain('exarchos_event');
    expect(result.contextDocument).toContain('exarchos_orchestrate');

    // Assert — contains event types from the delegate playbook.
    // gate.executed is auto-emitted by withTelemetry middleware and explicitly
    // excluded from the model-event contract per #1180 — assert on the
    // model-emitted set instead.
    expect(result.contextDocument).toContain('task.assigned');
    expect(result.contextDocument).toContain('team.spawned');
    expect(result.contextDocument).toContain('task.progressed');
  });

  it('preCompactToSessionStart_ReviewPhase_HasToolInstructions', async () => {
    // Arrange — feature workflow in review phase
    const featureId = 'roundtrip-review';
    await writeMockState(tempDir, featureId, {
      phase: 'review',
      workflowType: 'feature',
    });
    await writeMockEvents(tempDir, featureId, [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      {
        type: 'workflow.transition',
        data: { featureId, from: 'delegate', to: 'review', trigger: 'auto' },
      },
    ]);

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — behavioral section present
    expect(result.contextDocument).toContain('### Behavioral Guidance');

    // Assert — review playbook references quality-review skill
    expect(result.contextDocument).toContain('@skills/quality-review/SKILL.md');

    // Assert — review playbook has tool instructions
    expect(result.contextDocument).toContain('exarchos_workflow');
    expect(result.contextDocument).toContain('exarchos_event');
  });

  it('preCompactToSessionStart_TerminalPhase_NoBehavioralGuidance', async () => {
    // Arrange — feature workflow in completed (terminal) phase
    const featureId = 'roundtrip-completed';
    await writeMockState(tempDir, featureId, {
      phase: 'completed',
      workflowType: 'feature',
    });
    await writeMockEvents(tempDir, featureId, [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
    ]);

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — context assembles correctly for terminal phase
    expect(result.contextDocument).toContain('Workflow Context');
    expect(result.phase).toBe('completed');

    // Terminal playbooks are registered in the registry, so assemble-context
    // renders them. However, terminal behavioral guidance is degenerate:
    // - skill = 'none' (no actionable skill reference)
    // - no tool instructions (Tools: None)
    // - no event instructions (Events to emit: None)
    // - compact guidance says "No further actions needed"
    // This distinguishes terminal from active phases which have real guidance.
    expect(result.contextDocument).toContain('**Tools:** None');
    expect(result.contextDocument).toContain('**Events to emit:** None');
    expect(result.contextDocument).toContain('No further actions needed');

    // Should NOT contain any real tool references that active phases would have
    expect(result.contextDocument).not.toContain('exarchos_event');
    expect(result.contextDocument).not.toContain('exarchos_orchestrate');
  });

  it('preCompactToSessionStart_EveryWorkflowType_HasBehavioral', async () => {
    // Arrange — test representative non-terminal phases across all workflow types
    const testCases: Array<{
      workflowType: string;
      phase: string;
      featureId: string;
    }> = [
      { workflowType: 'feature', phase: 'delegate', featureId: 'wf-feature-delegate' },
      { workflowType: 'debug', phase: 'triage', featureId: 'wf-debug-triage' },
      { workflowType: 'refactor', phase: 'explore', featureId: 'wf-refactor-explore' },
    ];

    for (const tc of testCases) {
      // Reset for each test case
      resetMaterializerCache();

      const caseDir = await createTempStateDir();
      try {
        await writeMockState(caseDir, tc.featureId, {
          phase: tc.phase,
          workflowType: tc.workflowType,
          _checkpoint: {
            timestamp: '2026-01-01T00:00:00Z',
            phase: tc.phase,
            summary: '',
            operationsSince: 0,
            fixCycleCount: 0,
            lastActivityTimestamp: '2026-01-01T00:00:00Z',
            staleAfterMinutes: 120,
          },
        });
        await writeMockEvents(caseDir, tc.featureId, [
          {
            type: 'workflow.started',
            data: { featureId: tc.featureId, workflowType: tc.workflowType },
          },
        ]);

        // Act
        const result = await handleAssembleContext({ featureId: tc.featureId }, caseDir);

        // Assert — behavioral section present for each workflow type
        expect(result.contextDocument).toContain('### Behavioral Guidance');
        expect(result.phase).toBe(tc.phase);
      } finally {
        await cleanupDir(caseDir);
      }
    }
  });

  // ─── Property-Based Test ──────────────────────────────────────────────────

  it('property: validWorkflowPhaseWithPlaybook_AssembleContext_ProducesBehavioralSection', async () => {
    // Build (workflowType, phase) pairs that have a registered playbook
    // and are NOT terminal phases
    const TERMINAL_PHASES = new Set(['completed', 'cancelled']);

    const featurePhases = FeaturePhaseSchema.options;
    const debugPhases = DebugPhaseSchema.options;
    const refactorPhases = RefactorPhaseSchema.options;

    const allPairs: Array<{ workflowType: string; phase: string }> = [];

    for (const phase of featurePhases) {
      if (TERMINAL_PHASES.has(phase)) continue;
      if (getPlaybook('feature', phase)) {
        allPairs.push({ workflowType: 'feature', phase });
      }
    }
    for (const phase of debugPhases) {
      if (TERMINAL_PHASES.has(phase)) continue;
      if (getPlaybook('debug', phase)) {
        allPairs.push({ workflowType: 'debug', phase });
      }
    }
    for (const phase of refactorPhases) {
      if (TERMINAL_PHASES.has(phase)) continue;
      if (getPlaybook('refactor', phase)) {
        allPairs.push({ workflowType: 'refactor', phase });
      }
    }

    // Sanity check: we should have a reasonable number of pairs
    expect(allPairs.length).toBeGreaterThan(5);

    const arbWorkflowPhase = fc.constantFrom(...allPairs);

    await fc.assert(
      fc.asyncProperty(arbWorkflowPhase, async ({ workflowType, phase }) => {
        // Arrange
        resetMaterializerCache();
        const propDir = await createTempStateDir();
        const featureId = `prop-${workflowType}-${phase}`.replace(/[^a-z0-9-]/g, '-');

        try {
          await writeMockState(propDir, featureId, {
            phase,
            workflowType,
            _checkpoint: {
              timestamp: '2026-01-01T00:00:00Z',
              phase,
              summary: '',
              operationsSince: 0,
              fixCycleCount: 0,
              lastActivityTimestamp: '2026-01-01T00:00:00Z',
              staleAfterMinutes: 120,
            },
          });
          await writeMockEvents(propDir, featureId, [
            {
              type: 'workflow.started',
              data: { featureId, workflowType },
            },
          ]);

          // Act
          const result = await handleAssembleContext({ featureId }, propDir);

          // Assert — behavioral section present and non-empty
          expect(result.contextDocument).toContain('### Behavioral Guidance');

          // The behavioral section should contain at least a skill reference
          expect(result.contextDocument).toContain('**Skill:**');
        } finally {
          await cleanupDir(propDir);
        }
      }),
      { numRuns: 20 },
    );
  });
});
