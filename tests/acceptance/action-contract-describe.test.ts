import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deriveMetaModel } from '../../src/contract/compiler/meta-model.js';
import {
  auditMetaModel,
  observeRuntimeSurface,
  type ObservedAction,
  type RuntimeSurface,
} from '../../src/contract/compiler/runtime-authority.js';
import { unregisteredActionOutputSchema } from '../../src/output-schema-declaration.js';
import {
  TOOL_REGISTRY,
  none,
  normalizeActionContract,
  type ActionContract,
  type CompositeTool,
  type ToolAction,
} from '../../src/registry.js';

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

function dropObservedDimension(
  surface: RuntimeSurface,
  toolName: string,
  actionName: string,
  dimension: string,
): RuntimeSurface {
  const tool = surface.tools.get(toolName);
  if (tool === undefined) throw new Error(`missing observed tool ${toolName}`);
  const action = tool.actions.get(actionName);
  if (action === undefined || action.actionContract === null) {
    throw new Error(`missing observed contract ${toolName}.${actionName}`);
  }
  const { [dimension]: _dropped, ...rest } = action.actionContract;
  const nextAction: ObservedAction = { ...action, actionContract: rest };
  const nextActions = new Map(tool.actions);
  nextActions.set(actionName, nextAction);
  const nextTools = new Map(surface.tools);
  nextTools.set(toolName, { ...tool, actions: nextActions });
  return { tools: nextTools };
}

describe('action-contract describe projection', () => {
  it('RuntimeAuthority_DroppedDimension_IsDetected', async () => {
    const declared = validContract({
      needs: { kind: 'declared', values: ['fs:read', 'fs:write'] },
      requires: {
        kind: 'declared',
        values: [{ family: 'ladder', gate: 'check_test_adequacy' }],
      },
    });
    const action = withDeclaredContract(makeAction({ name: 'probe' }), declared);
    const registry = [makeTool('exarchos_probe', [action])];
    const surface = await observeRuntimeSurface(registry);
    const model = deriveMetaModel(registry);
    expect(auditMetaModel(model, surface)).toEqual([]);

    const observedDrop = auditMetaModel(model, dropObservedDimension(surface, 'exarchos_probe', 'probe', 'requires'));
    expect(observedDrop.some((finding) => finding.kind === 'contract-dimension-dropped')).toBe(true);
    expect(
      observedDrop.some(
        (finding) =>
          finding.field === 'actionContract.requires' &&
          finding.message.includes('requires') &&
          finding.message.includes('describe'),
      ),
    ).toBe(true);

    const entry = model.actions[0];
    if (entry?.actionContract === undefined) throw new Error('expected modelled contract');
    const { requires: _requires, ...rest } = entry.actionContract;
    const modelDrop = auditMetaModel(
      {
        ...model,
        actions: [
          {
            ...entry,
            actionContract: rest as ActionContract,
            policy: { ...entry.policy, actionContract: rest as ActionContract },
          },
        ],
      },
      surface,
    );
    expect(modelDrop.some((finding) => finding.kind === 'contract-dimension-dropped')).toBe(true);
    expect(modelDrop.some((finding) => finding.field === 'actionContract.requires')).toBe(true);

    const wiringOnly = auditMetaModel({ ...model, actions: model.actions.slice(1) }, surface);
    expect(wiringOnly.some((finding) => finding.kind === 'wire-action-unmodelled')).toBe(true);
    expect(wiringOnly.some((finding) => finding.field === 'actionContract.requires')).toBe(false);
  });

  it('describe and registry normalize identically on a live contracted action', async () => {
    const workflow = TOOL_REGISTRY.find((tool) => tool.name === 'exarchos_workflow');
    if (workflow === undefined) throw new Error('missing exarchos_workflow');
    const describeAction = workflow.actions.find((action) => action.name === 'describe');
    if (describeAction === undefined || !('actionContract' in describeAction)) {
      throw new Error('workflow describe is missing an action contract');
    }
    const surface = await observeRuntimeSurface([workflow]);
    const observed = surface.tools.get('exarchos_workflow')?.actions.get('describe');
    if (observed?.actionContract === null || observed === undefined) {
      throw new Error('describe did not project the workflow describe contract');
    }
    const registry = normalizeActionContract(Reflect.get(describeAction, 'actionContract'), {
      annotations: describeAction.annotations,
    });
    expect(observed.actionContract).toEqual(registry);
    expect(observed.actionContractDigest).toBeDefined();
    for (const dimension of [
      'requires',
      'ensures',
      'needs',
      'touches',
      'executionAuthority',
      'replay',
      'emissions',
    ] as const) {
      expect(dimension in observed.actionContract).toBe(true);
    }
  });

  it('four visible tools remain four', () => {
    const visible = TOOL_REGISTRY.filter((tool) => tool.hidden !== true).map((tool) => tool.name);
    expect(visible).toEqual([
      'exarchos_workflow',
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
    ]);
  });
});
