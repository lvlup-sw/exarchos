// @oracle-sources: ../../../src/registry/action-contract.ts, the contract shapes this file constructs by hand — including the deliberately ill-formed ones the normalizer is required to reject rather than silently repair
//
// The normalizer is judged against inputs the test author chose, not against a
// second pass of itself. The rejection cases are the half that matters: an
// idempotence property alone is satisfied by a normalizer that does nothing.

import { fc } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  ActionContractError,
  actionContractCanonicalBytes,
  contractEmissionsOf,
  declared,
  none,
  normalizeActionContract,
  withActionContract,
  type ActionContract,
  type ActionEmission,
} from '../../../src/registry/action-contract.js';
import { RequirementIdSchema } from '../../../src/workflow/admission/types.js';

const NONE = none('read-only query has no additional obligations');

function validContract(overrides: Partial<ActionContract> = {}): ActionContract {
  return {
    requires: NONE,
    ensures: NONE,
    needs: NONE,
    touches: { frame: 'single-machine', resources: NONE },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'safe-repeat' },
    emissions: NONE,
    ...overrides,
  };
}

describe('action-contract algebra', () => {
  it('DeclaredSet_EmptyValues_IsRejected', () => {
    expect(() =>
      normalizeActionContract(
        validContract({
          requires: { kind: 'declared', values: [] as unknown as [never, ...never[]] },
        }),
      ),
    ).toThrow(ActionContractError);
    try {
      normalizeActionContract(
        validContract({
          needs: { kind: 'declared', values: [] as unknown as [never, ...never[]] },
        }),
      );
      expect.fail('expected empty declared set to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractError);
      expect((error as ActionContractError).code).toBe('EMPTY_DECLARED_SET');
    }
  });

  it('ActionContract_BlankAbstention_IsRejected', () => {
    expect(() =>
      normalizeActionContract(validContract({ emissions: { kind: 'none', because: '   ' } })),
    ).toThrow(ActionContractError);
    try {
      normalizeActionContract(validContract({ ensures: { kind: 'none', because: '' } }));
      expect.fail('expected blank abstention to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractError);
      expect((error as ActionContractError).code).toBe('BLANK_ABSTENTION');
    }
    expect(() => none('')).toThrow(ActionContractError);
  });

  it('NormalizeEmission_NonAutoEventSource_IsRejected', () => {
    // 'task.assigned' is a real catalog event whose EVENT_EMISSION_REGISTRY
    // source is 'model' (a workflow definition composes the emission), not
    // 'auto' — exactly the shape an action's own emissions declaration must
    // not be allowed to claim.
    const badEmission: ActionEmission = {
      event: 'task.assigned',
      condition: 'always',
      owner: 'planner',
      role: 'primary',
    };
    try {
      normalizeActionContract(validContract({ emissions: declared(badEmission) }));
      expect.fail('expected a non-auto emission source to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractError);
      if (error instanceof ActionContractError) {
        expect(error.code).toBe('NON_AUTO_EMISSION_SOURCE');
        expect(error.message).toContain('task.assigned');
      }
    }
  });

  it('ActionContract_Normalization_IsByteStable', () => {
    const shuffled = validContract({
      needs: {
        kind: 'declared',
        values: ['shell:exec', 'fs:read', 'fs:write'],
      },
      requires: {
        kind: 'declared',
        values: [
          { kind: 'corroboration', minimum: 2 },
          { family: 'ladder', gate: 'check_test_adequacy' },
          { kind: 'approvals', minimum: 1 },
          { family: 'ladder', gate: 'check_static_analysis' },
        ],
      },
      touches: {
        frame: 'single-machine',
        resources: {
          kind: 'declared',
          values: [
            { kind: 'git-ref', selector: 'refs/heads/main' },
            { kind: 'stream', selector: 'feature-a' },
            { kind: 'path', selector: 'src/registry' },
          ],
        },
      },
    });
    const first = normalizeActionContract(shuffled);
    const second = normalizeActionContract({
      ...shuffled,
      needs: { kind: 'declared', values: ['fs:write', 'shell:exec', 'fs:read'] },
    });
    expect(actionContractCanonicalBytes(first)).toBe(actionContractCanonicalBytes(second));
    expect(first.needs).toEqual({ kind: 'declared', values: ['fs:read', 'fs:write', 'shell:exec'] });
    expect(normalizeActionContract(first)).toEqual(first);
  });

  it('ActionRequirement_FreezeTimeId_IsRejected', () => {
    const requirementId = RequirementIdSchema.parse('req.freeze-time-token');
    expect(() =>
      normalizeActionContract(
        validContract({
          requires: { kind: 'declared', values: [requirementId] },
        }),
      ),
    ).toThrow(ActionContractError);
    try {
      normalizeActionContract(
        validContract({
          requires: { kind: 'declared', values: [{ requirementId }] },
        }),
      );
      expect.fail('expected freeze-time requirement id to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractError);
      expect((error as ActionContractError).code).toBe('FREEZE_TIME_REQUIREMENT_ID');
    }
  });

  it('ActionResource_UnknownKind_IsRejected', () => {
    try {
      normalizeActionContract(
        validContract({
          touches: {
            frame: 'single-machine',
            resources: {
              kind: 'declared',
              values: [{ kind: 'socket', selector: '/tmp/exarchos.sock' }],
            },
          },
        }),
      );
      expect.fail('expected unknown resource kind to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractError);
      expect((error as ActionContractError).code).toBe('UNKNOWN_RESOURCE_KIND');
    }
  });

  it('Needs_UnknownCapability_IsRejected', () => {
    try {
      normalizeActionContract(
        validContract({
          needs: { kind: 'declared', values: ['host:browser'] },
        }),
      );
      expect.fail('expected unknown capability to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractError);
      expect((error as ActionContractError).code).toBe('UNKNOWN_CAPABILITY');
    }
  });

  it('AgentSpawn_RequiresSubagentSpawn', () => {
    const hostSpawn = {
      executionAuthority: { kind: 'host' as const, obligation: 'agent-spawn' as const },
    };
    expect(() => normalizeActionContract(validContract(hostSpawn))).toThrow(ActionContractError);
    try {
      normalizeActionContract(
        validContract({
          ...hostSpawn,
          needs: { kind: 'declared', values: ['fs:read'] },
        }),
      );
      expect.fail('expected agent-spawn without subagent:spawn to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractError);
      expect((error as ActionContractError).code).toBe('AGENT_SPAWN_REQUIRES_SUBAGENT_SPAWN');
    }
    const accepted = normalizeActionContract(
      validContract({
        ...hostSpawn,
        needs: { kind: 'declared', values: ['subagent:spawn'] },
        replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      }),
    );
    expect(accepted.executionAuthority).toEqual(hostSpawn.executionAuthority);
    expect(accepted.needs).toEqual({ kind: 'declared', values: ['subagent:spawn'] });
  });

  it('LocalAndHost_AreMutuallyExclusive', () => {
    try {
      normalizeActionContract({
        ...validContract(),
        executionAuthority: { kind: 'local', obligation: 'human-approval' },
      });
      expect.fail('expected local+host obligation to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractError);
      expect((error as ActionContractError).code).toBe('LOCAL_AND_HOST_MUTUALLY_EXCLUSIVE');
    }
  });

  it('withActionContract demands a complete normalized block', () => {
    const action = { name: 'describe', description: 'describe the surface' };
    const contracted = withActionContract(action, validContract());
    expect(contracted.actionContract.replay).toEqual({ kind: 'safe-repeat' });
    expect(contracted.name).toBe('describe');
    expect(() => withActionContract(action, { ...validContract(), needs: { kind: 'none', because: '' } })).toThrow(
      ActionContractError,
    );
  });
});

describe('action-contract properties', () => {
  const capabilityArb = fc.constantFrom('fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos');
  const resourceArb = fc.record({
    kind: fc.constantFrom('stream', 'path', 'worktree', 'git-ref'),
    selector: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9./_-]{0,31}$/),
  });
  const requirementArb = fc.oneof(
    fc.record({ family: fc.constant('ladder' as const), gate: fc.constantFrom('check_static_analysis', 'check_test_adequacy') }),
    fc.record({ kind: fc.constant('approvals' as const), minimum: fc.integer({ min: 1, max: 4 }) }),
    fc.record({ kind: fc.constant('corroboration' as const), minimum: fc.integer({ min: 2, max: 5 }) }),
  );

  it('normalization is idempotent', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(capabilityArb, { minLength: 1, maxLength: 4 }),
        fc.uniqueArray(resourceArb, { minLength: 1, maxLength: 4, selector: (r) => `${r.kind}:${r.selector}` }),
        fc.uniqueArray(requirementArb, { minLength: 1, maxLength: 4, selector: (r) => JSON.stringify(r) }),
        (capabilities, resources, requirements) => {
          const input = validContract({
            needs: declared(capabilities[0]!, ...capabilities.slice(1)),
            requires: declared(requirements[0]!, ...requirements.slice(1)),
            touches: { frame: 'single-machine', resources: declared(resources[0]!, ...resources.slice(1)) },
          });
          const once = normalizeActionContract(input);
          expect(normalizeActionContract(once)).toEqual(once);
        },
      ),
    );
  });

  it('ordering does not change canonical output', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(capabilityArb, { minLength: 2, maxLength: 4 }),
        (capabilities) => {
          const forward = normalizeActionContract(
            validContract({ needs: { kind: 'declared', values: capabilities as [string, ...string[]] } }),
          );
          const reversed = normalizeActionContract(
            validContract({
              needs: { kind: 'declared', values: [...capabilities].reverse() as [string, ...string[]] },
            }),
          );
          expect(actionContractCanonicalBytes(forward)).toBe(actionContractCanonicalBytes(reversed));
        },
      ),
    );
  });
});

describe('contract emission authority', () => {
  const sibling = [
    { event: 'gate.executed', condition: 'always' as const, owner: 'sibling', role: 'primary' as const },
  ];
  const nested = {
    event: 'workflow.started',
    condition: 'always' as const,
    owner: 'workflow',
    role: 'primary' as const,
  };

  it('reads nested emissions and ignores a populated sibling list', () => {
    const declaredAction = {
      autoEmits: sibling,
      actionContract: validContract({ emissions: declared(nested) }),
    };
    expect(contractEmissionsOf(declaredAction)).toEqual([nested]);

    const silentAction = {
      autoEmits: sibling,
      actionContract: validContract({ emissions: none('reasoned silence') }),
    };
    expect(contractEmissionsOf(silentAction)).toEqual([]);
  });

  it('does not treat a missing contract as the sibling list', () => {
    expect(contractEmissionsOf({ autoEmits: sibling })).toEqual([]);
  });

  it('rejects a sibling emission list that disagrees with the nested contract', () => {
    expect(() =>
      withActionContract(
        { name: 'probe', autoEmits: sibling },
        validContract({ emissions: declared(nested) }),
      ),
    ).toThrow(/sibling autoEmits disagrees/);
  });
});
