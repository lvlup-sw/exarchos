import { coercedNonnegativeInt, coercedPositiveInt, coercedStringArray } from '../../../coerce.js';
import { vacuityWaiver } from '../../../output-schema-declaration.js';
import { z } from 'zod';
import { declared, none, withActionContract } from '../../action-contract.js';
import { READ_ONLY_REMOTE } from '../../annotations.js';
import { ALL_PHASES, ROLE_ANY } from '../../phases.js';
import type { BuiltinToolAction } from '../../types.js';

/**
 * A pull request number or a review comment id. The provider CLIs read a leading dash as a flag.
 * A URL, a repository reference, or a path can select another repository or another API route.
 */
const numericIdSchema = z.string().regex(/^[1-9]\d*$/, 'must be a positive integer');

const VCS_READ_REQUIRES = none('read-only VCS queries have no admission obligation');
const VCS_READ_ENSURES = none('read-only VCS queries write no durable postcondition');
const VCS_PROVIDER_NEEDS = none('VCS provider calls are not in the closed capability vocabulary');
const VCS_READ_EMISSIONS = none('read-only VCS queries emit no catalog events');

export const vcsActions: readonly BuiltinToolAction[] = [
  withActionContract(
    {
      name: 'check_ci',
      description: 'Check CI status for a pull/merge request via the VCS provider abstraction. Read-only, no events emitted.',
      schema: z.object({
        prId: numericIdSchema,
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      outputSchema: vacuityWaiver('exarchos_orchestrate.check_ci'),
      annotations: READ_ONLY_REMOTE,
    },
    {
      requires: VCS_READ_REQUIRES,
      ensures: VCS_READ_ENSURES,
      needs: VCS_PROVIDER_NEEDS,
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'git-ref', selector: 'prId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: VCS_READ_EMISSIONS,
    },
    { annotations: READ_ONLY_REMOTE },
  ),
  withActionContract(
    {
      name: 'list_prs',
      description: 'List pull/merge requests via the VCS provider abstraction. Read-only, no events emitted.',
      schema: z.object({
        state: z.enum(['open', 'closed', 'merged', 'all']).optional(),
        head: z.string().optional(),
        base: z.string().optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      outputSchema: vacuityWaiver('exarchos_orchestrate.list_prs'),
      annotations: READ_ONLY_REMOTE,
    },
    {
      requires: VCS_READ_REQUIRES,
      ensures: VCS_READ_ENSURES,
      needs: VCS_PROVIDER_NEEDS,
      touches: {
        frame: 'single-machine',
        resources: none('lists remote pull requests without binding a local stream, path, worktree, or git-ref'),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: VCS_READ_EMISSIONS,
    },
    { annotations: READ_ONLY_REMOTE },
  ),
  withActionContract(
    {
      name: 'get_pr_comments',
      description: 'Get comments on a pull/merge request via the VCS provider abstraction. Read-only, no events emitted.',
      schema: z.object({
        prId: numericIdSchema,
        /** The window and projection inputs. The schema declares them, so the CLI derives their flags. */
        limit: coercedPositiveInt().optional(),
        offset: coercedNonnegativeInt().optional(),
        fields: coercedStringArray().optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      outputSchema: vacuityWaiver('exarchos_orchestrate.get_pr_comments'),
      annotations: READ_ONLY_REMOTE,
    },
    {
      requires: VCS_READ_REQUIRES,
      ensures: VCS_READ_ENSURES,
      needs: VCS_PROVIDER_NEEDS,
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'git-ref', selector: 'prId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: VCS_READ_EMISSIONS,
    },
    { annotations: READ_ONLY_REMOTE },
  ),
];
