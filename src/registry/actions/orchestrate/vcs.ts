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
 * `create_pr`, `add_pr_comment` and `create_issue` all state the shared `vcs`
 * stream on their RESOURCE axis, so observation resolves the stream their two
 * journal records land on from the declaration itself rather than from the
 * call's own arguments.
 *
 * Given that, the abstention here stands on the division between the axes,
 * not on stream resolution. Both records are catalog events appended
 * unconditionally, which is what the emission axis declares and what the
 * verifier already checks — on that same resolved stream. Restating them as
 * postconditions would give one fact two declarations free to drift apart.
 * What the postcondition axis carries and the emission axis cannot express is
 * durable evidence, and these handlers record none.
 */
const VCS_JOURNAL_ENSURES = none(
  'the two journal records are declared on the emission axis and checked there against the vcs stream this action declares; the postcondition axis carries the durable evidence this handler does not record',
);

export const vcsActions: readonly BuiltinToolAction[] = [
  // ─── VCS Actions ──────────────────────────────────────────────────────────
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
        // DR-1 (#1593) task 006: optional — grounds the PR body in
        // `artifacts.intent` (a deterministic `## Intent` section). Absent /
        // unreadable / empty intent → the body is left untouched.
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
        resources: declared(
          // First, and a stream LITERAL rather than an argument name: the two
          // journal records go here whatever `featureId` the caller passed.
          // Spelled out rather than imported from the reserved-id module, the
          // way every other infrastructure-stream declaration in this tree is —
          // the declarations may reference schemas, not reach into the
          // dispatch core.
          { kind: 'stream', selector: 'vcs' },
          { kind: 'git-ref', selector: 'head' },
          { kind: 'git-ref', selector: 'base' },
        ),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'reject-replay', because: 'creating a pull request is a remote side effect that would open a second request' },
      // `pr.created` used to stand here. Nothing in the shipped tree appends it —
      // the handler has journalled the intent/result pair since the two-event
      // split — so the declaration named an event that could never land.
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
      // The append fires only when the provider reports the merge landed —
      // a declined merge is a successful call with no record, and the
      // postcondition vocabulary (`success` / `failure` / `always`) has no
      // way to state "required when the remote outcome says so, silent
      // otherwise". A `when: 'success'` ensures here would fire the
      // postcondition check on every declined merge too, reporting a
      // violation for a call that correctly wrote nothing.
      //
      // That is a real gap in what this axis can express, not a reason to
      // leave the record unguarded: the handler itself refuses to report
      // success when the merge landed but the append then failed, rather
      // than let a completed merge go unrecorded with no signal anywhere.
      // The postcondition axis cannot state that conditional obligation;
      // the handler enforces it directly instead.
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
        // DR-3 — window + projection inputs, schema-declared so the CLI flags
        // auto-emit via schema-to-flags. The default newest-window + `page`
        // metadata + `fields` projection land in the handler under Task 006;
        // Task 022 owns only the schema surface here.
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
      // `pr.commented` used to stand here and nothing appends it.
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
      // `issue.created` used to stand here and nothing appends it.
      emissions: declared(
        { event: 'issue.create.requested', condition: 'always', owner: 'orchestrate', role: 'primary' },
        { event: 'issue.create.executed', condition: 'always', owner: 'orchestrate', role: 'primary' },
      ),
    },
    { annotations: COMPENSABLE_REMOTE },
  ),
];
