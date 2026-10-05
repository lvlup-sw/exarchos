import { PRUNE_ACTION_KNOWN_KEYS, REMOVED_PRUNE_ACTION_KNOBS, removedPruneKnobMessage, unrecognizedPruneKeyMessage } from '../../../config/prune-removed-knobs.js';
import { vacuityWaiver } from '../../../output-schema-declaration.js';
import { agentSpecSchema as agentSpecSchemaForRegistry } from '../../../runtime/agents/handler.js';
import { z } from 'zod';
import { declared, none, withActionContract } from '../../action-contract.js';
import { COMPENSABLE_LOCAL, LOCAL_MUTATION, READ_ONLY_LOCAL } from '../../annotations.js';
import { RUNBOOK_ECONOMY_BUDGET_TOKENS } from '../../hints.js';
import { ALL_PHASES, ROLE_ANY, ROLE_LEAD, featureIdSchema } from '../../phases.js';
import type { BuiltinActionDraft, BuiltinToolAction } from '../../types.js';

function contracted(action: BuiltinActionDraft, contract: unknown): BuiltinToolAction {
  return withActionContract(action, contract, { annotations: action.annotations });
}

export const lifecycleOpsActions: readonly BuiltinToolAction[] = [
  contracted(
    {
      name: 'prune_stale_workflows',
      description: 'Find stale non-terminal workflows and cancel them. Defaults to dry-run; pass dryRun:false to actually prune. Auto-emits workflow.pruned event per pruned workflow.',
      /**
       * Per-phase staleness comes from the `staleness` blocks of `topology.yaml`. A plain
       * `z.object` strips unknown keys before a refinement runs. `.passthrough()` keeps them
       * visible to `.superRefine`, which gives a removed knob an actionable removal message and
       * still rejects other unknown keys.
       */
      schema: z
        .object({
          dryRun: z.boolean().optional(),
          force: z.boolean().optional(),
          includeOneShot: z.boolean().optional(),
        })
        .passthrough()
        .superRefine((val, ctx) => {
          for (const key of Object.keys(val)) {
            if (REMOVED_PRUNE_ACTION_KNOBS.has(key)) {
              ctx.addIssue({ code: 'custom', path: [key], message: removedPruneKnobMessage(key) });
            } else if (!PRUNE_ACTION_KNOWN_KEYS.has(key)) {
              ctx.addIssue({ code: 'custom', path: [key], message: unrecognizedPruneKeyMessage(key) });
            }
          }
        }),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      outputSchema: vacuityWaiver('exarchos_orchestrate.prune_stale_workflows'),
      annotations: COMPENSABLE_LOCAL,
    },
    {
      requires: none('pruning consults topology staleness rather than an admission obligation'),
      ensures: declared({ source: 'event-append', when: 'success', event: 'workflow.pruned' }),
      needs: none('pruning cancels through the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'stale-workflow' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'reject-replay', because: 'a destructive prune must not repeat the cancel pass' },
      emissions: declared(
        {
          event: 'workflow.pruned',
          condition: 'conditional',
          description: 'Per pruned workflow when dryRun is false',
          role: 'primary',
          owner: 'orchestrate',
        },
        {
          /**
           * The audit line of the evaluation, on dry-run and on apply. It is conditional because
           * malformed-entry handling can suppress it, and a failed append never reaches the caller.
           */
          event: 'prune.diagnostics',
          condition: 'conditional',
          description: 'Once per evaluation, unless diagnostics are suppressed',
          role: 'primary',
          owner: 'orchestrate',
        },
      ),
    },
  ),
  contracted(
    {
      name: 'request_synthesize',
      description: 'Opt-in event for oneshot workflows with synthesisPolicy:on-request. Appending a synthesize.requested event flips the choice-state guard so finalize_oneshot routes to the synthesize phase. Auto-emits synthesize.requested.',
      schema: z.object({
        featureId: featureIdSchema,
        reason: z.string().optional(),
      }),
      /**
       * Allowed in `plan` and `implementing`. The `synthesisOptedIn` guard reads the event only at
       * the choice state after `implementing`, so an earlier request waits in the stream.
       */
      phases: new Set<string>(['plan', 'implementing']),
      roles: ROLE_LEAD,
      /**
       * An advisory hint. The synthesize phase has many steps, so the verb that gates it suits
       * Tasks-augmented dispatch. Dispatch keeps the binding opt-in gate.
       */
      dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 },
      outputSchema: vacuityWaiver('exarchos_orchestrate.request_synthesize'),
      annotations: LOCAL_MUTATION,
    },
    {
      requires: none('the synthesize-requested fact is an opt-in signal, not a gate'),
      ensures: declared({ source: 'event-append', when: 'always', event: 'synthesize.requested' }),
      needs: none('request_synthesize appends through the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'featureId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared({
        event: 'synthesize.requested',
        condition: 'always',
        role: 'primary',
        owner: 'orchestrate',
      }),
    },
  ),
  contracted(
    {
      name: 'finalize_oneshot',
      description: 'Resolve the oneshot choice-state at the end of implementing: transitions to synthesize (PR path) or completed (direct-commit path) based on the synthesisOptedIn / synthesisOptedOut guards. The transition itself is emitted by the workflow set handler.',
      schema: z.object({
        featureId: featureIdSchema,
      }),
      phases: new Set<string>(['implementing']),
      roles: ROLE_LEAD,
      outputSchema: vacuityWaiver('exarchos_orchestrate.finalize_oneshot'),
      annotations: LOCAL_MUTATION,
    },
    {
      requires: none('choice-state resolution reads already-appended synthesize signals'),
      ensures: none('the workflow set handler emits the phase transition, not this action'),
      needs: none('finalize_oneshot resolves choice-state in-process'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'featureId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: none('phase transition events belong to the workflow set handler'),
    },
  ),
  contracted(
    {
      name: 'runbook',
      description: 'List available runbooks or get a resolved runbook with schemas',
      schema: z.object({
        phase: z.string().optional(),
        id: z.string().optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      /** A verbose detail path by design: a resolved runbook with step schemas. */
      economy: { budgetTokens: RUNBOOK_ECONOMY_BUDGET_TOKENS },
      outputSchema: vacuityWaiver('exarchos_orchestrate.runbook'),
      annotations: READ_ONLY_LOCAL,
    },
    {
      requires: none('runbook is a read-only catalog query'),
      ensures: none('runbook returns ephemeral schema text with no durable postcondition'),
      needs: none('runbook inspects in-process registry content'),
      touches: {
        frame: 'single-machine',
        resources: none('runbook does not touch streams, paths, worktrees, or git refs'),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: none('runbook emits no catalog events'),
    },
  ),
  contracted(
    {
      name: 'agent_spec',
      description: 'Retrieve agent specification for subagent dispatch',
      schema: agentSpecSchemaForRegistry,
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      outputSchema: vacuityWaiver('exarchos_orchestrate.agent_spec'),
      annotations: READ_ONLY_LOCAL,
    },
    {
      requires: none('agent_spec is a read-only specification lookup'),
      ensures: none('agent_spec returns ephemeral spec text with no durable postcondition'),
      needs: declared('subagent:spawn'),
      touches: {
        frame: 'single-machine',
        resources: none('agent_spec does not touch streams, paths, worktrees, or git refs'),
      },
      executionAuthority: { kind: 'host', obligation: 'agent-spawn' },
      replay: { kind: 'safe-repeat' },
      emissions: none('agent_spec emits no catalog events'),
    },
  ),
  contracted(
    {
      name: 'doctor',
      description: 'Run exarchos environment diagnostics — checks across runtime, storage, VCS, agent config, plugin, env, and remote surfaces. Read-only by default; emits diagnostic.executed on completion. Pass --fix to repair reconcilable drift through the shared onboarding reconciler (the same apply onboard uses) — under --fix it emits onboard.requested then onboard.executed with trigger doctor-fix (NOT diagnostic.executed) and re-runs the checks to report residuals. Do not use --fix for a read-only diagnosis; omit it.',
      schema: z.object({
        timeoutMs: z.number().int().positive().optional(),
        format: z.enum(['table', 'json']).optional(),
        /**
         * Repairs reconcilable drift through the shared reconciler. `addFlagsFromSchema` makes the
         * CLI `--fix` flag from this field.
         */
        fix: z.boolean().optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      outputSchema: vacuityWaiver('exarchos_orchestrate.doctor'),
      /**
       * `doctor` appends an event on each call, so the annotation is a local mutation. A read-only
       * annotation lets a read-only client cause event-store writes.
       */
      annotations: LOCAL_MUTATION,
    },
    {
      requires: none('doctor diagnoses the local environment without an admission obligation'),
      ensures: declared({ source: 'event-append', when: 'success', event: 'diagnostic.executed' }),
      needs: declared('fs:read', 'fs:write'),
      touches: {
        frame: 'single-machine',
        resources: declared(
          { kind: 'stream', selector: 'exarchos-doctor' },
          { kind: 'path', selector: '.exarchos' },
        ),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared(
        {
          event: 'diagnostic.executed',
          condition: 'conditional',
          description: 'On the read-only path (no --fix)',
          role: 'primary',
          owner: 'orchestrate',
        },
        {
          event: 'onboard.requested',
          condition: 'conditional',
          description: 'Under --fix (shared reconciler intent)',
          role: 'recovery',
          owner: 'orchestrate',
          recoveryExpiresAt: '2027-12-31T00:00:00.000Z',
        },
        {
          event: 'onboard.executed',
          condition: 'conditional',
          description: 'Under --fix (shared reconciler result)',
          role: 'recovery',
          owner: 'orchestrate',
          recoveryExpiresAt: '2027-12-31T00:00:00.000Z',
        },
      ),
    },
  ),
];
