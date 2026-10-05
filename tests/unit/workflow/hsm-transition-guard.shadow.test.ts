/**
 * Tests the `shadowObserver` hook of `GuardContext`.
 * The observer receives the legacy allow or deny outcome.
 * A throw or a rejection in the observer must not change the transition result.
 */

import { describe, it, expect } from 'vitest';
import { DefaultHSMTransitionGuard } from '../../../src/workflow/hsm-transition-guard.js';
import type { LegacyTransitionObservation } from '../../../src/workflow/admission/shadow-decision.js';

const guard = new DefaultHSMTransitionGuard();
const featureId = 'shadow-hook-test';

/** In the feature HSM, the `plan-artifact-exists` guard protects the `plan` to `plan-review` edge. */
const passState = { featureId, phase: 'plan', artifacts: { plan: 'docs/x.md' } };
const failState = { featureId, phase: 'plan' };

describe('HSMTransitionGuard_ShadowHook (P07-01)', () => {
  it('surfaces an ALLOW observation for a passing legacy transition', async () => {
    const seen: LegacyTransitionObservation[] = [];
    const result = await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...passState },
      workflowType: 'feature',
      eventStore: null,
      shadowObserver: (o) => seen.push(o),
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      {
        workflowType: 'feature',
        fromPhase: 'plan',
        toPhase: 'plan-review',
        legacyOutcome: 'allow',
        idempotent: false,
      },
    ]);
  });

  it('surfaces a DENY observation for a failing legacy transition', async () => {
    const seen: LegacyTransitionObservation[] = [];
    const result = await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...failState },
      workflowType: 'feature',
      eventStore: null,
      shadowObserver: (o) => seen.push(o),
    });
    expect(result.ok).toBe(false);
    expect(seen[0]?.legacyOutcome).toBe('deny');
  });

  it('a THROWING observer does NOT change the transition result (allow path)', async () => {
    const withObserver = await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...passState },
      workflowType: 'feature',
      eventStore: null,
      shadowObserver: () => {
        throw new Error('shadow boom');
      },
    });
    const withoutObserver = await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...passState },
      workflowType: 'feature',
      eventStore: null,
    });
    expect(withObserver).toEqual(withoutObserver);
    expect(withObserver.ok).toBe(true);
  });

  it('a THROWING observer does NOT change the transition result (deny path)', async () => {
    const withObserver = await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...failState },
      workflowType: 'feature',
      eventStore: null,
      shadowObserver: () => {
        throw new Error('shadow boom');
      },
    });
    const withoutObserver = await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...failState },
      workflowType: 'feature',
      eventStore: null,
    });
    expect(withObserver).toEqual(withoutObserver);
    expect(withObserver.ok).toBe(false);
  });
});

/** An observer whose write lands one macrotask later, and a flag that says it landed. */
function slowObserver(): { observer: () => Promise<void>; landed: () => boolean } {
  let done = false;
  return {
    observer: () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          done = true;
          resolve();
        }, 0);
      }),
    landed: () => done,
  };
}

describe('HSMTransitionGuard_ShadowHook waits for the observer write (#2026)', () => {
  it('ShadowObserver_DenyPath_WriteHasLandedWhenAttemptReturns', async () => {
    const slow = slowObserver();
    const result = await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...failState },
      workflowType: 'feature',
      eventStore: null,
      shadowObserver: slow.observer,
    });

    expect(result.ok).toBe(false);
    expect(slow.landed()).toBe(true);
  });

  it('ShadowObserver_AllowPath_WriteHasLandedWhenAttemptReturns', async () => {
    const slow = slowObserver();
    const result = await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...passState },
      workflowType: 'feature',
      eventStore: null,
      shadowObserver: slow.observer,
    });

    expect(result.ok).toBe(true);
    expect(slow.landed()).toBe(true);
  });

  it('ShadowObserver_RejectedWrite_DoesNotChangeTheResult', async () => {
    const withObserver = await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...failState },
      workflowType: 'feature',
      eventStore: null,
      shadowObserver: () => Promise.reject(new Error('shadow write failed')),
    });
    const withoutObserver = await guard.attempt(featureId, 'plan', 'plan-review', {
      state: { ...failState },
      workflowType: 'feature',
      eventStore: null,
    });

    expect(withObserver).toEqual(withoutObserver);
  });
});
