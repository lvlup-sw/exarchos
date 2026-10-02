import { vacuityWaiver } from '../../../output-schema-declaration.js';
import { z } from 'zod';
import { declared, none, withActionContract } from '../../action-contract.js';
import { LOCAL_MUTATION } from '../../annotations.js';
import { ALL_PHASES, ROLE_ANY } from '../../phases.js';
import type { BuiltinActionDraft, BuiltinToolAction } from '../../types.js';

function contracted(action: BuiltinActionDraft, contract: unknown): BuiltinToolAction {
  return withActionContract(action, contract, { annotations: action.annotations });
}

export const onboardingActions: readonly BuiltinToolAction[] = [
  /**
   * `onboard` is the first-run verb. It runs the reconciler pipeline (detect, config, generate,
   * install, verify) and drives the repo to a green doctor. It is an action, not a visible tool.
   * The CLI derives its flags from this schema, which mirrors `HandleOnboardArgs` without `surface`.
   * The adapter injects `surface`, so a `surface` flag here lets a caller spoof the capability gate.
   */
  contracted(
    {
      name: 'onboard',
      description:
        'Onboard (or re-onboard) the current repo: detect runtimes + VCS, write/reconcile agent config, install skills, then verify against doctor — driving the repo to a green doctor. Idempotent; re-running reconciles drift only. Use --dry-run to preview the plan without writing, --new <name> to scaffold a fresh project first, --force to overwrite hand-edited config, and --no-hooks to skip the SessionStart binding. Do not use to re-run individual diagnostics — use doctor for that. Emits onboard.requested then onboard.executed (skipped under --dry-run).',
      schema: z.object({
        /** Scaffolds a project with this name, then runs the same pipeline. */
        new: z.string().optional(),
        /** Explicit agent-host runtime ids, which skip the probe. The CLI coerces CSV or JSON to the array. */
        runtime: z.array(z.string()).optional(),
        /** An explicit VCS id, which skips the `.git` probe. */
        vcs: z.string().optional(),
        /** Computes the plan with no side effect and no events. */
        dryRun: z.boolean().optional(),
        /** Overwrites hand-edited config. Without it, onboard keeps that config. */
        force: z.boolean().optional(),
        /** Skips the SessionStart hook step. */
        noHooks: z.boolean().optional(),
        /** The output projection. The carrier has the same shape for both values. */
        format: z.enum(['table', 'json']).optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      outputSchema: vacuityWaiver('exarchos_orchestrate.onboard'),
      annotations: LOCAL_MUTATION,
    },
    {
      requires: none('onboard reconciles local environment drift without an admission obligation'),
      ensures: declared(
        { source: 'event-append', when: 'always', event: 'onboard.requested' },
        { source: 'event-append', when: 'success', event: 'onboard.executed' },
      ),
      needs: declared('fs:read', 'fs:write'),
      touches: {
        frame: 'single-machine',
        /**
         * Onboard has no featureId, so its two events land on the reserved `exarchos-onboard` stream.
         * Post-dispatch observation finds the ensured appends through this stream.
         */
        resources: declared(
          { kind: 'stream', selector: 'exarchos-onboard' },
          { kind: 'path', selector: '.exarchos' },
        ),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared(
        {
          event: 'onboard.requested',
          condition: 'always',
          role: 'primary',
          owner: 'orchestrate',
        },
        {
          event: 'onboard.executed',
          condition: 'conditional',
          description: 'On a non-dry-run that applies the plan',
          role: 'primary',
          owner: 'orchestrate',
        },
      ),
    },
  ),
];
