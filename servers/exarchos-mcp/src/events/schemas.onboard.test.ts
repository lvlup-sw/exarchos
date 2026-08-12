import { describe, it, expect } from 'vitest';
import {
  EventTypes,
  EVENT_EMISSION_REGISTRY,
  EVENT_DATA_SCHEMAS,
  OnboardRequestedDataSchema,
  OnboardExecutedDataSchema,
  type OnboardRequested,
  type OnboardExecuted,
} from './schemas.js';
import {
  ReconcilePlanSchema,
  ReconcileResultSchema,
  type ReconcilePlan,
  type ReconcileResult,
} from '../dispatch/core/onboarding/types.js';

/**
 * DR-7 (task 008) — the two-event onboard contract. `onboard.requested` records
 * the durable INTENT (the reconcile plan) BEFORE the non-idempotent reconcile
 * fires; `onboard.executed` records the RESULT after it succeeds (INV-1 event
 * sourcing integrity, INV-13 two-event split for non-idempotent side effects).
 *
 * This test widens the event-store contract atomically with the schema, and
 * (since DR-5 / task 018) guards that `init.executed` is GONE — the init
 * verb/handler were retired and `onboard.*` is the audit trail.
 */
describe('EventSchema_OnboardRequestedExecuted_RoundTrips', () => {
  // A real ReconcilePlan from the types module (task 004) — proves the event
  // schema reuses the canonical shape rather than redefining it.
  const plan: ReconcilePlan = ReconcilePlanSchema.parse({
    steps: [
      {
        kind: 'config',
        surface: 'any',
        key: 'exarchos-yml',
        description: 'reconcile .exarchos.yml',
        target: '.exarchos.yml',
      },
      {
        kind: 'install',
        surface: 'cli-only',
        key: 'skills-bundle',
        description: 'install the skills bundle',
      },
    ],
  });

  // A real ReconcileResult from the types module.
  const result: ReconcileResult = ReconcileResultSchema.parse({
    applied: [plan.steps[0]],
    skipped: [],
    residual: [],
    advisories: [
      {
        surface: 'cli-only',
        message: 'run the CLI to install the skills bundle',
        commands: ['exarchos onboard'],
      },
    ],
  });

  it('parses a valid onboard.requested payload (with a real ReconcilePlan)', () => {
    const payload = {
      trigger: 'onboard' as const,
      plan,
      idempotencyKey: 'onboard:abc123',
    };
    const parsed: OnboardRequested = OnboardRequestedDataSchema.parse(payload);
    expect(parsed.trigger).toBe('onboard');
    expect(parsed.plan.steps).toHaveLength(2);
    expect(parsed.idempotencyKey).toBe('onboard:abc123');
  });

  it('accepts every valid trigger on onboard.requested', () => {
    for (const trigger of ['onboard', 'onboard-new', 'doctor-fix'] as const) {
      const parsed = OnboardRequestedDataSchema.parse({
        trigger,
        plan,
        idempotencyKey: `key:${trigger}`,
      });
      expect(parsed.trigger).toBe(trigger);
    }
  });

  it('rejects a malformed onboard.requested (bad trigger)', () => {
    expect(() =>
      OnboardRequestedDataSchema.parse({
        trigger: 'bogus',
        plan,
        idempotencyKey: 'k',
      }),
    ).toThrow();
  });

  it('rejects a malformed onboard.requested (missing idempotencyKey)', () => {
    expect(() =>
      OnboardRequestedDataSchema.parse({ trigger: 'onboard', plan }),
    ).toThrow();
  });

  it('rejects a malformed onboard.requested (empty idempotencyKey)', () => {
    expect(() =>
      OnboardRequestedDataSchema.parse({
        trigger: 'onboard',
        plan,
        idempotencyKey: '',
      }),
    ).toThrow();
  });

  it('parses a valid onboard.executed payload (with a real ReconcileResult)', () => {
    const payload = {
      trigger: 'doctor-fix' as const,
      result,
      idempotencyKey: 'onboard:abc123',
      durationMs: 1234,
    };
    const parsed: OnboardExecuted = OnboardExecutedDataSchema.parse(payload);
    expect(parsed.trigger).toBe('doctor-fix');
    expect(parsed.result.applied).toHaveLength(1);
    expect(parsed.result.advisories).toHaveLength(1);
    expect(parsed.durationMs).toBe(1234);
  });

  it('rejects a malformed onboard.executed (bad trigger)', () => {
    expect(() =>
      OnboardExecutedDataSchema.parse({
        trigger: 'bogus',
        result,
        idempotencyKey: 'k',
        durationMs: 0,
      }),
    ).toThrow();
  });

  it('rejects a malformed onboard.executed (missing idempotencyKey)', () => {
    expect(() =>
      OnboardExecutedDataSchema.parse({ trigger: 'onboard', result, durationMs: 0 }),
    ).toThrow();
  });

  it('rejects a malformed onboard.executed (negative durationMs)', () => {
    expect(() =>
      OnboardExecutedDataSchema.parse({
        trigger: 'onboard',
        result,
        idempotencyKey: 'k',
        durationMs: -1,
      }),
    ).toThrow();
  });

  it('rejects a malformed onboard.executed (non-integer durationMs)', () => {
    expect(() =>
      OnboardExecutedDataSchema.parse({
        trigger: 'onboard',
        result,
        idempotencyKey: 'k',
        durationMs: 1.5,
      }),
    ).toThrow();
  });

  it('registers onboard.requested + onboard.executed in the event-type union', () => {
    expect(EventTypes).toContain('onboard.requested');
    expect(EventTypes).toContain('onboard.executed');
  });

  it('registers both onboard events in the emission registry as auto', () => {
    expect(EVENT_EMISSION_REGISTRY['onboard.requested']).toBe('auto');
    expect(EVENT_EMISSION_REGISTRY['onboard.executed']).toBe('auto');
  });

  it('registers both onboard events in the data-schema map', () => {
    expect(EVENT_DATA_SCHEMAS['onboard.requested']).toBe(OnboardRequestedDataSchema);
    expect(EVENT_DATA_SCHEMAS['onboard.executed']).toBe(OnboardExecutedDataSchema);
  });

  // RETIREMENT GUARD (DR-5 / task 018): the `init` verb + handler + its
  // `init.executed` event are removed in this task. `onboard.requested` /
  // `onboard.executed` are the audit trail now; bare `doctor` keeps the single
  // read-only `diagnostic.executed`. This assertion fails loudly if a future
  // edit re-introduces `init.executed`.
  it('removes init.executed entirely (DR-5 / task 018)', () => {
    expect(EventTypes as readonly string[]).not.toContain('init.executed');
    expect(
      (EVENT_EMISSION_REGISTRY as Record<string, unknown>)['init.executed'],
    ).toBeUndefined();
    expect(
      (EVENT_DATA_SCHEMAS as Record<string, unknown>)['init.executed'],
    ).toBeUndefined();
    // diagnostic.executed is retained for the doctor composite.
    expect(EventTypes).toContain('diagnostic.executed');
  });
});
