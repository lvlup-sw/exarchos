/**
 * Tests that each event from `DefaultHSMTransitionGuard.attempt` has the canonical envelope of `assertCanonicalEnvelope`.
 * The tests cover three paths: a success, a failed walk guard, and a failed registered custom guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { DefaultHSMTransitionGuard } from '../../../src/workflow/hsm-transition-guard.js';
import { assertCanonicalEnvelope } from '../../../src/workflow/test-helpers/canonical-envelope.js';
import {
  registerCustomWorkflows,
  clearRegisteredGuards,
} from '../../../src/config/register.js';
import { unregisterWorkflowType } from '../../../src/workflow/state-machine.js';
import { unextendWorkflowTypeEnum } from '../../../src/workflow/schemas.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tempDir: string;
let store: EventStore;
const featureId = 'hsm-envelope-test';
const CUSTOM_WORKFLOW = 'hsm-envelope-feature';

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'hsm-envelope-'));
  store = new EventStore(tempDir);
  await store.initialize();
});

afterEach(async () => {
  await rmrfAsync(tempDir);
  clearRegisteredGuards();
  try { unregisterWorkflowType(CUSTOM_WORKFLOW); } catch { }
  try { unextendWorkflowTypeEnum(CUSTOM_WORKFLOW); } catch { }
});

describe('HsmTransitionGuard_AllEmittedEvents_HaveCanonicalEnvelope', () => {
  /** The state holds `artifacts.plan`, so the `plan-artifact-exists` guard passes. */
  it('hsm-transition-guard.ts:357 — success transition events have canonical envelope', async () => {
    const guard = new DefaultHSMTransitionGuard();
    const state: Record<string, unknown> = {
      featureId,
      phase: 'plan',
      workflowType: 'feature',
      artifacts: { plan: '/tmp/specs/x.md' },
    };

    const result = await guard.attempt(featureId, 'plan', 'plan-review', {
      state,
      workflowType: 'feature',
      eventStore: store,
    });

    expect(result.ok).toBe(true);

    const events = await store.query(featureId);
    expect(events.length).toBeGreaterThan(0);
    assertCanonicalEnvelope(events);
  });

  /**
   * An incomplete task fails the walk guard of the `delegate` to `review` edge.
   * The walk can append `workflow.guard-failed` or `workflow.circuit-open`, so the test checks both types.
   */
  it('hsm-transition-guard.ts:293 — composite-guard-failure event has canonical envelope', async () => {
    const guard = new DefaultHSMTransitionGuard();
    const state: Record<string, unknown> = {
      featureId,
      phase: 'delegate',
      workflowType: 'feature',
      tasks: [{ id: 't1', title: 'task one', status: 'in_progress' }],
      team: { members: [{ id: 'a1' }] },
    };

    const result = await guard.attempt(featureId, 'delegate', 'review', {
      state,
      workflowType: 'feature',
      eventStore: store,
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('guard-failed');
    }

    const events = await store.query(featureId);
    const guardFailureEvents = events.filter(
      (e) => e.type === 'workflow.guard-failed' || e.type === 'workflow.circuit-open',
    );
    expect(guardFailureEvents.length).toBeGreaterThan(0);
    assertCanonicalEnvelope(guardFailureEvents);
  });

  /**
   * `getRegisteredGuard` finds a guard by `<workflowType>:<guard id>`.
   * The test registers a custom workflow whose guard runs `false`, which exits non-zero.
   */
  it('hsm-transition-guard.ts:429 — custom-async-guard failure event has canonical envelope', async () => {
    registerCustomWorkflows({
      workflows: {
        [CUSTOM_WORKFLOW]: {
          extends: 'feature',
          phases: ['inception', 'design'],
          initialPhase: 'inception',
          transitions: [
            { from: 'inception', to: 'design', event: 'progress', guard: 'always-fails' },
          ],
          guards: {
            'always-fails': { command: 'false' },
          },
        },
      },
    });

    const guard = new DefaultHSMTransitionGuard();
    const state: Record<string, unknown> = {
      featureId,
      phase: 'inception',
      workflowType: CUSTOM_WORKFLOW,
    };

    const result = await guard.attempt(featureId, 'inception', 'design', {
      state,
      workflowType: CUSTOM_WORKFLOW,
      eventStore: store,
    });

    expect(result.ok).toBe(false);

    const events = await store.query(featureId);
    const guardFailureEvents = events.filter(
      (e) => e.type === 'workflow.guard-failed',
    );
    expect(guardFailureEvents.length).toBeGreaterThan(0);
    assertCanonicalEnvelope(guardFailureEvents);
  });
});
