import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuthorityVerdict } from '../../src/contract/authority-pin.js';
import { compile } from '../../src/contract/compiler/compile.js';
import { deriveMetaModel } from '../../src/contract/compiler/meta-model.js';
import { unregisteredActionOutputSchema } from '../../src/output-schema-declaration.js';
import {
  none,
  normalizeActionContract,
  type ActionContract,
  type CompositeTool,
  type ToolAction,
} from '../../src/registry.js';

const okVerdict: AuthorityVerdict = { ok: true, violations: [], report: 'ok (stub)' };
const OK = { verifyAuthority: () => okVerdict } as const;

const CONTRACT_NONE = none('read-only query has no additional obligations');

function validContract(overrides: Partial<ActionContract> = {}): ActionContract {
  return {
    requires: CONTRACT_NONE,
    ensures: CONTRACT_NONE,
    needs: CONTRACT_NONE,
    touches: { frame: 'single-machine', resources: CONTRACT_NONE },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'safe-repeat' },
    emissions: CONTRACT_NONE,
    ...overrides,
  };
}

function makeAction(overrides: Partial<ToolAction> & { name: string }): ToolAction {
  return {
    description: 'synthetic',
    schema: z.object({ x: z.string() }),
    phases: new Set<string>(),
    roles: new Set<string>(['lead']),
    outputSchema: unregisteredActionOutputSchema(),
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

function withDeclaredContract(action: ToolAction, contract: unknown): ToolAction {
  return Object.assign(action, { actionContract: contract });
}

function compileWithContract(contract: unknown) {
  const action = withDeclaredContract(makeAction({ name: 'probe' }), validContract());
  const model = deriveMetaModel([makeTool('exarchos_probe', [action])]);
  const entry = model.actions[0];
  if (entry === undefined) throw new Error('expected a derived action');
  return compile(
    {
      ...model,
      actions: [
        {
          ...entry,
          actionContract: contract,
          policy: { ...entry.policy, actionContract: contract },
        },
      ],
    },
    OK,
  );
}

describe('action-contract compiler admission', () => {
  it('Compiler_UnknownEmissionEvent_FailsCompilation', () => {
    const outcome = compileWithContract(
      validContract({
        emissions: {
          kind: 'declared',
          values: [
            {
              event: 'this.event.is.not.catalogued',
              condition: 'always',
              owner: 'probe',
              role: 'primary',
            },
          ],
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected compilation to fail');
    expect(
      outcome.diagnostics.some(
        (diagnostic) =>
          diagnostic.message.includes('UNKNOWN_EVENT') &&
          diagnostic.message.includes('this.event.is.not.catalogued') &&
          diagnostic.message.includes('emission catalog'),
      ),
    ).toBe(true);
  });

  it('Compiler_RecoveryExpiry_InvalidFails', () => {
    const outcome = compileWithContract(
      validContract({
        emissions: {
          kind: 'declared',
          values: [
            {
              event: 'workflow.started',
              condition: 'conditional',
              owner: 'probe',
              role: 'recovery',
            },
          ],
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected compilation to fail');
    expect(
      outcome.diagnostics.some(
        (diagnostic) =>
          diagnostic.message.includes('INVALID_EMISSION') &&
          diagnostic.message.includes('recovery') &&
          diagnostic.message.includes('recoveryExpiresAt'),
      ),
    ).toBe(true);
  });

  it('Compiler_PrimaryExpiry_PresentFails', () => {
    const outcome = compileWithContract(
      validContract({
        emissions: {
          kind: 'declared',
          values: [
            {
              event: 'workflow.started',
              condition: 'always',
              owner: 'probe',
              role: 'primary',
              recoveryExpiresAt: '2099-01-01T00:00:00.000Z',
            },
          ],
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected compilation to fail');
    expect(
      outcome.diagnostics.some(
        (diagnostic) =>
          diagnostic.message.includes('INVALID_EMISSION') &&
          diagnostic.message.includes('primary') &&
          diagnostic.message.includes('recoveryExpiresAt'),
      ),
    ).toBe(true);
  });

  it('valid catalog-accepted contracts compile and round-trip', () => {
    const declared = validContract({
      needs: { kind: 'declared', values: ['fs:write', 'fs:read'] },
      emissions: {
        kind: 'declared',
        values: [
          { event: 'task.completed', condition: 'always', owner: 'probe', role: 'primary' },
        ],
      },
    });
    const action = withDeclaredContract(makeAction({ name: 'probe' }), declared);
    const model = deriveMetaModel([makeTool('exarchos_probe', [action])]);
    const normalized = normalizeActionContract(declared);
    expect(model.actions[0]?.actionContract).toEqual(normalized);
    expect(model.actions[0]?.policy.actionContract).toEqual(normalized);

    const outcome = compile(model, OK);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected compilation to succeed');
    expect(outcome.output.descriptors[0]?.policy.actionContract).toEqual(normalized);
  });
});
