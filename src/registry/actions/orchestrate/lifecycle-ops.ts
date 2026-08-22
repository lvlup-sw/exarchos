import { PRUNE_ACTION_KNOWN_KEYS, REMOVED_PRUNE_ACTION_KNOBS, removedPruneKnobMessage, unrecognizedPruneKeyMessage } from '../../../config/prune-removed-knobs.js';
import { vacuityWaiver } from '../../../output-schema-declaration.js';
import { agentSpecSchema as agentSpecSchemaForRegistry } from '../../../runtime/agents/handler.js';
import { z } from 'zod';
import { declared, none, withActionContract } from '../../action-contract.js';
import { COMPENSABLE_LOCAL, LOCAL_MUTATION, READ_ONLY_LOCAL } from '../../annotations.js';
import { RUNBOOK_ECONOMY_BUDGET_TOKENS } from '../../hints.js';
import { ALL_PHASES, ROLE_ANY, ROLE_LEAD, featureIdSchema } from '../../phases.js';
import type { BuiltinToolAction } from '../../types.js';

function contracted(action: BuiltinToolAction, contract: unknown): BuiltinToolAction {
  return withActionContract(action, contract, { annotations: action.annotations });
}

export const lifecycleOpsActions: readonly BuiltinToolAction[] = [
  contracted(
    {
      name: 'prune_stale_workflows',
      description: 'Find stale non-terminal workflows and cancel them. Defaults to dry-run; pass dryRun:false to actually prune. Auto-emits workflow.pruned event per pruned workflow.',
      // `thresholdMinutes` was removed in the debloat wave (DR-9): per-phase
      // staleness has lived exclusively in `topology.yaml` `staleness` blocks
      // since #1334 (v2.10.0-preview.1), so the field was accepted-but-ignored.
      // Dropping it here also drops the auto-emitted `--threshold-minutes` CLI
      // flag.
      //
      // The rejection lives HERE, on the real dispatch/CLI seam — NOT in the
      // handler. A plain `z.object` SILENTLY STRIPS unknown keys before any
      // refinement runs, so a legacy `thresholdMinutes` would be
      // accepted-then-ignored (`dispatch()` forwards the stripped `parsed.data`
      // and the handler never sees the key). `.passthrough()` keeps the extra key
      // VISIBLE to the `.superRefine` below, which emits an ACTIONABLE removal
      // issue (naming DR-9, #1334, and `topology.yaml`) — the actionable message
      // WINS because passthrough never emits a competing generic
      // `unrecognized_keys` for it. Genuinely-unknown keys (caller typos) are
      // still rejected, preserving the per-action typo guard. `.shape` is retained
      // (verified), so `buildRegistrationSchema` and the tolerant-dispatch
      // sibling-key stripping (core/dispatch.ts) are undisturbed.
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
      autoEmits: [
        { event: 'workflow.pruned', condition: 'conditional', description: 'Per pruned workflow when dryRun is false', role: 'primary', owner: 'orchestrate' },
      ],
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
      emissions: declared({
        event: 'workflow.pruned',
        condition: 'conditional',
        description: 'Per pruned workflow when dryRun is false',
        role: 'primary',
        owner: 'orchestrate',
      }),
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
      // Allowed from `plan` as well as `implementing`: the synthesisOptedIn
      // guard only fires at the `implementing → ?` choice-state boundary, so
      // emitting the event earlier is idempotent — it sits in the event stream
      // until finalize_oneshot reads it. Restricting to `implementing` broke
      // the "I know I'll want a PR" signal during planning.
      phases: new Set<string>(['plan', 'implementing']),
      roles: ROLE_LEAD,
      autoEmits: [
        { event: 'synthesize.requested', condition: 'always', role: 'primary', owner: 'orchestrate' },
      ],
      // T9 (#1440 Op 2, preview-4 design §4.3): the registry-canonical
      // name for the design's "synthesize" verb — PR creation flow flipped
      // by emitting `synthesize.requested` to the choice-state guard.
      // The synthesize phase itself is multi-step (branch staging, PR open,
      // CI wait) so the verb that gates it benefits from Tasks-augmented
      // dispatch. Advisory — the binding opt-in gate stays at
      // `dispatch/core/dispatch.ts:927-954`.
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
      // DR-1: verbose-by-design detail path — a resolved runbook with step schemas.
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
      description: 'Run exarchos environment diagnostics — 12 checks across runtime, storage, VCS, agent config, plugin, env, and remote surfaces. Read-only by default; emits diagnostic.executed on completion. Pass --fix to repair reconcilable drift through the shared onboarding reconciler (the same apply onboard uses) — under --fix it emits onboard.requested then onboard.executed with trigger doctor-fix (NOT diagnostic.executed) and re-runs the checks to report residuals. Do not use --fix for a read-only diagnosis; omit it.',
      schema: z.object({
        timeoutMs: z.number().int().positive().optional(),
        format: z.enum(['table', 'json']).optional(),
        // DR-4: repair reconcilable drift through the shared reconciler. The CLI
        // `--fix` flag auto-emits from this schema via `addFlagsFromSchema`.
        fix: z.boolean().optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      autoEmits: [
        { event: 'diagnostic.executed', condition: 'conditional', description: 'On the read-only path (no --fix)', role: 'primary', owner: 'orchestrate' },
        // The two onboarding rows fire ONLY on the --fix repair path, backstopping
        // an environment that `onboard` already provisioned and that has since
        // drifted — `onboard` stays the primary declarer of both. No expiry: the
        // repair path is permanent infrastructure, not a time-boxed stopgap.
        { event: 'onboard.requested', condition: 'conditional', description: 'Under --fix (shared reconciler intent)', role: 'recovery', owner: 'orchestrate' },
        { event: 'onboard.executed', condition: 'conditional', description: 'Under --fix (shared reconciler result)', role: 'recovery', owner: 'orchestrate' },
      ],
      outputSchema: vacuityWaiver('exarchos_orchestrate.doctor'),
      // sentry HIGH on PR #1369: `doctor` emits `diagnostic.executed` on
      // every invocation (see `autoEmits` above and
      // `verbs/doctor/index.ts:204`). The advisory annotation must
      // match the actual write surface — `readOnly: true` would let a
      // readonly-capability client trigger event-store writes and bypass
      // the audit boundary.
      annotations: LOCAL_MUTATION,
    },
    {
      requires: none('doctor diagnoses the local environment without an admission obligation'),
      ensures: declared({ source: 'event-append', when: 'success', event: 'diagnostic.executed' }),
      needs: declared('fs:read', 'fs:write'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'path', selector: '.exarchos' }),
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
