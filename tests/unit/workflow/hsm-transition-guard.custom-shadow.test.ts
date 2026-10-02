/**
 * Tests the shadow observer on the early deny of an unregistered custom guard.
 * This deny returns before the `executeTransition` walk and runs no shell command.
 * A throwing observer must not change the result.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { DefaultHSMTransitionGuard } from '../../../src/workflow/hsm-transition-guard.js';
import { registerWorkflowType, unregisterWorkflowType } from '../../../src/workflow/state-machine.js';
import { clearRegisteredGuards } from '../../../src/config/register.js';
import type { LegacyTransitionObservation } from '../../../src/workflow/admission/shadow-decision.js';
import type { WorkflowDefinition } from '../../../src/config/define.js';

const guard = new DefaultHSMTransitionGuard();
const WF = 'p07-02-custom-shadow';

/**
 * A workflow whose `start` to `end` edge names a custom guard.
 * The test registers the HSM directly, so the guard registry holds no entry for that guard.
 */
const definition: WorkflowDefinition = {
  phases: ['start', 'end'],
  initialPhase: 'start',
  transitions: [{ from: 'start', to: 'end', event: 'go', guard: 'needs-approval' }],
  guards: { 'needs-approval': { command: 'exit 1' } },
};

afterEach(() => {
  try {
    unregisterWorkflowType(WF);
  } catch {
  }
  clearRegisteredGuards();
});

describe('HSMTransitionGuard custom-guard early-return shadow (P07-02)', () => {
  it('fires a DENY observation on the unregistered-custom-guard fail-closed path', async () => {
    registerWorkflowType(WF, definition);
    const seen: LegacyTransitionObservation[] = [];
    const result = await guard.attempt('feat', 'start', 'end', {
      state: { phase: 'start' },
      workflowType: WF,
      eventStore: null,
      shadowObserver: (o) => seen.push(o),
    });
    expect(result.ok).toBe(false);
    expect(seen).toEqual([
      {
        workflowType: WF,
        fromPhase: 'start',
        toPhase: 'end',
        legacyOutcome: 'deny',
        idempotent: false,
      },
    ]);
  });

  it('a throwing observer does NOT change the early-return result', async () => {
    registerWorkflowType(WF, definition);
    const withObserver = await guard.attempt('feat', 'start', 'end', {
      state: { phase: 'start' },
      workflowType: WF,
      eventStore: null,
      shadowObserver: () => {
        throw new Error('shadow boom');
      },
    });
    const withoutObserver = await guard.attempt('feat', 'start', 'end', {
      state: { phase: 'start' },
      workflowType: WF,
      eventStore: null,
    });
    expect(withObserver).toEqual(withoutObserver);
    expect(withObserver.ok).toBe(false);
  });

  /** The early-return deny path also waits for the observer write (#2026). */
  it('UnregisteredCustomGuard_ObserverWrite_HasLandedWhenAttemptReturns', async () => {
    registerWorkflowType(WF, definition);
    let landed = false;
    const result = await guard.attempt('feat', 'start', 'end', {
      state: { phase: 'start' },
      workflowType: WF,
      eventStore: null,
      shadowObserver: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            landed = true;
            resolve();
          }, 0);
        }),
    });

    expect(result.ok).toBe(false);
    expect(landed).toBe(true);
  });
});
