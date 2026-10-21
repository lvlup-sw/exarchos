import { describe, expect, it } from 'vitest';
import {
  normalizeActionContract,
  type ActionContract,
} from '../../../src/registry/action-contract.js';
import { eventActions } from '../../../src/registry/actions/event.js';
import { RESERVED_EVENT_APPEND_REGISTRY } from '../../../src/registry/gate-metadata.js';
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

/** An event type in a text: a lowercase word, a dot, and a lowercase word. */
const EVENT_TYPE_TOKEN = /\b[a-z][a-z0-9_-]*\.[a-z][a-z0-9_.-]*[a-z0-9]/g;

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
    }
  });

  /**
   * The requires text of each generic append names each reserved type and no other type. An agent that reads the
   * contract then learns the refusal before it calls. A type that the registry adds and the text leaves out is named.
   */
  it('Registry_GenericAppendRequires_NamesEachReservedType', () => {
    const reserved = [...RESERVED_EVENT_APPEND_REGISTRY.keys()];
    expect(reserved).toEqual(expect.arrayContaining(['gate.executed', 'task.completed']));
    for (const name of ['append', 'batch_append']) {
      const action = eventActions.find((candidate) => candidate.name === name);
      expect(action !== undefined && isContracted(action), `${name} has a contract`).toBe(true);
      if (action === undefined || !isContracted(action)) continue;
      const { requires } = normalizeActionContract(action.actionContract, { annotations: action.annotations });
      expect(requires.kind, name).toBe('none');
      if (requires.kind !== 'none') continue;
      const named = new Set(requires.because.match(EVENT_TYPE_TOKEN) ?? []);
      expect(reserved.filter((type) => !named.has(type)), `${name} requires text leaves out`).toEqual([]);
      expect([...named].filter((type) => !RESERVED_EVENT_APPEND_REGISTRY.has(type)), `${name} requires text adds`).toEqual([]);
    }
  });
});
