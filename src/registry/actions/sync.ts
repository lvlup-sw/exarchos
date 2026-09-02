import { vacuityWaiver } from '../../output-schema-declaration.js';
import { z } from 'zod';
import { none, withActionContract } from '../action-contract.js';
import { LOCAL_MUTATION_IDEMPOTENT } from '../annotations.js';
import { ALL_PHASES, ROLE_LEAD } from '../phases.js';
import type { BuiltinToolAction } from '../types.js';

// ─── Composite Tool: exarchos_sync ──────────────────────────────────────────

export const syncActions: readonly BuiltinToolAction[] = [
  withActionContract(
    {
      name: 'now',
      description: 'Trigger immediate sync with remote',
      schema: z.object({}),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      outputSchema: vacuityWaiver('exarchos_sync.now'),
      annotations: LOCAL_MUTATION_IDEMPOTENT,
    },
    {
      requires: none('sync.now triggers replication without an admission gate'),
      ensures: none('sync.now coordinates remote replication and appends no catalog event'),
      needs: none('sync.now runs through the in-process sync driver'),
      touches: {
        frame: 'single-machine',
        resources: none('sync.now coordinates remote replication without a named stream, path, worktree, or git-ref'),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: none('sync.now emits no catalog events'),
    },
    { annotations: LOCAL_MUTATION_IDEMPOTENT },
  ),
];
