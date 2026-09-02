import { describe, expect, it } from 'vitest';
import { envelopeWrap } from '../../src/envelope-wrap.js';
import type { ToolResult } from '../../src/format.js';
import {
  isControlOwnedVerb,
  isRegistryAdvertisement,
  NextAction,
  type RegistryAdvertisement,
} from '../../src/next-action.js';
import {
  nextActionEnvelopesFromResult,
  nextActionsFromResult,
} from '../../src/next-actions-from-result.js';
import { nextActionReducer } from '../../src/projections/next-action/reducer.js';
import { getHSMDefinition } from '../../src/workflow/state-machine.js';

const ADVERTISE_AT = '2026-01-01T00:00:00.000Z';
const GET_ACTION_ID = 'exarchos_workflow.get';
const HOST_OWNED_ACTION_ID = 'exarchos_orchestrate.check_coderabbit';
const GATED_ACTION_ID = 'exarchos_orchestrate.check_polish_scope';
const REQUIRES_ACTION_ID = 'exarchos_orchestrate.pre_synthesis_check';

function advertiseAuth(capabilityIds: readonly string[] = ['fs:read', 'shell:exec']) {
  return {
    authorizationId: 'authorization-advertise-001',
    posture: 'read-only' as const,
    capabilityIds,
    resolverVersion: '1.0',
    resolvedAt: ADVERTISE_AT,
  };
}

function workflowPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: 'plan',
    workflowType: 'feature',
    featureId: 'feat-advertise',
    stream: 'feat-advertise',
    updatedAt: ADVERTISE_AT,
    artifacts: {},
    tasks: [],
    reviews: {},
    evidence: [],
    authorization: advertiseAuth(),
    ...over,
  };
}

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function advertisedFrom(result: ToolResult): readonly RegistryAdvertisement[] {
  return nextActionEnvelopesFromResult(result).registry;
}

function advertisedFromWrap(data: unknown): readonly RegistryAdvertisement[] {
  const env = envelopeWrap(ok(data), 0) as ToolResult & {
    advertised_actions?: readonly RegistryAdvertisement[];
  };
  return env.advertised_actions ?? [];
}

describe('action-contract next_actions — allow-only registry advertisements', () => {
  it('NextActions_Denied_IsNotAdvertised', () => {
    const ids = advertisedFrom(
      ok(
        workflowPayload({
          phase: 'synthesize',
          evidence: [],
        }),
      ),
    ).map((a) => a.actionId);
    expect(ids).not.toContain(REQUIRES_ACTION_ID);
  });

  it('NextActions_Indeterminate_IsNotAdvertised', () => {
    const ids = advertisedFrom(
      ok(workflowPayload({ authorization: { posture: 'read-only' } })),
    ).map((a) => a.actionId);
    expect(ids).not.toContain(GET_ACTION_ID);
    expect(ids).toEqual([]);
  });

  it('NextActions_AdjudicationFault_IsNotAdvertised', () => {
    const faultingAuth = new Proxy(
      {},
      {
        get() {
          throw new Error('admission evaluation fault');
        },
      },
    );
    const ids = advertisedFrom(ok(workflowPayload({ authorization: faultingAuth }))).map(
      (a) => a.actionId,
    );
    expect(ids).not.toContain(GET_ACTION_ID);
    expect(ids).toEqual([]);
  });

  it('NextActions_TopologyFallback_IsNotAdvertised', () => {
    const result = ok({ phase: 'plan-review', workflowType: 'feature' });
    const control = nextActionsFromResult(result);
    const registry = advertisedFrom(result);
    expect(control.map((a) => a.verb)).toContain('delegate');
    expect(registry).toEqual([]);
    expect(advertisedFromWrap({ phase: 'plan-review', workflowType: 'feature' })).toEqual([]);
  });

  it('NextActions_PhaseVerb_IsNotAnActionId', () => {
    const control = nextActionsFromResult(
      ok({ phase: 'plan', workflowType: 'feature' }),
    );
    const registry = advertisedFrom(ok(workflowPayload({ phase: 'plan' })));
    const phaseVerb = control.find((a) => a.verb === 'plan-review');
    expect(phaseVerb).toBeDefined();
    expect(phaseVerb).not.toHaveProperty('actionId');
    expect(isRegistryAdvertisement(phaseVerb)).toBe(false);
    expect(registry.every((a) => a.actionId !== 'plan-review')).toBe(true);
    expect(registry.every((a) => a.actionId !== 'plan')).toBe(true);
  });

  it('NextActions_RetryWithTask_IsNotAnActionId', () => {
    const parsed = NextAction.parse({
      verb: 'retry_with_task',
      reason: 're-invoke with task TTL',
      ttl_suggestion_ms: 60_000,
    });
    expect(isControlOwnedVerb(parsed.verb)).toBe(true);
    expect(isRegistryAdvertisement(parsed)).toBe(false);
    const ids = advertisedFrom(ok(workflowPayload())).map((a) => a.actionId);
    expect(ids).not.toContain('retry_with_task');
  });

  it('NextActions_DivergentLoop_IsNotAnActionId', () => {
    const hsm = getHSMDefinition('feature');
    const control = nextActionReducer.derive(
      { phase: 'plan', workflowType: 'feature' },
      hsm,
    );
    const deep = nextActionsFromResult(
      ok({ phase: 'plan', workflowType: 'feature', designDepth: 'deep' }),
    );
    // designDepth is not lifted from the result payload; the control verb is
    // still a schema member and is outside ActionId totality.
    expect(control.every((a) => a.verb !== 'divergent_loop' || !('actionId' in a))).toBe(true);
    expect(isControlOwnedVerb('divergent_loop')).toBe(true);
    expect(advertisedFrom(ok(workflowPayload())).map((a) => a.actionId)).not.toContain(
      'divergent_loop',
    );
    expect(deep.every((a) => !('actionId' in a))).toBe(true);
  });

  it('NextActions_MissingAuth_OmitsCapabilityGatedActionIds', () => {
    const { authorization: _dropped, ...withoutAuth } = workflowPayload();
    const ids = advertisedFrom(ok(withoutAuth)).map((a) => a.actionId);
    expect(ids).not.toContain(GATED_ACTION_ID);
    expect(ids).toEqual([]);
  });

  it('NextActions_HostOwned_AdvertisedWhenLocalChecksPass', () => {
    const advertised = advertisedFromWrap(workflowPayload());
    const hostOwned = advertised.find((a) => a.actionId === HOST_OWNED_ACTION_ID);
    expect(hostOwned).toBeDefined();
    expect(hostOwned?.subject).toEqual({
      featureId: 'feat-advertise',
      stream: 'feat-advertise',
    });
    expect(isRegistryAdvertisement(hostOwned)).toBe(true);
  });

  it('NextActions_MergeOrchestrate_RehydrateTopology_StillPublishes', () => {
    const result = ok({
      workflowState: {
        featureId: 'p2-detour',
        phase: 'merge-pending',
        workflowType: 'feature',
        mergeOrchestrator: { taskId: '001', phase: 'pending' },
      },
    });
    const { control, registry } = nextActionEnvelopesFromResult(result);
    expect(control.map((a) => a.verb)).toContain('merge_orchestrate');
    expect(registry).toEqual([]);
    expect(advertisedFromWrap(result.data)).toEqual([]);
  });

  it('NextActions_Advertised_UsesWorkflowScopedSubject', () => {
    const advertised = advertisedFrom(
      ok(
        workflowPayload({
          featureId: 'feat-alpha',
          stream: 'stream-alpha',
          target: 'review',
          payload: { target: 'review' },
          now: '2099-01-01T00:00:00.000Z',
        }),
      ),
    );
    const get = advertised.find((a) => a.actionId === GET_ACTION_ID);
    expect(get).toBeDefined();
    expect(get?.subject).toEqual({ featureId: 'feat-alpha', stream: 'stream-alpha' });
    expect(get).not.toHaveProperty('target');
    expect(get).not.toHaveProperty('payload');
    expect(get).not.toHaveProperty('now');
    const viaReducer = nextActionReducer.deriveAdvertised({
      phase: 'plan',
      workflowType: 'feature',
      actionAdmission: {
        subject: { featureId: 'feat-alpha', stream: 'stream-alpha' },
        evidence: [],
        authorization: advertiseAuth(),
        hsmFacts: { phase: 'plan' },
        actionIds: [GET_ACTION_ID],
      },
    });
    expect(viaReducer[0]?.subject).toEqual({
      featureId: 'feat-alpha',
      stream: 'stream-alpha',
    });
  });
});
