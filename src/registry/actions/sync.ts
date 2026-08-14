import { vacuityWaiver } from '../../output-schema-declaration.js';
import { z } from 'zod';
import { LOCAL_MUTATION_IDEMPOTENT } from '../annotations.js';
import { ALL_PHASES, ROLE_LEAD } from '../phases.js';
import type { BuiltinToolAction } from '../types.js';

// ─── Composite Tool: exarchos_sync ──────────────────────────────────────────

export const syncActions: readonly BuiltinToolAction[] = [
  {
    name: 'now',
    description: 'Trigger immediate sync with remote',
    schema: z.object({}),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_sync.now'),
    annotations: LOCAL_MUTATION_IDEMPOTENT,
  },
];
