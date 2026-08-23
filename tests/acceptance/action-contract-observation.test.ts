import { afterEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import {
  dispatch,
  type DispatchContext,
} from '../../src/dispatch/core/dispatch.js';
import { getDispatchContext } from '../../src/dispatch/dispatch-context.js';
import type { EventStore } from '../../src/events/store.js';
import type { WorkflowEvent } from '../../src/events/schemas.js';
import {
  clearCustomTools,
  registerCustomTool,
  setCustomToolActionHandler,
  type CompositeTool,
} from '../../src/registry.js';
import { unregisteredActionOutputSchema } from '../../src/output-schema-declaration.js';
import {
  declared,
  none,
  withActionContract,
  type ActionContract,
} from '../../src/registry/action-contract.js';
import { LOCAL_MUTATION } from '../../src/registry/annotations.js';

const PROBE_TOOL = 'exarchos_observation_probe';
const NESTED_EVENT = 'workflow.started';
const SIBLING_EVENT = 'task.completed';

function probeContract(overrides: Partial<ActionContract> = {}): ActionContract {
  return {
    requires: none('probe has no admission obligations'),
    ensures: none('probe has no durable postcondition'),
    needs: none('probe declares no capabilities'),
    touches: {
      frame: 'single-machine',
      resources: declared({ kind: 'stream', selector: 'featureId' }),
    },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: none('probe emits no catalog events'),
    ...overrides,
  };
}

function registerProbe(input: {
  readonly action: string;
  readonly contract: ActionContract;
  readonly autoEmits?: CompositeTool['actions'][number]['autoEmits'];
  readonly handler: (args: Record<string, unknown>) => Promise<unknown>;
}): void {
  registerCustomTool({
    name: PROBE_TOOL,
    description: 'Nested-emission observation probe',
    actions: [
      withActionContract(
        {
          name: input.action,
          description: 'Nested-emission observation probe action',
          schema: z.object({ featureId: z.string().min(1) }).passthrough(),
          phases: new Set<string>(),
          roles: new Set<string>(['any']),
          annotations: LOCAL_MUTATION,
          outputSchema: unregisteredActionOutputSchema(),
          ...(input.autoEmits === undefined ? {} : { autoEmits: input.autoEmits }),
        },
        input.contract,
      ),
    ],
  });
  setCustomToolActionHandler(PROBE_TOOL, input.action, input.handler);
}

interface MemoryRow {
  readonly type: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly data?: unknown;
  readonly operationId?: string;
}

function memoryEventStore(): EventStore {
  const rows = new Map<string, MemoryRow[]>();
  const append = async (
    streamId: string,
    event: { type: string; data?: unknown; operationId?: string },
  ): Promise<WorkflowEvent> => {
    const dispatchCtx = getDispatchContext();
    const operationId = event.operationId ?? dispatchCtx?.operationId;
    const list = rows.get(streamId) ?? [];
    const stored: MemoryRow = {
      type: event.type,
      streamId,
      sequence: list.length + 1,
      ...(event.data !== undefined ? { data: event.data } : {}),
      ...(operationId !== undefined ? { operationId } : {}),
    };
    list.push(stored);
    rows.set(streamId, list);
    return stored as WorkflowEvent;
  };
  return {
    async initialize() {},
    async query(streamId: string, filters?: { type?: string; operationId?: string }) {
      return (rows.get(streamId) ?? []).filter((row) => {
        if (filters?.type !== undefined && row.type !== filters.type) return false;
        if (filters?.operationId !== undefined && row.operationId !== filters.operationId) {
          return false;
        }
        return true;
      }) as WorkflowEvent[];
    },
    async append(streamId: string, event: { type: string; data?: unknown }) {
      return append(streamId, event);
    },
    async appendValidated(streamId: string, event: WorkflowEvent) {
      return append(streamId, {
        type: event.type,
        ...(event.data !== undefined ? { data: event.data } : {}),
        ...(event.operationId !== undefined ? { operationId: event.operationId } : {}),
      });
    },
    listStreams() {
      return [...rows.keys()];
    },
  } as unknown as EventStore;
}

describe('action-contract emission observation', () => {
  let eventStore: EventStore;

  afterEach(() => {
    clearCustomTools();
  });

  function ctx(): DispatchContext {
    eventStore = memoryEventStore();
    return {
      stateDir: path.join(os.tmpdir(), 'observation-dispatch-unused'),
      eventStore,
      enableTelemetry: false,
    };
  }

  it('EmissionVerifier_UsesNestedEmissions', async () => {
    const featureId = 'feat-nested-emissions';
    registerProbe({
      action: 'write',
      autoEmits: [{ event: SIBLING_EVENT, condition: 'always' }],
      contract: probeContract({
        emissions: declared({
          event: NESTED_EVENT,
          condition: 'always',
          owner: 'observation-probe',
          role: 'primary',
        }),
      }),
      handler: async (args) => {
        await eventStore.append(String(args.featureId), {
          type: SIBLING_EVENT,
          data: { taskId: 'task-probe' },
        });
        return { success: true, data: { wrote: true } };
      },
    });

    const result = await dispatch(
      PROBE_TOOL,
      { action: 'write', featureId },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EMISSION_CONTRACT_VIOLATED');
    expect(result.error?.message).toContain(NESTED_EVENT);
    expect(result.data).toEqual({ wrote: true });
  });
});
