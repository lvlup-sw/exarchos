import { coercedIntArray, coercedNonnegativeInt, coercedPositiveInt, coercedRecord } from '../../../coerce.js';
import { vacuityWaiver, withCappedShape } from '../../../output-schema-declaration.js';
import { StackPlaceOutputSchema } from '../../../verbs/stack/schemas.js';
import { z } from 'zod';
import { declared, none, withActionContract, type ActionContract } from '../../action-contract.js';
import { LOCAL_MUTATION, REMOTE_MUTATION } from '../../annotations.js';
import { DELEGATE_PHASES, REVIEW_PHASES, ROLE_ANY, ROLE_LEAD, ROLE_TEAMMATE, STACK_PHASES, SYNTHESIS_REVIEW_PHASES } from '../../phases.js';
import type { BuiltinActionDraft, BuiltinToolAction } from '../../types.js';

function withContract(
  action: BuiltinActionDraft,
  partial: {
    readonly requires?: ActionContract['requires'];
    readonly ensures: ActionContract['ensures'];
    readonly needs: ActionContract['needs'];
    readonly resources?: ActionContract['touches']['resources'];
    readonly replay: ActionContract['replay'];
    readonly emissions?: ActionContract['emissions'];
  },
): BuiltinToolAction {
  return withActionContract(
    action,
    {
      requires: partial.requires ?? none('this action does not consume a prior resolved gate or approval floor'),
      ensures: partial.ensures,
      needs: partial.needs,
      touches: {
        frame: 'single-machine',
        resources: partial.resources ?? none('this action does not address a stream, path, worktree, or git-ref'),
      },
      executionAuthority: { kind: 'local' },
      replay: partial.replay,
      emissions: partial.emissions ?? none('this action appends no catalog events'),
    },
    { annotations: action.annotations },
  );
}

export const coordinationActions: readonly BuiltinToolAction[] = [
  withContract({
    name: 'task_claim',
    description: 'Claim a task for execution',
    schema: z.object({
      taskId: z.string().min(1),
      agentId: z.string().min(1),
      /**
       * `streamId` is the bare featureId, and the schema accepts both names. `resolveStreamIdentity`
       * in `tasks/tools.ts` needs at least one, and `streamId` wins when both are present.
       */
      streamId: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_TEAMMATE,
    outputSchema: vacuityWaiver('exarchos_orchestrate.task_claim'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared({ source: 'event-append', when: 'success', event: 'task.claimed' }),
    needs: declared('mcp:exarchos'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'task.claimed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'task_complete',
    description: 'Mark a task as complete with optional result and evidence. Auto-emits task.completed event. When evidence is provided, verified=true in event data; otherwise verified=false',
    schema: z.object({
      taskId: z.string().min(1),
      result: coercedRecord().optional(),
      evidence: z.object({
        type: z.enum(['test', 'build', 'typecheck', 'manual']),
        output: z.string(),
        passed: z.boolean(),
      }).optional(),
      /**
       * `streamId` is the bare featureId, and the schema accepts both names. `resolveStreamIdentity`
       * in `tasks/tools.ts` needs at least one, and `streamId` wins when both are present.
       */
      streamId: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_TEAMMATE,
    outputSchema: vacuityWaiver('exarchos_orchestrate.task_complete'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared({ source: 'event-append', when: 'success', event: 'task.completed' }),
    needs: declared('mcp:exarchos'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'task.completed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'task_fail',
    description: 'Mark a task as failed with error details. Auto-emits task.failed event',
    schema: z.object({
      taskId: z.string().min(1),
      error: z.string().min(1),
      diagnostics: coercedRecord().optional(),
      /**
       * `streamId` is the bare featureId, and the schema accepts both names. `resolveStreamIdentity`
       * in `tasks/tools.ts` needs at least one, and `streamId` wins when both are present.
       */
      streamId: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_TEAMMATE,
    outputSchema: vacuityWaiver('exarchos_orchestrate.task_fail'),
    annotations: LOCAL_MUTATION,
  }, {
    /**
     * `when` is the dispatch outcome, not the task outcome. A `task_fail` call that records a failed
     * task succeeds, and `task.failed` is appended on that path.
     */
    ensures: declared({ source: 'event-append', when: 'success', event: 'task.failed' }),
    needs: declared('mcp:exarchos'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'task.failed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'review_triage',
    description: 'Score PRs by risk and dispatch to CodeRabbit or self-hosted review based on velocity',
    schema: z.object({
      featureId: z.string().min(1),
      prs: z.array(z.object({
        number: z.number().int().positive(),
        paths: z.array(z.string()),
        linesChanged: z.number().int().nonnegative(),
        filesChanged: z.number().int().nonnegative(),
        newFiles: z.number().int().nonnegative(),
      })),
      activeWorkflows: z.array(z.object({ phase: z.string() })).optional(),
      pendingCodeRabbitReviews: z.number().int().nonnegative().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.review_triage'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared({ source: 'event-append', when: 'success', event: 'review.routed' }),
    needs: declared('mcp:exarchos'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    /** `emitRoutedEvents` in `review/tools.ts` appends one row for each dispatched review. */
    emissions: declared({
      event: 'review.routed',
      condition: 'conditional',
      owner: 'orchestrate',
      role: 'primary',
      description: 'One per PR routed; none when nothing is dispatched',
    }),
  }),
  withContract({
    name: 'prepare_delegation',
    description:
      'Query delegation readiness and prepare quality hints for subagent dispatch. Announces each ' +
      'planned task the stream has not yet heard of (`task.assigned`) before reading readiness. ' +
      'Returns `baseBranch`, the integration branch the tasks fork from: pass it to the ' +
      'task-completion runbook as `baseRef`.',
    schema: z.object({
      featureId: z.string().min(1),
      /**
       * Each task accepts the verification-routing stamps of the planner, so the planner value wins in
       * `deriveRiskTier` and `deriveBoundaryTouching`. `files`, `blockedBy`, and `testLayer` feed the
       * heuristic for a task without stamps. The base types match the top-level `riskTier`, so the
       * joint-schema collision guard does not fire.
       */
      tasks: z.array(z.object({
        id: z.string(),
        title: z.string(),
        riskTier: z.enum(['low', 'medium', 'high']).optional(),
        boundaryTouching: z.boolean().optional(),
        files: z.array(z.string()).optional(),
        blockedBy: z.array(z.string()).optional(),
        testLayer: z.enum(['acceptance', 'integration', 'unit', 'property']).optional(),
      })).optional(),
      /**
       * The decomposition markdown. A deterministic parse lifts the per-task stamps from it. An
       * explicit `tasks[]` field wins over a parsed stamp, and a parsed stamp wins over the heuristic.
       */
      planPath: z.string().optional().describe('Decomposition markdown path; lifts per-task **Risk Tier:**/**Boundary Touching:** stamps onto tasks'),
      nativeIsolation: z.boolean().default(false).describe('When true, skip worktree-related blockers (the host platform handles isolation natively)'),
      /**
       * The workflow risk-tier override. Without it, `prepare_delegation` derives `state.riskTier` as
       * the highest tier of the classified tasks. A supplied value wins over the derived value.
       */
      riskTier: z.enum(['low', 'medium', 'high']).optional().describe('Explicit workflow risk-tier override; wins over the derived max-of-tiers'),
      /**
       * The full-prompt option. `detail: true`, or its alias `outputFormat: 'prompt-only'`, inlines the
       * full implementer prompt of each task. The schema declares both fields, so the MCP path keeps
       * them and the CLI emits their flags. `outputFormat` must match `agent_spec.outputFormat` for
       * the field-contract guard of `buildRegistrationSchema`.
       */
      detail: z.boolean().optional().describe('DR-4: inline the full per-task implementer prompt instead of the deduped template + per-task deltas'),
      outputFormat: z.enum(['full', 'prompt-only']).default('full').describe("DR-4: 'prompt-only' is an alias for detail:true; 'full' (default) returns the deduped template + per-task deltas"),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.prepare_delegation'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared({ source: 'event-append', when: 'success', event: 'quality.hint.generated' }),
    needs: declared('fs:read', 'mcp:exarchos'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'planPath' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared(
      {
        event: 'quality.hint.generated',
        condition: 'conditional',
        owner: 'orchestrate',
        role: 'primary',
        description: 'When hints exist',
      },
      {
        /**
         * The advisory stash probe of the dispatch guard runs from this handler. A clean stash list,
         * or a failed `git stash list`, appends nothing.
         */
        event: 'stash.detected',
        condition: 'conditional',
        owner: 'orchestrate',
        role: 'primary',
        description: 'When the pre-dispatch probe finds a stash entry',
      },
      {
        event: 'task.assigned',
        condition: 'conditional',
        owner: 'orchestrate',
        role: 'primary',
        description:
          'one per planned task the stream has not yet heard of, ahead of the readiness fold; ' +
          'none for a task already announced',
      },
    ),
  }),
  withContract({
    name: 'prepare_synthesis',
    description: 'Run pre-synthesis checks: tests, typecheck, stack health. Emits events for readiness views and eval flywheel.',
    schema: z.object({
      featureId: z.string().min(1),
      /**
       * The absolute path where the handler runs tests, typecheck, and git. It is required, because
       * dispatch strips undeclared keys.
       */
      repoRoot: z.string().min(1),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, gateClass: 'prepare-synthesis' },
    /** It runs the resolved test and typecheck commands, which can take minutes. The CLI adapter emits heartbeats. */
    longRunning: true,
    outputSchema: vacuityWaiver('exarchos_orchestrate.prepare_synthesis'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos', 'shell:exec'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'repoRoot' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  /**
   * A stack position record is a mutation: the handler validates the position and appends
   * `stack.position-filled`. The read half, `stack_status`, is on the view tool.
   */
  withContract({
    name: 'stack_place',
    description:
      'Record a task\'s position in a PR stack. Validates the position and appends stack.position-filled, which the stack projection folds into the ordered stack view. Use for: registering where a task sits in the stack after its branch or PR exists. Do NOT use for: reading current stack positions (use exarchos_view stack_status); assessing stack CI/review health (use assess_stack).',
    schema: z.object({
      streamId: z.string().min(1),
      position: coercedNonnegativeInt(),
      taskId: z.string().min(1),
      branch: z.string().optional(),
      prUrl: z.string().optional(),
    }),
    phases: STACK_PHASES,
    roles: ROLE_ANY,
    outputSchema: withCappedShape(StackPlaceOutputSchema),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared({ source: 'event-append', when: 'always', event: 'stack.position-filled' }),
    needs: declared('mcp:exarchos'),
    resources: declared(
      { kind: 'stream', selector: 'streamId' },
      { kind: 'git-ref', selector: 'branch' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'stack.position-filled', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'assess_stack',
    description: 'Assess PR stack health during synthesize: CI status, reviews, comments. Emits events for the shepherd iteration loop (within synthesize phase) and eval flywheel.',
    schema: z.object({
      featureId: z.string().min(1),
      /**
       * `coercedIntArray` accepts a JSON array string, a CSV string, or a native array. These are the
       * shapes that the CLI `coerceFlags` splitter makes.
       */
      prNumbers: coercedIntArray(),
      /** The per-PR comment paging. The schema declares it, so the CLI emits the flags. */
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    /** It runs `gh` for each PR in the stack, so the latency grows with the stack depth. */
    longRunning: true,
    outputSchema: vacuityWaiver('exarchos_orchestrate.assess_stack'),
    /**
     * The action reads GitHub PR state and also appends shepherd and CI events. `readOnly: true`
     * misleads clients that gate on the hint, so it uses `REMOTE_MUTATION`.
     */
    annotations: REMOTE_MUTATION,
  }, {
    /**
     * There is no `always` append postcondition. The action appends one row for each check that it
     * reads. It reads none for an empty stack, or when `queryPrChecks` records a provider failure.
     * The assessment still succeeds in both cases.
     */
    ensures: none('assess_stack reports observed CI state; a stack with no checks to read succeeds and appends nothing'),
    needs: declared('mcp:exarchos'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    /**
     * `ci.check_observed` gives one row for each observed CI check, beside the per-PR `ci.status`
     * roll-up. The two `provider.*` faults are per comment, and the handler records them and does
     * not raise them.
     */
    emissions: declared(
      { event: 'ci.status', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'One per PR assessed; none when the stack is empty' },
      { event: 'ci.check_observed', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'One per observed check; none when no check was read' },
      { event: 'shepherd.approval_requested', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'When approval needed' },
      { event: 'shepherd.completed', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'When PR merged' },
      { event: 'shepherd.escalated', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'When the auto-fix bound is reached' },
      { event: 'shepherd.started', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'First invocation (idempotent)' },
      { event: 'provider.parse-error', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'When a review adapter throws while parsing a comment' },
      { event: 'provider.unknown-tier', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'When a parsed action item carries a tier the adapter does not know' },
    ),
  }),
];
