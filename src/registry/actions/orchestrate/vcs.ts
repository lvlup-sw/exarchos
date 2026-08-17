import { coercedNonnegativeInt, coercedPositiveInt, coercedStringArray } from '../../../coerce.js';
import { vacuityWaiver } from '../../../output-schema-declaration.js';
import { z } from 'zod';
import { COMPENSABLE_REMOTE, READ_ONLY_REMOTE } from '../../annotations.js';
import { ALL_PHASES, ROLE_ANY, featureIdSchema } from '../../phases.js';
import type { BuiltinToolAction } from '../../types.js';

export const vcsActions: readonly BuiltinToolAction[] = [
  // ─── VCS Actions ──────────────────────────────────────────────────────────
  {
    name: 'create_pr',
    description: 'Create a pull/merge request via the VCS provider abstraction. Auto-emits pr.created event.',
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
    autoEmits: [
      { event: 'pr.created', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.create_pr'),
    annotations: COMPENSABLE_REMOTE,
  },
  {
    name: 'merge_pr',
    description: 'Merge a pull/merge request via the VCS provider abstraction. Auto-emits pr.merged event on success.',
    schema: z.object({
      prId: z.string().min(1),
      strategy: z.enum(['squash', 'rebase', 'merge']),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'pr.merged', condition: 'conditional', description: 'When merge succeeds' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.merge_pr'),
    annotations: COMPENSABLE_REMOTE,
  },
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
    name: 'add_pr_comment',
    description: 'Add a comment to a pull/merge request via the VCS provider abstraction. Pass threadId to reply into an existing review-comment thread (provider-agnostic addReply) instead of posting a PR-level comment. Auto-emits pr.commented event.',
    schema: z.object({
      prId: z.string().min(1),
      body: z.string().min(1),
      threadId: z.string().min(1).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'pr.commented', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.add_pr_comment'),
    annotations: COMPENSABLE_REMOTE,
  },
  {
    name: 'create_issue',
    description: 'Create an issue via the VCS provider abstraction. Auto-emits issue.created event.',
    schema: z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      labels: z.array(z.string()).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'issue.created', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.create_issue'),
    annotations: COMPENSABLE_REMOTE,
  },
];
