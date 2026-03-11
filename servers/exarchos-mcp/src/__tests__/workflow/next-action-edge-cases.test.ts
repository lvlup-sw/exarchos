import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleNextAction, configureNextActionEventStore } from '../../workflow/next-action.js';
import { handleInit, configureWorkflowEventStore } from '../../workflow/tools.js';
import { EventStore } from '../../event-store/store.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-next-action-edge-'));
});

afterEach(async () => {
  configureNextActionEventStore(null);
  configureWorkflowEventStore(null);
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Read the raw state JSON from disk, bypassing Zod validation.
 */
async function readRawState(featureId: string): Promise<Record<string, unknown>> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  return JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
}

/**
 * Write the raw state JSON to disk, bypassing Zod validation.
 */
async function writeRawState(
  featureId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

describe('handleNextAction edge cases', () => {
  // ─── T-13.1: Guard evaluation throws returns GUARD_FAILED ────────────────

  describe('NextAction_GuardEvaluationThrows_ReturnsGuardFailed', () => {
    it('should return GUARD_FAILED when a guard evaluate function throws', async () => {
      // Arrange: create a feature workflow in 'ideate' phase
      // The ideate->plan transition has a guard (design artifact exists).
      // We mock the guard to throw an error.
      await handleInit({ featureId: 'guard-throw', workflowType: 'feature' }, tmpDir);

      // Mock the HSM definition to inject a throwing guard
      const stateMachineModule = await import('../../workflow/state-machine.js');
      const originalGetHSM = stateMachineModule.getHSMDefinition;

      vi.spyOn(stateMachineModule, 'getHSMDefinition').mockImplementation((wfType: string) => {
        const hsm = originalGetHSM(wfType);
        // Replace transitions with a version that has a throwing guard
        const modifiedTransitions = hsm.transitions.map((t) => {
          if (t.from === 'ideate' && t.to === 'plan' && t.guard) {
            return {
              ...t,
              guard: {
                ...t.guard,
                evaluate: () => {
                  throw new Error('Guard internal error');
                },
              },
            };
          }
          return t;
        });
        return { ...hsm, transitions: modifiedTransitions };
      });

      // Act
      const result = await handleNextAction({ featureId: 'guard-throw' }, tmpDir);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GUARD_FAILED');
      expect(result.error?.message).toContain('Guard internal error');
      expect(result.error?.message).toContain('ideate');
    });
  });

  // ─── T-13.2: Guard returns object — handles non-boolean result ────────────

  describe('NextAction_GuardReturnsObject_HandlesNonBooleanResult', () => {
    it('should correctly evaluate a guard returning { passed: true } object', async () => {
      // Arrange: create a feature workflow in 'ideate' phase
      await handleInit({ featureId: 'guard-obj', workflowType: 'feature' }, tmpDir);

      // Mock HSM to inject a guard that returns { passed: true } (non-boolean object)
      const stateMachineModule = await import('../../workflow/state-machine.js');
      const originalGetHSM = stateMachineModule.getHSMDefinition;

      vi.spyOn(stateMachineModule, 'getHSMDefinition').mockImplementation((wfType: string) => {
        const hsm = originalGetHSM(wfType);
        const modifiedTransitions = hsm.transitions.map((t) => {
          if (t.from === 'ideate' && t.to === 'plan' && t.guard) {
            return {
              ...t,
              guard: {
                ...t.guard,
                // Return an object with passed: true (not a boolean `true`)
                evaluate: () => ({ passed: true } as unknown as import('../../workflow/guards.js').GuardResult),
              },
            };
          }
          return t;
        });
        return { ...hsm, transitions: modifiedTransitions };
      });

      // Act
      const result = await handleNextAction({ featureId: 'guard-obj' }, tmpDir);

      // Assert: guard should be considered as passing
      // The action should indicate transition to the next phase
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.phase).toBe('ideate');
      // The guard passed, so we should get an AUTO: action to the target
      expect((data.action as string).startsWith('AUTO:')).toBe(true);
    });
  });

  // ─── T-13.3: Circuit breaker open returns BLOCKED ─────────────────────────

  describe('NextAction_CircuitBreakerOpen_ReturnsBlocked', () => {
    it('should return BLOCKED:circuit-open when 3+ fix-cycle events exist', async () => {
      // Arrange: use feature workflow in 'review' phase — the review->delegate
      // transition is the only fix-cycle transition in the feature HSM.
      // The review phase is a child of the 'implementation' compound state
      // with maxFixCycles: 3.
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);
      configureNextActionEventStore(eventStore);

      await handleInit({ featureId: 'cb-open', workflowType: 'feature' }, tmpDir);

      const rawState = await readRawState('cb-open');
      rawState.phase = 'review';
      rawState._history = { feature: 'review' };
      await writeRawState('cb-open', rawState);

      // The compound parent for 'review' in feature HSM is 'implementation'
      const compoundStateId = 'implementation';

      // Emit a compound-entry event first (required by getFixCycleCountFromStore)
      await eventStore.append('cb-open', {
        type: 'workflow.compound-entry',
        data: { compoundStateId, featureId: 'cb-open' },
      });

      // Emit 3 fix-cycle events to trip the circuit breaker
      for (let i = 0; i < 3; i++) {
        await eventStore.append('cb-open', {
          type: 'workflow.fix-cycle',
          data: {
            compoundStateId,
            count: i + 1,
            featureId: 'cb-open',
          },
        });
      }

      // Mock the anyReviewFailed guard to pass so the fix-cycle transition
      // is attempted and the circuit breaker check is reached
      const stateMachineModule = await import('../../workflow/state-machine.js');
      const originalGetHSM = stateMachineModule.getHSMDefinition;

      vi.spyOn(stateMachineModule, 'getHSMDefinition').mockImplementation((wfType: string) => {
        const hsm = originalGetHSM(wfType);
        const modifiedTransitions = hsm.transitions.map((t) => {
          if (t.from === 'review' && t.isFixCycle && t.guard) {
            return {
              ...t,
              guard: {
                ...t.guard,
                evaluate: () => true as import('../../workflow/guards.js').GuardResult,
              },
            };
          }
          return t;
        });
        return { ...hsm, transitions: modifiedTransitions };
      });

      // Act
      const result = await handleNextAction({ featureId: 'cb-open' }, tmpDir);

      // Assert: circuit breaker should block
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect((data.action as string)).toContain('BLOCKED:circuit-open');
      expect(data.fixCycleCount).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── T-13.4: Empty/minimal state returns default recommendation ───────────

  describe('NextAction_EmptyState_ReturnsDefaultRecommendation', () => {
    it('should return valid recommendation for minimal initial state without crash', async () => {
      // Arrange: create a fresh feature workflow (initial state: ideate)
      await handleInit({ featureId: 'empty-state', workflowType: 'feature' }, tmpDir);

      // Act: call next-action on a minimal, fresh state
      const result = await handleNextAction({ featureId: 'empty-state' }, tmpDir);

      // Assert: should not crash, should return a valid recommendation
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.phase).toBe('ideate');
      // Either WAIT:in-progress (no guard passes) or AUTO:next-phase
      expect(data.action).toBeDefined();
      expect(typeof data.action).toBe('string');
    });
  });

  // ─── T-13.5: Unknown phase handles gracefully ─────────────────────────────

  describe('NextAction_UnknownPhase_HandlesGracefully', () => {
    it('should return STATE_CORRUPT in-band when state file contains an invalid phase', async () => {
      // Arrange: create a workflow and mutate its phase to something unknown.
      // The WorkflowStateSchema is a union of FeatureWorkflowStateSchema,
      // DebugWorkflowStateSchema, RefactorWorkflowStateSchema, and
      // CustomWorkflowStateSchema. A feature workflow with phase 'nonexistent-phase'
      // will fail Zod validation in readStateFile, throwing StateStoreError
      // with code STATE_CORRUPT. handleNextAction catches this and returns
      // a structured error result.
      await handleInit({ featureId: 'unknown-phase', workflowType: 'feature' }, tmpDir);

      const rawState = await readRawState('unknown-phase');
      rawState.phase = 'nonexistent-phase';
      rawState._history = { feature: 'nonexistent-phase' };
      await writeRawState('unknown-phase', rawState);

      // Act
      const result = await handleNextAction({ featureId: 'unknown-phase' }, tmpDir);

      // Assert: should return structured error, not throw
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATE_CORRUPT');
      expect(result.error?.message).toContain('unknown-phase');
    });
  });
});
