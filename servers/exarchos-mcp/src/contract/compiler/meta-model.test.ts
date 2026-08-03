import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { EnvelopeSchema } from '../../schemas/envelope.js';
import type { CompositeTool, ToolAction } from '../../registry.js';
import { layerCodes } from '../error-families.js';
import { CONTRACT_SURFACE_VERSION } from '../compatibility.js';
import { OUTPUT_KINDS } from '../envelope.js';
import { canonicalJson } from '../request-context.js';
import {
  ActionMetaModelSchema,
  POLICY_DIMENSIONS,
  deriveErrorCodes,
  deriveActionMetaModel,
  deriveMetaModel,
  derivePolicy,
} from './meta-model.js';

// ─── Test fixtures — synthetic registry entries ──────────────────────────────

function makeAction(overrides: Partial<ToolAction> & { name: string }): ToolAction {
  return {
    description: 'a synthetic action',
    schema: z.object({ x: z.string() }),
    phases: new Set<string>(),
    roles: new Set<string>(['lead']),
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: {
      safety: 'read-only',
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    ...overrides,
  };
}

function makeTool(name: string, actions: readonly ToolAction[]): CompositeTool {
  return { name, description: `tool ${name}`, actions };
}

describe('deriveMetaModel — derived from the live registry', () => {
  it('DerivesEveryActionWithAllTenPolicyDimensions', () => {
    const mm = deriveMetaModel();
    expect(mm.surfaceVersion).toBe(CONTRACT_SURFACE_VERSION);
    expect(mm.actions.length).toBeGreaterThan(100);
    for (const entry of mm.actions) {
      // Every derived entry is a valid meta-model entry …
      expect(ActionMetaModelSchema.safeParse(entry).success).toBe(true);
      // … and carries all ten policy dimensions.
      for (const dim of POLICY_DIMENSIONS) {
        expect(entry.policy).toHaveProperty(dim);
      }
      expect(entry.outputKinds).toEqual([...OUTPUT_KINDS].sort());
    }
  });

  it('IsByteStableAcrossRepeatedDerivation', () => {
    expect(canonicalJson(deriveMetaModel())).toBe(canonicalJson(deriveMetaModel()));
  });

  it('SortsActionsByActionId', () => {
    const ids = deriveMetaModel().actions.map((a) => a.actionId);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('deriveErrorCodes — task-layer codes are gated on task policy', () => {
  it('OmitsTaskLayerCodesForAPlainSynchronousAction', () => {
    const codes = deriveErrorCodes(makeAction({ name: 'plain' }));
    // WAIT_TIMEOUT belongs to the task layer; a non-task action must not claim it.
    expect(codes).not.toContain('WAIT_TIMEOUT');
    expect(codes).toContain('HANDLER_ERROR');
    expect(codes).toContain('AUTHORIZATION_DENIED');
  });

  it('IncludesTaskLayerCodesForATaskSuitableAction', () => {
    const codes = deriveErrorCodes(makeAction({ name: 'durable', dispatch: { taskSuitable: true } }));
    for (const taskCode of layerCodes('task')) {
      expect(codes).toContain(taskCode);
    }
  });

  it('IncludesTaskLayerCodesForALongRunningAction', () => {
    const codes = deriveErrorCodes(makeAction({ name: 'slow', longRunning: true }));
    expect(codes).toContain('WAIT_TIMEOUT');
  });
});

describe('derivePolicy — faithful projection of registry semantics', () => {
  it('MarksMutationAndCacheabilityFromAnnotations', () => {
    const readOnly = derivePolicy(makeAction({ name: 'ro' }));
    expect(readOnly.effect.mutates).toBe(false);
    expect(readOnly.cache.cacheable).toBe(true); // readOnly && idempotent

    const writer = derivePolicy(
      makeAction({
        name: 'rw',
        annotations: {
          safety: 'local-mutation',
          readOnly: false,
          destructive: false,
          idempotent: false,
          openWorld: false,
        },
      }),
    );
    expect(writer.effect.mutates).toBe(true);
    expect(writer.cache.cacheable).toBe(false);
  });

  it('DerivesCancellabilityFromTaskAndLongRunningFlags', () => {
    expect(derivePolicy(makeAction({ name: 'a' })).cancellation.cancellable).toBe(false);
    expect(
      derivePolicy(makeAction({ name: 'b', longRunning: true })).cancellation.cancellable,
    ).toBe(true);
    expect(
      derivePolicy(makeAction({ name: 'c', dispatch: { taskSuitable: true } })).cancellation
        .cancellable,
    ).toBe(true);
  });
});

describe('deriveMetaModel — line-ending platform stability', () => {
  it('NormalizesCrlfDescriptionsToMatchLf', () => {
    const crlf = makeTool('exarchos_probe', [
      makeAction({ name: 'probe', description: 'line one\r\nline two\r\n' }),
    ]);
    const lf = makeTool('exarchos_probe', [
      makeAction({ name: 'probe', description: 'line one\nline two' }),
    ]);
    // A CRLF working tree and an LF checkout derive a byte-identical meta-model.
    expect(canonicalJson(deriveMetaModel([crlf]))).toBe(canonicalJson(deriveMetaModel([lf])));
    const entry = deriveActionMetaModel(crlf, crlf.actions[0]!);
    expect(entry.description).not.toContain('\r');
  });
});
