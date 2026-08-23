import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuthorityVerdict } from '../../src/contract/authority-pin.js';
import {
  compileForCli,
  deriveCliSurface,
  serializeCliSurface,
} from '../../src/contract/cli/cli-surface.js';
import { compile } from '../../src/contract/compiler/compile.js';
import { deriveMetaModel } from '../../src/contract/compiler/meta-model.js';
import { unregisteredActionOutputSchema } from '../../src/output-schema-declaration.js';
import {
  declared,
  none,
  normalizeActionContract,
  TOOL_REGISTRY,
  type ActionContract,
  type CompositeTool,
  type ToolAction,
} from '../../src/registry.js';

const VISIBLE_TOOL_NAMES = [
  'exarchos_event',
  'exarchos_orchestrate',
  'exarchos_view',
  'exarchos_workflow',
] as const;

const okVerdict: AuthorityVerdict = { ok: true, violations: [], report: 'ok (stub)' };
const OK = { verifyAuthority: () => okVerdict } as const;

const CONTRACT_NONE = none('read-only query has no additional obligations');

function validContract(overrides: Partial<ActionContract> = {}): ActionContract {
  return normalizeActionContract({
    requires: CONTRACT_NONE,
    ensures: CONTRACT_NONE,
    needs: CONTRACT_NONE,
    touches: { frame: 'single-machine', resources: CONTRACT_NONE },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'safe-repeat' },
    emissions: CONTRACT_NONE,
    ...overrides,
  });
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

function compileSynthetic(actions: readonly ToolAction[]) {
  const model = deriveMetaModel([makeTool('exarchos_probe', actions)]);
  const outcome = compile(model, OK);
  if (!outcome.ok) {
    throw new Error(outcome.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
  }
  return outcome.output;
}

function descriptorContract(descriptor: {
  readonly actionContract?: ActionContract | undefined;
  readonly policy: { readonly actionContract?: ActionContract | undefined };
}): ActionContract | undefined {
  const declaredContract = descriptor.actionContract ?? descriptor.policy.actionContract;
  if (declaredContract === undefined) return undefined;
  return normalizeActionContract(declaredContract);
}

describe('CLI action-contract projection', () => {
  it('CliSurface_ContractProjection_EqualsDescriptor', () => {
    const compiled = compileForCli();
    const surface = deriveCliSurface(compiled);
    expect(surface.commands).toHaveLength(compiled.descriptors.length);

    for (const descriptor of compiled.descriptors) {
      const command = surface.commands.find((entry) => entry.actionId === descriptor.actionId);
      expect(command, descriptor.actionId).toBeDefined();
      expect(command!.actionContract).toEqual(descriptorContract(descriptor));
    }

    const declaredBlock = validContract({
      needs: declared('fs:read'),
      emissions: declared({
        event: 'task.completed',
        condition: 'always',
        owner: 'contracted',
        role: 'primary',
      }),
    });
    const synthetic = compileSynthetic([
      makeAction({ name: 'annotated' }),
      withDeclaredContract(makeAction({ name: 'contracted' }), declaredBlock),
    ]);
    const projected = deriveCliSurface(synthetic);
    const annotated = projected.commands.find((entry) => entry.action === 'annotated');
    const contracted = projected.commands.find((entry) => entry.action === 'contracted');
    const annotatedDescriptor = synthetic.descriptors.find((entry) => entry.action === 'annotated');
    const contractedDescriptor = synthetic.descriptors.find((entry) => entry.action === 'contracted');

    expect(annotatedDescriptor?.actionContract).toBeUndefined();
    expect(annotatedDescriptor?.policy.actionContract).toBeUndefined();
    expect(annotated?.actionContract).toBeUndefined();

    expect(contractedDescriptor?.actionContract).toEqual(declaredBlock);
    expect(contracted?.actionContract).toEqual(declaredBlock);
    expect(contracted?.actionContract).toEqual(descriptorContract(contractedDescriptor!));
    expect(contracted?.actionContract).not.toEqual(annotatedDescriptor?.policy.evidence.autoEmits);
  });

  it('CliSurface_AllActionIds_HaveContracts', () => {
    const compiled = compileForCli();
    const first = deriveCliSurface(compiled);
    const second = deriveCliSurface(compiled);

    const surfaceIds = first.commands.map((command) => command.actionId).sort();
    const descriptorIds = compiled.descriptors.map((descriptor) => descriptor.actionId).sort();
    expect(surfaceIds).toEqual(descriptorIds);
    expect(new Set(surfaceIds).size).toBe(surfaceIds.length);

    for (const command of first.commands) {
      const descriptor = compiled.descriptors.find((entry) => entry.actionId === command.actionId);
      expect(descriptor, command.actionId).toBeDefined();
      const expected = descriptorContract(descriptor!);
      expect(command.actionContract, command.actionId).toEqual(expected);
      if (expected !== undefined) {
        expect(command.actionContract, command.actionId).toBeDefined();
      }
    }

    expect(serializeCliSurface(first)).toBe(serializeCliSurface(second));
    expect(serializeCliSurface(deriveCliSurface(compileForCli()))).toBe(serializeCliSurface(first));

    const visible = TOOL_REGISTRY.filter((tool) => tool.hidden !== true);
    expect(visible).toHaveLength(4);
    expect(visible.map((tool) => tool.name).sort()).toEqual([...VISIBLE_TOOL_NAMES].sort());
  });
});
