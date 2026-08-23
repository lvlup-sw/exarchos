import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerCustomTools, clearRegisteredTools } from '../../src/config/register.js';
import {
  ActionContractError,
  none,
  normalizeActionContract,
  type ActionContract,
} from '../../src/registry/action-contract.js';
import {
  clearCustomTools,
  registerCustomTool,
  validateAction,
  type ActionAnnotations,
  type CompositeTool,
} from '../../src/registry.js';

const REASONED_NONE = none('registration fixture has no additional obligations');

function completeContract(overrides: Partial<ActionContract> = {}): ActionContract {
  return {
    requires: REASONED_NONE,
    ensures: REASONED_NONE,
    needs: REASONED_NONE,
    touches: { frame: 'single-machine', resources: REASONED_NONE },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: REASONED_NONE,
    ...overrides,
  };
}

const LOCAL_MUTATION: ActionAnnotations = {
  safety: 'local-mutation',
  readOnly: false,
  destructive: false,
  idempotent: false,
  openWorld: false,
};

function customTool(contract: unknown): CompositeTool {
  return {
    name: 'exarchos_contract_probe',
    description: 'Registration-boundary contract probe',
    actions: [
      {
        name: 'run',
        description: 'Run the probe',
        schema: z.object({}).passthrough(),
        phases: new Set<string>(['ideate']),
        roles: new Set<string>(['any']),
        outputSchema: z.object({ success: z.boolean() }),
        annotations: LOCAL_MUTATION,
        actionContract: contract,
      },
    ],
  };
}

afterEach(() => {
  clearRegisteredTools();
  clearCustomTools();
});

describe('action-contract registration boundary', () => {
  it('RegisterCustomTool_InvalidContract_IsRejected', () => {
    expect(() => registerCustomTool(customTool(completeContract({
      needs: { kind: 'none', because: '' },
    })))).toThrow(ActionContractError);
    try {
      registerCustomTool(customTool({
        ...completeContract(),
        needs: { kind: 'declared', values: ['host:browser'] },
      }));
      expect.fail('expected unknown capability to fail custom-tool admission');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractError);
      expect((error as ActionContractError).code).toBe('UNKNOWN_CAPABILITY');
      expect((error as Error).message).toMatch(/exarchos_contract_probe\.run/);
    }
    expect(() => registerCustomTool(customTool(undefined))).toThrow(ActionContractError);
  });

  it('RegisterExtensionTool_MissingContract_IsRejected', async () => {
    await expect(
      registerCustomTools(
        {
          tools: {
            exarchos_extension_probe: {
              description: 'Extension admission probe',
              actions: [
                {
                  name: 'run',
                  description: 'Run the extension probe',
                  handler: './missing-handler.js',
                },
              ],
            },
          },
        },
        '/tmp/exarchos-contract-registration',
      ),
    ).rejects.toThrow(/actionContract/);
    try {
      await registerCustomTools(
        {
          tools: {
            exarchos_extension_probe: {
              description: 'Extension admission probe',
              actions: [
                {
                  name: 'run',
                  description: 'Run the extension probe',
                  handler: './missing-handler.js',
                },
              ],
            },
          },
        },
        '/tmp/exarchos-contract-registration',
      );
      expect.fail('expected missing extension actionContract to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Failed to register custom tools/);
      expect((error as Error).message).toMatch(/exarchos_extension_probe\.run/);
      expect((error as Error).message).toMatch(/missing required actionContract/);
    }
  });

  it('built-in and extension admission accept the same contract language', () => {
    const accepted = completeContract();
    expect(() =>
      validateAction(
        {
          name: 'run',
          outputSchema: z.object({ success: z.boolean() }),
          annotations: LOCAL_MUTATION,
          actionContract: accepted,
        },
        'exarchos_contract_probe',
        'registration',
      ),
    ).not.toThrow();
    expect(() => registerCustomTool(customTool(accepted))).not.toThrow();
    clearCustomTools();

    const invalid = completeContract({
      touches: {
        frame: 'single-machine',
        resources: { kind: 'declared', values: [{ kind: 'socket', selector: '/tmp/x' }] },
      },
    });
    let builtinCode: string | undefined;
    let extensionCode: string | undefined;
    try {
      validateAction(
        {
          name: 'run',
          outputSchema: z.object({ success: z.boolean() }),
          annotations: LOCAL_MUTATION,
          actionContract: invalid,
        },
        'exarchos_contract_probe',
        'registration',
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractError);
      builtinCode = (error as ActionContractError).code;
    }
    try {
      registerCustomTool(customTool(invalid));
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractError);
      extensionCode = (error as ActionContractError).code;
    }
    expect(builtinCode).toBe('UNKNOWN_RESOURCE_KIND');
    expect(extensionCode).toBe(builtinCode);
    expect(normalizeActionContract(accepted)).toEqual(normalizeActionContract(completeContract()));
  });
});
