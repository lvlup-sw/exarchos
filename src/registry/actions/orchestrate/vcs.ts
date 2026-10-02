import { coercedNonnegativeInt, coercedPositiveInt, coercedStringArray } from '../../../coerce.js';
import { vacuityWaiver } from '../../../output-schema-declaration.js';
import { z } from 'zod';
import { declared, none, withActionContract } from '../../action-contract.js';
import { COMPENSABLE_REMOTE, READ_ONLY_REMOTE } from '../../annotations.js';
import { ALL_PHASES, ROLE_ANY, featureIdSchema } from '../../phases.js';
import type { BuiltinToolAction } from '../../types.js';

const VCS_READ_REQUIRES = none('read-only VCS queries have no admission obligation');
const VCS_READ_ENSURES = none('read-only VCS queries write no durable postcondition');
const VCS_PROVIDER_NEEDS = none('VCS provider calls are not in the closed capability vocabulary');
const VCS_READ_EMISSIONS = none('read-only VCS queries emit no catalog events');

/**
 * The ensures abstention for `create_pr`, `add_pr_comment` and `create_issue`. Each declares the
 * shared `vcs` stream as a resource, and its two journal records land there.
 * The emission axis declares those records, and the verifier checks them on that stream.
 * A postcondition for the same records gives one fact two declarations. These handlers record no
 * durable evidence, which is the only thing the postcondition axis adds.
 */
const VCS_JOURNAL_ENSURES = none(
  'the two journal records are declared on the emission axis and checked there against the vcs stream this action declares; the postcondition axis carries the durable evidence this handler does not record',
);

export const vcsActions: readonly BuiltinToolAction[] = [
  withActionContract(
    {
      name: 'create_pr',
      description: 'Create a pull/merge request via the VCS provider abstraction. Auto-emits pr.create.requested before the provider call and pr.create.executed after it.',
      schema: z.object({
        title: z.string().min(1),
        body: z.string().min(1),
        base: z.string().min(1),
        head: z.string().min(1),
        draft: z.boolean().optional(),
        labels: z.array(z.string()).optional(),
        /**
         * Selects the workflow for the single-PR-owner guard. The handler also adds an `## Intent`
         * section from its `artifacts.intent`. A missing or empty intent leaves the body unchanged.
         */
        featureId: featureIdSchema.optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      outputSchema: vacuityWaiver('exarchos_orchestrate.create_pr'),
      annotations: COMPENSABLE_REMOTE,
    },
    {
      requires: none('PR creation has no admission gate or approval discriminant'),
      ensures: VCS_JOURNAL_ENSURES,
      needs: VCS_PROVIDER_NEEDS,
      touches: {
        frame: 'single-machine',
        /**
         * The `vcs` stream comes first, as a literal, because the two journal records land there for
         * any `featureId`. It is not imported from the reserved-id module, so the declarations do not
         * reach into the dispatch core.
         */
        resources: declared(
          { kind: 'stream', selector: 'vcs' },
          { kind: 'git-ref', selector: 'head' },
          { kind: 'git-ref', selector: 'base' },
        ),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'reject-replay', because: 'creating a pull request is a remote side effect that would open a second request' },
      emissions: declared(
        { event: 'pr.create.requested', condition: 'always', owner: 'orchestrate', role: 'primary' },
        { event: 'pr.create.executed', condition: 'always', owner: 'orchestrate', role: 'primary' },
      ),
    },
    { annotations: COMPENSABLE_REMOTE },
  ),
  withActionContract(
    {
      name: 'merge_pr',
      description: 'Merge a pull/merge request via the VCS provider abstraction. Auto-emits pr.merged event on success.',
      schema: z.object({
        prId: z.string().min(1),
        strategy: z.enum(['squash', 'rebase', 'merge']),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      outputSchema: vacuityWaiver('exarchos_orchestrate.merge_pr'),
      annotations: COMPENSABLE_REMOTE,
    },
    {
      requires: none('provider PR merge has no authored admission discriminant'),
      /**
       * A declined merge is a successful call with no record, and the `when` vocabulary cannot state
       * that condition. A `when: 'success'` ensure reports a violation on each declined merge.
       * Instead, the handler withholds success when the merge lands but the append fails.
       */
      ensures: none(
        'a declined merge is a successful call with no durable record and the postcondition vocabulary cannot express that condition; when the merge DOES land, the handler itself withholds success on a failed append rather than reporting one silently missing',
      ),
      needs: VCS_PROVIDER_NEEDS,
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'vcs' }, { kind: 'git-ref', selector: 'prId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'reject-replay', because: 'merging a pull request is a one-shot remote mutation' },
      emissions: declared({
        event: 'pr.merged',
        condition: 'conditional',
        owner: 'orchestrate',
        role: 'primary',
        description: 'When merge succeeds',
      }),
    },
    { annotations: COMPENSABLE_REMOTE },
  ),
  withActionContract(
    {
      name: 'check_ci',
      description: 'Check CI status for a pull/merge request via the VCS provider abstraction. Read-only, no events emitted.',
      schema: z.object({
        prId: z.string().min(1),
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
        prId: z.string().min(1),
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
  withActionContract(
    {
      name: 'add_pr_comment',
      description: 'Add a comment to a pull/merge request via the VCS provider abstraction. Pass threadId to reply into an existing review-comment thread (provider-agnostic addReply) instead of posting a PR-level comment. Auto-emits pr.comment.requested before the provider call and pr.comment.executed after it.',
      schema: z.object({
        prId: z.string().min(1),
        body: z.string().min(1),
        threadId: z.string().min(1).optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      outputSchema: vacuityWaiver('exarchos_orchestrate.add_pr_comment'),
      annotations: COMPENSABLE_REMOTE,
    },
    {
      requires: none('PR comments have no admission gate or approval discriminant'),
      ensures: VCS_JOURNAL_ENSURES,
      needs: VCS_PROVIDER_NEEDS,
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'vcs' }, { kind: 'git-ref', selector: 'prId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'reject-replay', because: 'posting a comment is a remote side effect that would duplicate the thread entry' },
      emissions: declared(
        { event: 'pr.comment.requested', condition: 'always', owner: 'orchestrate', role: 'primary' },
        { event: 'pr.comment.executed', condition: 'always', owner: 'orchestrate', role: 'primary' },
      ),
    },
    { annotations: COMPENSABLE_REMOTE },
  ),
  withActionContract(
    {
      name: 'create_issue',
      description: 'Create an issue via the VCS provider abstraction. Auto-emits issue.create.requested before the provider call and issue.create.executed after it.',
      schema: z.object({
        title: z.string().min(1),
        body: z.string().min(1),
        labels: z.array(z.string()).optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      outputSchema: vacuityWaiver('exarchos_orchestrate.create_issue'),
      annotations: COMPENSABLE_REMOTE,
    },
    {
      requires: none('issue creation has no admission gate or approval discriminant'),
      ensures: VCS_JOURNAL_ENSURES,
      needs: VCS_PROVIDER_NEEDS,
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'vcs' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'reject-replay', because: 'creating an issue is a remote side effect that would open a second issue' },
      emissions: declared(
        { event: 'issue.create.requested', condition: 'always', owner: 'orchestrate', role: 'primary' },
        { event: 'issue.create.executed', condition: 'always', owner: 'orchestrate', role: 'primary' },
      ),
    },
    { annotations: COMPENSABLE_REMOTE },
  ),
];
