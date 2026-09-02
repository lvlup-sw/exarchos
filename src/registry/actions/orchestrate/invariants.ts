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
  // ─── Invariant Authoring Actions (invariants-catalog-wizard, P2) ───────────
  withContract({
    // P2/T7: create a starter invariant catalog file for a tier and
    // idempotently register it in `.exarchos.yml`. INV-5d: this is an ACTION on
    // exarchos_orchestrate, NOT a fifth visible tool. Never overwrites an
    // existing file (mirrors seedExarchosConfig).
    name: 'invariants_scaffold',
    description:
      'Create a starter invariant catalog file for a tier (dev | user) and idempotently register it in .exarchos.yml. Emits no events; never overwrites an existing catalog file. Do not use when the catalog file already exists, or to add an entry to an existing catalog — use invariants_add for that. After scaffolding, run doctor and inspect the resolved catalog via the invariants_effective view.',
    schema: z.object({
      tier: z.enum(['dev', 'user']).optional(),
      path: z.string().optional(),
      repoRoot: z.string().optional(),
      // #1489: `dev`/`INV-N` is exarchos's reserved substrate namespace. Outside
      // the exarchos repo, tier:dev is rejected unless this override is set.
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
  withContract({
    // P2/T11: validate one entry against InvariantEntryV3Schema (incl. the
    // .strict() enforcement DSL) and append it to a registered catalog.
    // `dryRun` defaults true (INV-5c): the dry run returns the rendered entry +
    // a file diff and writes nothing. On commit it auto-assigns the next free
    // id in the target namespace and emits invariant.authored (+ catalog.registered
    // on first registration). INV-5d: ACTION, not a fifth visible tool.
    name: 'invariants_add',
    description:
      'Validate one invariant entry against the v3 schema (including the sandbox-safe .strict() enforcement DSL) and append it to a registered catalog. Defaults to dryRun:true — returns the rendered YAML entry + a file diff without writing; pass dryRun:false to commit (auto-assigns the next free id, emits invariant.authored). Do not use to create a new catalog file — use invariants_scaffold first. Do not embed script/exec/code in enforcement; the DSL is declarative-only and rejects executable escape hatches. After committing, run doctor and inspect the result via the invariants_effective view.',
    schema: z.object({
      entry: z.record(z.string(), z.unknown()),
      catalog: z.string().optional(),
      tier: z.enum(['dev', 'user']).optional(),
      id: z.string().optional(),
      // INV-5c: this mutating verb defaults to dry-run. The default lives in
      // the handler/dispatch boundary (composite.ts: `dryRun === undefined ?
      // true`) rather than as a Zod `.default(true)` here, because the
      // MCP-registration flattener (`buildRegistrationSchema`) forbids two
      // actions declaring the same field with divergent defaults — and
      // `merge_orchestrate` / `prune_stale_workflows` already declare
      // `dryRun` as `.optional()` with no default. Keeping the field
      // `.optional()` here aligns the registration contract; the safe
      // dry-run default is enforced where the value is actually consumed.
      dryRun: z.boolean().optional(),
      repoRoot: z.string().optional(),
      // #1489: `dev`/`INV-N` is exarchos's reserved substrate namespace. Outside
      // the exarchos repo, tier:dev is rejected unless this override is set.
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
  withContract({
    // Task 068 / DR-23: the catalog had no sanctioned amend path. `invariants_add`
    // is append-only and the `/exarchos:invariants` skill forbids hand-writing
    // catalog YAML, so entries were effectively IMMUTABLE once committed —
    // every correction to a shipped invariant was unreachable.
    //
    // This verb is id-targeted and field-scoped: `id` names an existing entry
    // (identity is NOT patchable), `patch` names the top-level fields to
    // replace, and every field the patch omits survives verbatim. Amending is
    // not re-scaffolding. `dryRun` defaults true (INV-5c); a commit emits
    // `invariant.amended`. INV-5d: ACTION, not a fifth visible tool.
    //
    // Field-name contract (`buildRegistrationSchema`): `id` / `catalog` /
    // `tier` / `dryRun` / `repoRoot` / `allowReservedTier` reuse the exact base
    // types `invariants_add` already declares. The patch field is named `patch`
    // rather than the more obvious `fields` BECAUSE `fields` is already
    // declared on this tool as `coercedStringArray()` (an array) — a record
    // there would be a base-type collision and would throw at registration.
    name: 'invariants_amend',
    description:
      "Amend one EXISTING invariant entry in a registered catalog, in place. `id` names the entry to correct and is not itself patchable; `patch` names the top-level fields to replace, and any field the patch omits is carried through unchanged. The merged entry is re-validated against the full v3 schema (including the sandbox-safe .strict() enforcement DSL). Defaults to dryRun:true — returns the amended YAML entry + a before/after diff without writing; pass dryRun:false to commit (emits invariant.amended). Use this, NOT invariants_add, to correct a shipped invariant: invariants_add only appends, and re-using an existing id there is rejected. Do not hand-edit catalog YAML. After committing, run doctor and inspect the result via the invariants_effective view.",
    schema: z.object({
      id: z.string(),
      patch: z.record(z.string(), z.unknown()),
      catalog: z.string().optional(),
      tier: z.enum(['dev', 'user']).optional(),
      // INV-5c: dry-run default lives at the handler/dispatch boundary, not as
      // a Zod `.default(true)` — see the note on `invariants_add.dryRun`.
      dryRun: z.boolean().optional(),
      repoRoot: z.string().optional(),
      allowReservedTier: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    // DR-4: declared SUBSTANTIVELY via the sole substantive constructor. A new
    // action has no seeded `vacuityWaiver` entry, and the waiver allowlist is
    // shrink-only — acquiring one would be a ratchet violation, so the shape is
    // stated instead. (`vacuityWaiver`'s `id` is typed as the literal union of
    // seeded ids, so this is enforced at compile time, not by convention.)
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
