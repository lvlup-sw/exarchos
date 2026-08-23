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
// DR-3 / B-3 — `prNumbers` and its int-array peers bind the shared, CSV-tolerant
// `coercedIntArray` helper imported from `coerce.ts` (Task 010). It accepts a
// JSON-stringified array (`"[1660,1671]"`), a CSV string (`"1660,1671,1659"`),
// or a native array, so the direct-MCP path funnels the same shapes the CLI's
// `coerceFlags` splitter produces. (The former local stub here was NOT
// CSV-tolerant and made the direct-MCP CSV path fail INVALID_INPUT while its
// tests exercised the unused shared helper — review fix.)

  withContract({
    name: 'task_claim',
    description: 'Claim a task for execution',
    schema: z.object({
      taskId: z.string().min(1),
      agentId: z.string().min(1),
      // DR-6: `streamId` IS the bare featureId. Both spellings are accepted
      // and exactly one is required (`resolveStreamIdentity` in
      // `tasks/tools.ts` is the single resolver). Requiring only the
      // internal spelling made agents ASK the operator for a value they
      // already held under the name every workflow surface uses.
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
      // DR-6: `streamId` IS the bare featureId. Both spellings are accepted
      // and exactly one is required (`resolveStreamIdentity` in
      // `tasks/tools.ts` is the single resolver). Requiring only the
      // internal spelling made agents ASK the operator for a value they
      // already held under the name every workflow surface uses.
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
      // DR-6: `streamId` IS the bare featureId. Both spellings are accepted
      // and exactly one is required (`resolveStreamIdentity` in
      // `tasks/tools.ts` is the single resolver). Requiring only the
      // internal spelling made agents ASK the operator for a value they
      // already held under the name every workflow surface uses.
      streamId: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_TEAMMATE,
    outputSchema: vacuityWaiver('exarchos_orchestrate.task_fail'),
    annotations: LOCAL_MUTATION,
  }, {
    // `when` is the DISPATCH outcome, not the task's. A `task_fail` call that
    // records a failed task succeeds, and that is the path on which
    // `task.failed` is appended — which is also what this action's own
    // `emissions` say by declaring the event unconditional.
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
    // `review/tools.ts::emitRoutedEvents` appends one row per dispatched review, from this
    // handler. The action declared no emissions at all, which left the registration claiming a
    // consumer folds an event that nothing in the registry said anyone emits.
    outputSchema: vacuityWaiver('exarchos_orchestrate.review_triage'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared({ source: 'event-append', when: 'success', event: 'review.routed' }),
    needs: declared('mcp:exarchos'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
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
    description: 'Query delegation readiness and prepare quality hints for subagent dispatch',
    schema: z.object({
      featureId: z.string().min(1),
      // #1636: the per-task object accepts the planner's verification-routing
      // stamps. Previously `z.object({ id, title })` default-stripped them, so
      // `deriveRiskTier`/`deriveBoundaryTouching`'s "planner value wins" branch
      // was structurally unreachable via MCP and every task fell through to the
      // keyword/glob heuristic. `files`/`blockedBy`/`testLayer` feed the heuristic
      // fallback for UNstamped tasks. Base types match the top-level `riskTier`
      // override to stay clear of the joint-schema collision guard.
      tasks: z.array(z.object({
        id: z.string(),
        title: z.string(),
        riskTier: z.enum(['low', 'medium', 'high']).optional(),
        boundaryTouching: z.boolean().optional(),
        files: z.array(z.string()).optional(),
        blockedBy: z.array(z.string()).optional(),
        testLayer: z.enum(['acceptance', 'integration', 'unit', 'property']).optional(),
      })).optional(),
      // #1636: point at the decomposition markdown to have the per-task stamps
      // lifted automatically (deterministic parse — no LLM). An explicit field on
      // a `tasks[]` entry still wins over the parsed stamp; the parsed stamp wins
      // over the heuristic. Absent, behavior is unchanged.
      planPath: z.string().optional().describe('Decomposition markdown path; lifts per-task **Risk Tier:**/**Boundary Touching:** stamps onto tasks'),
      nativeIsolation: z.boolean().default(false).describe('When true, skip worktree-related blockers (the host platform handles isolation natively)'),
      // DR-2: explicit workflow-level risk-tier override. Absent, prepare_delegation
      // derives state.riskTier as the max-of-tiers over the classified wave; when
      // supplied it WINS over the derived value (the planner has context the
      // heuristic cannot infer).
      riskTier: z.enum(['low', 'medium', 'high']).optional().describe('Explicit workflow risk-tier override; wins over the derived max-of-tiers'),
      // DR-4: the full-prompt escape hatch. `detail:true` (or its alias
      // `outputFormat:'prompt-only'`) inlines the full per-task implementer
      // prompt instead of the deduped template + per-task deltas. Declared on
      // the schema so the hatch is reachable through BOTH facades — Zod would
      // otherwise `.strip()` an undeclared key on the MCP path, and the CLI
      // would emit no flag (review fix: previously the handler honored these but
      // the schema declared neither, so the affordance was dead). `outputFormat`
      // mirrors `agent_spec.outputFormat` exactly to satisfy the registration
      // flattener's field-contract guard (`buildRegistrationSchema`).
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
    emissions: declared({
      event: 'quality.hint.generated',
      condition: 'conditional',
      owner: 'orchestrate',
      role: 'primary',
      description: 'When hints exist',
    }),
  }),
  withContract({
    name: 'prepare_synthesis',
    description: 'Run pre-synthesis checks: tests, typecheck, stack health. Emits events for readiness views and eval flywheel.',
    schema: z.object({
      featureId: z.string().min(1),
      // Required: the handler shells out tests/typecheck/git against this
      // absolute path. Dispatch strips undeclared sibling keys, so omitting
      // the field here made every production call arrive without repoRoot.
      repoRoot: z.string().min(1),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, gateClass: 'prepare-synthesis' },
    // DR-5: invokes `npm run test:run` + typecheck under the hood; seconds
    // to minutes on non-trivial repos.  CLI adapter emits heartbeats.
    longRunning: true,
    outputSchema: vacuityWaiver('exarchos_orchestrate.prepare_synthesis'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'prepare-synthesis' },
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
  // Recording a stack position IS a mutation — the handler validates the
  // position and appends `stack.position-filled`. It sat on `exarchos_view`,
  // where its registration named `exarchos_orchestrate` as the effect provider
  // and the two could never agree. The read half (`stack_status`) stays on the
  // view tool; only the writer moved.
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
      // DR-3/Task 010 — route `prNumbers` through the coercion layer as an int
      // array (CSV tolerance rides Task 010's coerce.ts helper).
      prNumbers: coercedIntArray(),
      // DR-2 — per-PR comment paging inputs, schema-declared so the CLI flags
      // auto-emit. The capped comments + `page` metadata land in the handler
      // under DR-2 (Task 002 shaping); Task 022 owns only the schema surface.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    // DR-5: shells out to `gh` across each PR in the stack; latency scales
    // with stack depth + GitHub API round-trip time.
    longRunning: true,
    outputSchema: vacuityWaiver('exarchos_orchestrate.assess_stack'),
    // sentry LOW on PR #1369: `assess_stack` reads GitHub PR state but
    // also emits 3 shepherd lifecycle events + gate.executed on every
    // call. `readOnly: true` would mislead clients that gate on the
    // hint. REMOTE_MUTATION matches the actual write surface; the
    // conditional emission discipline is a handler-level detail and
    // should not be smuggled into the advisory annotation.
    annotations: REMOTE_MUTATION,
  }, {
    ensures: declared({ source: 'event-append', when: 'always', event: 'gate.executed' }),
    needs: declared('mcp:exarchos'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared(
      { event: 'ci.status', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'One per PR assessed; none when the stack is empty' },
      { event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' },
      { event: 'shepherd.approval_requested', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'When approval needed' },
      { event: 'shepherd.completed', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'When PR merged' },
      { event: 'shepherd.escalated', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'When the auto-fix bound is reached' },
      { event: 'shepherd.started', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'First invocation (idempotent)' },
    ),
  }),
];
