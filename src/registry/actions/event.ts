import { coercedNonnegativeInt, coercedPositiveInt, coercedRecord, coercedStringArray } from '../../coerce.js';
import { vacuityWaiver } from '../../output-schema-declaration.js';
import { z } from 'zod';
import { declared, none, withActionContract } from '../action-contract.js';
import { LOCAL_MUTATION, READ_ONLY_LOCAL } from '../annotations.js';
import { makeEventDescribeAction } from '../describe-actions.js';
import { ALL_PHASES, DELEGATE_PHASES, ROLE_ANY, ROLE_LEAD } from '../phases.js';
import type { BuiltinToolAction } from '../types.js';

// ─── Composite Tool: exarchos_event ─────────────────────────────────────────

export const eventActions: readonly BuiltinToolAction[] = [
  withActionContract(
    {
      name: 'append',
      description: 'Append an event to a stream',
      schema: z.object({
        stream: z.string().min(1),
        event: coercedRecord(),
        expectedSequence: coercedNonnegativeInt().optional(),
        idempotencyKey: z.string().optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      cli: {
        examples: ['exarchos ev append --stream my-feature --event \'{"type":"task.completed","data":{"taskId":"t1"}}\''],
      },
      outputSchema: vacuityWaiver('exarchos_event.append'),
      annotations: LOCAL_MUTATION,
    },
    {
      requires: none('append admits any catalog event; callers supply type and payload'),
      ensures: none('the appended event type is caller-supplied rather than a fixed postcondition'),
      needs: none('append writes through the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'stream' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: none('append writes a caller-supplied catalog event, not a declared emission'),
    },
    { annotations: LOCAL_MUTATION },
  ),
  withActionContract(
    {
      name: 'query',
      description: 'Query events from a stream with optional filtering',
      schema: z.object({
        stream: z.string().min(1),
        filter: coercedRecord().optional(),
        limit: coercedPositiveInt().optional(),
        offset: coercedNonnegativeInt().optional(),
        fields: coercedStringArray().optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      outputSchema: vacuityWaiver('exarchos_event.query'),
      annotations: READ_ONLY_LOCAL,
    },
    {
      requires: none('query is a read of an existing stream with no admission obligations'),
      ensures: none('query returns ephemeral event rows with no durable postcondition'),
      needs: none('query reads through the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'stream' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: none('query emits no catalog events'),
    },
    { annotations: READ_ONLY_LOCAL },
  ),
  withActionContract(
    {
      name: 'batch_append',
      description: 'Append multiple events to a stream atomically',
      schema: z.object({
        stream: z.string().min(1),
        events: z.array(coercedRecord()),
      }),
      phases: DELEGATE_PHASES,
      roles: ROLE_LEAD,
      outputSchema: vacuityWaiver('exarchos_event.batch_append'),
      annotations: LOCAL_MUTATION,
    },
    {
      requires: none('batch_append admits a caller-supplied event list with no extra gate'),
      ensures: none('appended event types are caller-supplied rather than a fixed postcondition'),
      needs: none('batch_append writes through the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'stream' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: none('batch_append writes caller-supplied catalog events, not a declared emission'),
    },
    { annotations: LOCAL_MUTATION },
  ),
  makeEventDescribeAction('exarchos_event.describe'),
];
