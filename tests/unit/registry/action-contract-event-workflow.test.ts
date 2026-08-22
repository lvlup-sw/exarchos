import { describe, expect, it } from 'vitest';
import {
  normalizeActionContract,
  type ActionContract,
} from '../../../src/registry/action-contract.js';
import { eventActions } from '../../../src/registry/actions/event.js';
import { syncActions } from '../../../src/registry/actions/sync.js';
import { workflowActions } from '../../../src/registry/actions/workflow.js';
import type { ToolAction } from '../../../src/registry/types.js';

type ContractedAction = ToolAction & { readonly actionContract: ActionContract };

const MIGRATED: readonly { readonly tool: string; readonly action: ToolAction }[] = [
  ...eventActions.map((action) => ({ tool: 'exarchos_event', action })),
  ...workflowActions.map((action) => ({ tool: 'exarchos_workflow', action })),
  ...syncActions.map((action) => ({ tool: 'exarchos_sync', action })),
];

function isContracted(action: ToolAction): action is ContractedAction {
  return 'actionContract' in action && Reflect.get(action, 'actionContract') !== undefined;
}

describe('event, workflow, and sync action contracts', () => {
  it('Registry_EventWorkflowSyncActions_HaveCompleteContracts', () => {
    expect(MIGRATED.length).toBeGreaterThan(0);
    for (const { tool, action } of MIGRATED) {
      const id = `${tool}.${action.name}`;
      expect(isContracted(action), `${id} is missing required actionContract`).toBe(true);
      if (!isContracted(action)) {
        continue;
      }
      const contract = normalizeActionContract(action.actionContract, {
        annotations: action.annotations,
      });
      expect(contract.touches.frame, `${id} frame`).toBe('single-machine');
      expect(contract.executionAuthority.kind === 'local' || contract.executionAuthority.kind === 'host').toBe(true);
      if (action.name === 'transition') {
        expect(contract.requires.kind, `${id} requires must stay reasoned none`).toBe('none');
      }
      if (contract.emissions.kind === 'declared') {
        for (const emission of contract.emissions.values) {
          expect(
            emission.role === 'primary' || emission.role === 'recovery',
            `${id} emission ${emission.event} is missing a role`,
          ).toBe(true);
          expect(emission.owner.trim().length, `${id} emission ${emission.event} owner`).toBeGreaterThan(0);
        }
      }
      if (action.autoEmits !== undefined) {
        expect(contract.emissions.kind, `${id} must declare emissions that match autoEmits`).toBe('declared');
        if (contract.emissions.kind !== 'declared') {
          continue;
        }
        const declaredEvents = new Set(contract.emissions.values.map((emission) => emission.event));
        for (const edge of action.autoEmits) {
          expect(
            edge.role === 'primary' || edge.role === 'recovery',
            `${id} autoEmits ${edge.event} is missing a role`,
          ).toBe(true);
          expect(declaredEvents.has(edge.event), `${id} contract omitted autoEmits ${edge.event}`).toBe(true);
        }
      }
    }
  });
});
