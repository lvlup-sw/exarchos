import { coercedNonnegativeInt, coercedPositiveInt, coercedRecord, coercedStringArray } from '../../coerce.js';
import { vacuityWaiver } from '../../output-schema-declaration.js';
import { z } from 'zod';
import { LOCAL_MUTATION, READ_ONLY_LOCAL } from '../annotations.js';
import { makeEventDescribeAction } from '../describe-actions.js';
import { ALL_PHASES, DELEGATE_PHASES, ROLE_ANY, ROLE_LEAD } from '../phases.js';
import type { BuiltinToolAction } from '../types.js';

// ─── Composite Tool: exarchos_event ─────────────────────────────────────────

export const eventActions: readonly BuiltinToolAction[] = [
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
  makeEventDescribeAction('exarchos_event.describe'),
];
