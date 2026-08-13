// ─── hsm-transition-guard.envelope (#1325 task α-09) ─────────────────────
//
// Property-style assertion: every event emitted by the HSM transition
// guard primitive carries a canonical envelope — non-empty `correlationId`,
// registered `source`, and per-event-type data schema validates.
//
// Three emission paths exist in `hsm-transition-guard.ts`:
//
//   - Line 293 (composite-guard failure path) — when the synchronous HSM
//     walk's composite guard fails, the primitive appends ONLY a
//     `workflow.guard-failed` event (no transition). Exercised by
//     attempting `delegate → review` while task completeness fails.
//
//   - Line 357 (success path) — when guards pass, the primitive appends
//     `workflow.transition` (+ any compound entry/exit siblings the HSM
//     walk produced). Exercised by attempting a clean transition where
//     all guards pass.
//
//   - Line 429 (custom-guard failure path, `emitGuardFailed`) — when a
//     custom (async) guard rejects, the primitive appends a
//     `workflow.guard-failed` event before returning. Exercised by
//     registering a custom guard that always fails for a feature
//     workflow's `delegate → review` transition.
//
// The test exercises each path via `DefaultHSMTransitionGuard.attempt`
// directly, then asserts the canonical envelope on the resulting
// `workflow.transition` / `workflow.guard-failed` / compound entry/exit
// events via the shared helper.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../events/store.js';
import { DefaultHSMTransitionGuard } from './hsm-transition-guard.js';
import { assertCanonicalEnvelope } from './test-helpers/canonical-envelope.js';
import {
  registerCustomWorkflows,
  clearRegisteredGuards,
} from '../config/register.js';
import { unregisterWorkflowType } from './state-machine.js';
import { unextendWorkflowTypeEnum } from './schemas.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

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
  // Tolerate already-unregistered (test only registers conditionally)
  try { unregisterWorkflowType(CUSTOM_WORKFLOW); } catch { /* noop */ }
  try { unextendWorkflowTypeEnum(CUSTOM_WORKFLOW); } catch { /* noop */ }
});

describe('HsmTransitionGuard_AllEmittedEvents_HaveCanonicalEnvelope', () => {
  // Line 357 — success path
  it('hsm-transition-guard.ts:357 — success transition events have canonical envelope', async () => {
    const guard = new DefaultHSMTransitionGuard();
    // Feature workflow (DR-4 #1581): `plan → plan-review` requires the
    // `plan-artifact-exists` guard. Provide an `artifacts.plan` field so the
    // guard passes and the primitive enters the success branch at line 357.
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
    // All emitted events on the success path must carry the canonical
    // envelope. Compound entry/exit events do not have a per-type data
    // schema registered today — those types still need a non-empty
    // correlationId and source.
    assertCanonicalEnvelope(events);
  });

  // Line 293 — composite-guard failure path
  it('hsm-transition-guard.ts:293 — composite-guard-failure event has canonical envelope', async () => {
    const guard = new DefaultHSMTransitionGuard();
    // Feature workflow: `delegate → review` requires the composite guard
    // (all-tasks-complete + team-disbanded). With an incomplete task,
    // the synchronous HSM walk fails — line 293 emits `workflow.guard-failed`.
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
    // Filter to just guard-failure-shaped events (cas-failed / guard-failed)
    // and assert the envelope is canonical. The HSM walk may emit either
    // a `workflow.guard-failed` or `workflow.circuit-open` — both flow
    // through the same line 293 branch.
    const guardFailureEvents = events.filter(
      (e) => e.type === 'workflow.guard-failed' || e.type === 'workflow.circuit-open',
    );
    expect(guardFailureEvents.length).toBeGreaterThan(0);
    assertCanonicalEnvelope(guardFailureEvents);
  });

  // Line 429 — custom-async-guard failure path (emitGuardFailed)
  it('hsm-transition-guard.ts:429 — custom-async-guard failure event has canonical envelope', async () => {
    // The primitive calls `emitGuardFailed` (line 429) only when a
    // *registered custom guard* (async shell-out) fails at line 234.
    // To exercise this, register a custom workflow that extends `feature`
    // and declares an `inception → design` transition whose guard `id`
    // matches a registered failing command. `getRegisteredGuard` looks
    // up via `${workflowType}:${guard.id}`.
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
            'always-fails': { command: 'false' }, // exits non-zero → reject
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
