// ─── P07-02 — shadow seam extended to custom-guard early-return deny paths ─────
//
// P07-01 fired the shadow observer only after the synchronous composite HSM
// walk (Step 3). P07-02 extends it to the Step-2 custom-guard early-return deny
// paths so the observer sees EVERY authoritative legacy `deny`, not only those
// produced by the composite walk. This pins the deterministic
// unregistered-custom-guard fail-closed path (no shell-out): it must surface a
// `deny` observation AND remain behaviour-preserving (a throwing observer cannot
// change the result). The registered-custom-guard-failed path fires through the
// identical `notifyShadowObserver` helper.

import { afterEach, describe, expect, it } from 'vitest';

import { DefaultHSMTransitionGuard } from '../../../src/workflow/hsm-transition-guard.js';
import { registerWorkflowType, unregisterWorkflowType } from '../../../src/workflow/state-machine.js';
import { clearRegisteredGuards } from '../../../src/config/register.js';
import type { LegacyTransitionObservation } from '../../../src/workflow/admission/shadow-decision.js';
import type { WorkflowDefinition } from '../../../src/config/define.js';

const guard = new DefaultHSMTransitionGuard();
const WF = 'p07-02-custom-shadow';

// A custom workflow whose `start → end` edge references a custom guard. Because
// this test registers the HSM directly (NOT via `registerCustomWorkflows`), the
// guard is present on the HSM edge (`custom: true`) but absent from the runtime
// guard registry — driving the fail-closed unregistered-custom-guard deny path.
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
    // already removed
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
});
