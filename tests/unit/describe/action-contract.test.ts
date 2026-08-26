// @oracle-sources: ../../../src/describe/handler.ts, the registry's own contract normalization reached through the shipped `src/registry.ts` surface rather than through the describe projection
//
// `describe` is a PROJECTION of the declarations, so the question is whether
// the projection preserves them. The two authorities are the projection and the
// normalizer it is supposed to agree with; both are read through their own
// published entry points so neither answer is produced by the other's code
// path.

import { fc } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ACTION_CONTRACT_DIMENSIONS,
  handleDescribe,
  projectCompactActionContract,
} from '../../../src/describe/handler.js';
import {
  actionContractCanonicalBytes,
  declared,
  none,
  normalizeActionContract,
  type ActionContract,
  type ToolAction,
} from '../../../src/registry.js';

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

function makeAction(name: string, extras: Partial<ToolAction> = {}): ToolAction {
  return {
    name,
    description: 'probe action',
    schema: z.object({}),
    phases: new Set(['ideate']),
    roles: new Set(['any']),
    outputSchema: z.object({ success: z.boolean() }),
    annotations: {
      safety: 'read-only',
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    ...extras,
  };
}

function withRawContract(action: ToolAction, contract: unknown): ToolAction {
  return Object.assign(action, { actionContract: contract });
}

async function describeContract(action: ToolAction): Promise<Record<string, unknown>> {
  const result = await handleDescribe({ actions: [action.name] }, [action]);
  expect(result.success).toBe(true);
  const data = result.data as Record<string, Record<string, unknown>>;
  return data[action.name] ?? {};
}

describe('describe action-contract projection', () => {
  it('HandleDescribe_ProjectsNormalizedActionContract', async () => {
    const shuffled = validContract({
      needs: { kind: 'declared', values: ['shell:exec', 'fs:read', 'fs:write'] },
      requires: {
        kind: 'declared',
        values: [
          { kind: 'corroboration', minimum: 2 },
          { family: 'ladder', gate: 'check_test_adequacy' },
          { kind: 'approvals', minimum: 1 },
          { family: 'ladder', gate: 'check_static_analysis' },
        ],
      },
      emissions: {
        kind: 'declared',
        values: [
          {
            event: 'task.completed',
            condition: 'conditional',
            owner: 'b',
            role: 'primary',
            description: 'prose that compact may omit',
          },
          { event: 'workflow.started', condition: 'always', owner: 'a', role: 'primary' },
        ],
      },
    });
    const action = withRawContract(makeAction('probe'), shuffled);
    const described = await describeContract(action);
    const expected = normalizeActionContract(shuffled, { annotations: action.annotations });

    expect(described.actionContract).toEqual(expected);
    expect(described.actionContract).not.toEqual(shuffled);
    expect(described.actionContractDigest).toBe(actionContractCanonicalBytes(expected));

    const compact = described.actionContractCompact as Record<string, unknown>;
    expect(compact).toBeDefined();
    for (const dimension of ACTION_CONTRACT_DIMENSIONS) {
      expect(dimension in compact, `compact missing ${dimension}`).toBe(true);
    }
    expect(compact.digest).toBe(actionContractCanonicalBytes(expected));
    const compactEmissions = compact.emissions as { kind: string; values?: readonly Record<string, unknown>[] };
    expect(compactEmissions.values?.some((emission) => 'description' in emission)).toBe(false);
    expect(compact.requires).toEqual({ kind: 'declared', values: expect.any(Array) });
    expect('because' in (compact.ensures as object)).toBe(false);
  });

  it('does not reconstruct a contract from annotations or autoEmits', async () => {
    const action = makeAction('annotated_only');
    const described = await describeContract(action);
    expect(described.actionContract).toBeUndefined();
    expect(described.actionContractDigest).toBeUndefined();
    expect(described.actionContractCompact).toBeUndefined();
    expect(described.autoEmits).toBeUndefined();
  });

  it('compact views omit prose but keep every dimension and digest', () => {
    const contract = normalizeActionContract(
      validContract({
        requires: { kind: 'none', because: 'no admission obligation applies' },
        emissions: {
          kind: 'declared',
          values: [
            {
              event: 'workflow.started',
              condition: 'always',
              owner: 'probe',
              role: 'primary',
              description: 'narrative only',
            },
          ],
        },
        replay: { kind: 'reject-replay', because: 'mutation is not safely repeatable' },
      }),
    );
    const compact = projectCompactActionContract(contract);
    for (const dimension of ACTION_CONTRACT_DIMENSIONS) {
      expect(dimension in compact).toBe(true);
    }
    expect(compact.digest).toBe(actionContractCanonicalBytes(contract));
    expect(compact.requires).toEqual({ kind: 'none' });
    expect(compact.replay).toEqual({ kind: 'reject-replay' });
    expect(compact.emissions).toEqual({
      kind: 'declared',
      values: [{ event: 'workflow.started', condition: 'always', owner: 'probe', role: 'primary' }],
    });
  });
});

describe('describe and registry normalize identically', () => {
  const capabilityArb = fc.constantFrom('fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos');
  const resourceArb = fc.record({
    kind: fc.constantFrom('stream', 'path', 'worktree', 'git-ref'),
    selector: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9./_-]{0,31}$/),
  });
  const requirementArb = fc.oneof(
    fc.record({
      family: fc.constant('ladder' as const),
      gate: fc.constantFrom('check_static_analysis', 'check_test_adequacy'),
    }),
    fc.record({ kind: fc.constant('approvals' as const), minimum: fc.integer({ min: 1, max: 4 }) }),
    fc.record({ kind: fc.constant('corroboration' as const), minimum: fc.integer({ min: 2, max: 5 }) }),
  );

  it('describe projection matches registry normalization', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(capabilityArb, { minLength: 1, maxLength: 4 }),
        fc.uniqueArray(resourceArb, { minLength: 1, maxLength: 4, selector: (r) => `${r.kind}:${r.selector}` }),
        fc.uniqueArray(requirementArb, { minLength: 1, maxLength: 4, selector: (r) => JSON.stringify(r) }),
        async (capabilities, resources, requirements) => {
          const input = validContract({
            needs: declared(capabilities[0]!, ...capabilities.slice(1)),
            requires: declared(requirements[0]!, ...requirements.slice(1)),
            touches: { frame: 'single-machine', resources: declared(resources[0]!, ...resources.slice(1)) },
          });
          const reversed = validContract({
            needs: { kind: 'declared', values: [...capabilities].reverse() as [typeof capabilities[0], ...typeof capabilities] },
            requires: {
              kind: 'declared',
              values: [...requirements].reverse() as [typeof requirements[0], ...typeof requirements],
            },
            touches: {
              frame: 'single-machine',
              resources: {
                kind: 'declared',
                values: [...resources].reverse() as [typeof resources[0], ...typeof resources],
              },
            },
          });
          const action = withRawContract(makeAction('probe'), reversed);
          const described = await describeContract(action);
          const registry = normalizeActionContract(input, { annotations: action.annotations });
          expect(described.actionContract).toEqual(registry);
          expect(described.actionContractDigest).toBe(actionContractCanonicalBytes(registry));
        },
      ),
    );
  });
});
