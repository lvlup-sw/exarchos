import { describe, it, expect } from 'vitest';
import {
  EventTypes,
  EVENT_EMISSION_REGISTRY,
  EVENT_DATA_SCHEMAS,
  OnboardRequestedDataSchema,
  OnboardExecutedDataSchema,
  type OnboardRequested,
  type OnboardExecuted,
} from '../../../src/events/schemas.js';
import {
  ReconcilePlanSchema,
  ReconcileResultSchema,
  type ReconcilePlan,
  type ReconcileResult,
} from '../../../src/dispatch/core/onboarding/types.js';

/**
 * The two-event contract for onboarding. `onboard.requested` records the reconcile plan before
 * the non-idempotent reconcile runs. `onboard.executed` records the result after the reconcile
 * succeeds.
 *
 * The two fixtures parse through `ReconcilePlanSchema` and `ReconcileResultSchema`, so the event
 * schemas must accept the canonical shapes.
 */
describe('EventSchema_OnboardRequestedExecuted_RoundTrips', () => {
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

  /**
   * `onboard.requested` and `onboard.executed` are the audit trail of onboarding, so no
   * `init.executed` event exists. The `doctor` action still appends `diagnostic.executed` when it
   * runs without `--fix`.
   */
  it('removes init.executed entirely (DR-5 / task 018)', () => {
    expect(EventTypes as readonly string[]).not.toContain('init.executed');
    expect(
      (EVENT_EMISSION_REGISTRY as Record<string, unknown>)['init.executed'],
    ).toBeUndefined();
    expect(
      (EVENT_DATA_SCHEMAS as Record<string, unknown>)['init.executed'],
    ).toBeUndefined();
    expect(EventTypes).toContain('diagnostic.executed');
  });
});
