import { vacuityWaiver, withCappedShape } from '../../../output-schema-declaration.js';
import { AmendInvariantOutputSchema } from '../../../verbs/invariants/amend.js';
import { z } from 'zod';
import { declared, none, withActionContract, type ActionContract } from '../../action-contract.js';
import { LOCAL_MUTATION } from '../../annotations.js';
import { ALL_PHASES, ROLE_ANY } from '../../phases.js';
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

export const invariantActions: readonly BuiltinToolAction[] = [
  /**
   * Creates a starter invariant catalog file for a tier and registers it in `.exarchos.yml`. It is an
   * action on `exarchos_orchestrate`, not a separate visible tool. It does not overwrite a file.
   */
  withContract({
    name: 'invariants_scaffold',
    description:
      'Create a starter invariant catalog file for a tier (dev | user) and idempotently register it in .exarchos.yml. Emits no events; never overwrites an existing catalog file. Do not use when the catalog file already exists, or to add an entry to an existing catalog — use invariants_add for that. After scaffolding, run doctor and inspect the resolved catalog via the invariants_effective view.',
    schema: z.object({
      tier: z.enum(['dev', 'user']).optional(),
      path: z.string().optional(),
      repoRoot: z.string().optional(),
      /**
       * The `dev` tier is the reserved Exarchos namespace. Outside the Exarchos repo, `tier: dev`
       * fails unless this flag is set.
       */
      allowReservedTier: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.invariants_scaffold'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: none('scaffolding writes a starter catalog file and registers its path; it appends no catalog events'),
    needs: declared('fs:write'),
    resources: declared({ kind: 'path', selector: 'path' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
  }),
  /**
   * Validates one entry against `InvariantEntryV3Schema`, with the strict enforcement DSL, and
   * appends it to a registered catalog. A dry run is the default: it returns the rendered entry and
   * a file diff, and writes nothing. A commit assigns the next free id in the namespace and emits
   * `invariant.authored`, plus `catalog.registered` on the first registration.
   */
  withContract({
    name: 'invariants_add',
    description:
      'Validate one invariant entry against the v3 schema (including the sandbox-safe .strict() enforcement DSL) and append it to a registered catalog. Defaults to dryRun:true — returns the rendered YAML entry + a file diff without writing; pass dryRun:false to commit (auto-assigns the next free id, emits invariant.authored). Do not use to create a new catalog file — use invariants_scaffold first. Do not embed script/exec/code in enforcement; the DSL is declarative-only and rejects executable escape hatches. After committing, run doctor and inspect the result via the invariants_effective view.',
    schema: z.object({
      entry: z.record(z.string(), z.unknown()),
      catalog: z.string().optional(),
      tier: z.enum(['dev', 'user']).optional(),
      id: z.string().optional(),
      /**
       * The handler applies the dry-run default, not a Zod `.default(true)`. `buildRegistrationSchema`
       * forbids two actions that declare one field with different defaults. Other actions on this
       * tool declare `dryRun` as optional with no default.
       */
      dryRun: z.boolean().optional(),
      repoRoot: z.string().optional(),
      /**
       * The `dev` tier is the reserved Exarchos namespace. Outside the Exarchos repo, `tier: dev`
       * fails unless this flag is set.
       */
      allowReservedTier: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.invariants_add'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'event-append', when: 'success', event: 'invariant.authored' },
      { source: 'event-append', when: 'success', event: 'catalog.registered' },
    ),
    needs: declared('fs:write', 'mcp:exarchos'),
    resources: declared({ kind: 'path', selector: 'catalog' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared(
      { event: 'catalog.registered', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'On first registration of the target catalog' },
      { event: 'invariant.authored', condition: 'conditional', owner: 'orchestrate', role: 'primary', description: 'On commit (dryRun:false)' },
    ),
  }),
  /**
   * Amends one existing catalog entry in place. `id` names the entry and is not patchable. `patch`
   * names the top-level fields to replace, and each omitted field stays as it is. A dry run is the
   * default, and a commit emits `invariant.amended`.
   *
   * The shared fields reuse the base types of `invariants_add`, as `buildRegistrationSchema`
   * requires. The field is `patch`, not `fields`, because this tool already declares `fields` as an
   * array. A record there collides and throws at registration.
   */
  withContract({
    name: 'invariants_amend',
    description:
      "Amend one EXISTING invariant entry in a registered catalog, in place. `id` names the entry to correct and is not itself patchable; `patch` names the top-level fields to replace, and any field the patch omits is carried through unchanged. The merged entry is re-validated against the full v3 schema (including the sandbox-safe .strict() enforcement DSL). Defaults to dryRun:true — returns the amended YAML entry + a before/after diff without writing; pass dryRun:false to commit (emits invariant.amended). Use this, NOT invariants_add, to correct a shipped invariant: invariants_add only appends, and re-using an existing id there is rejected. Do not hand-edit catalog YAML. After committing, run doctor and inspect the result via the invariants_effective view.",
    schema: z.object({
      id: z.string(),
      patch: z.record(z.string(), z.unknown()),
      catalog: z.string().optional(),
      tier: z.enum(['dev', 'user']).optional(),
      /** The handler applies the dry-run default, for the reason on `invariants_add.dryRun`. */
      dryRun: z.boolean().optional(),
      repoRoot: z.string().optional(),
      allowReservedTier: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    /**
     * A real output shape, because the waiver allowlist only shrinks. The `id` of `vacuityWaiver` is
     * a literal union of the seeded ids, so the compiler refuses a new waiver.
     */
    outputSchema: withCappedShape(AmendInvariantOutputSchema),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared({ source: 'event-append', when: 'success', event: 'invariant.amended' }),
    needs: declared('fs:write', 'mcp:exarchos'),
    resources: declared({ kind: 'path', selector: 'catalog' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({
      event: 'invariant.amended',
      condition: 'conditional',
      owner: 'orchestrate',
      role: 'primary',
      description: 'On commit (dryRun:false)',
    }),
  }),
];
