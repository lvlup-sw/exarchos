import { vacuityWaiver } from '../../../output-schema-declaration.js';
import { z } from 'zod';
import { LOCAL_MUTATION } from '../../annotations.js';
import { ALL_PHASES, ROLE_ANY } from '../../phases.js';
import type { BuiltinToolAction } from '../../types.js';

export const onboardingActions: readonly BuiltinToolAction[] = [
  // ─── Onboard Action (DR-2/DR-5, task 011) ─────────────────────────────────
  {
    // DR-2: `onboard` is the consolidated first-run verb — it composes the
    // reconciler's detect→config→generate→install→verify pipeline (the
    // superset of the legacy `init` + `install-skills` writes) and drives the
    // repo to a green doctor. Registered as an ACTION on exarchos_orchestrate
    // (INV-5d — NOT a fifth visible tool; the visible-tool count stays 4).
    //
    // Flags auto-emit from this schema via `addFlagsFromSchema` in the CLI
    // adapter, so CLI/MCP arg parity is preserved by construction (INV-2) and
    // there is no hand-written flag table to drift. The schema MIRRORS
    // `HandleOnboardArgs` (verbs/onboard/index.ts) MINUS `surface`:
    // `surface` is adapter-injected (DR-6) — the MCP adapter supplies its
    // capability surface, the CLI passes `'cli'` — so it must NOT appear here
    // as a user-facing flag.
    name: 'onboard',
    description:
      'Onboard (or re-onboard) the current repo: detect runtimes + VCS, write/reconcile agent config, install skills, then verify against doctor — driving the repo to a green doctor. Idempotent; re-running reconciles drift only. Use --dry-run to preview the plan without writing, --new <name> to scaffold a fresh project first, --force to overwrite hand-edited config, and --no-hooks to skip the SessionStart binding. Do not use to re-run individual diagnostics — use doctor for that. Emits onboard.requested then onboard.executed (skipped under --dry-run).',
    schema: z.object({
      // DR-3 greenfield: scaffold `<name>` then run the identical pipeline.
      new: z.string().optional(),
      // Explicit agent-host runtime ids — bypasses probing. Array (one per
      // runtime); the CLI coerces csv/json into the array before parse.
      runtime: z.array(z.string()).optional(),
      // Explicit VCS id — bypasses `.git` probing.
      vcs: z.string().optional(),
      // Compute the plan but perform NO side effect and emit NO events.
      dryRun: z.boolean().optional(),
      // Overwrite hand-edited config (DR-10) — preserves it otherwise.
      force: z.boolean().optional(),
      // Skip the DR-8 SessionStart hook step (#1485).
      noHooks: z.boolean().optional(),
      // Output projection hint (the carrier is shape-stable across both).
      format: z.enum(['table', 'json']).optional(),
      // NOTE: `surface` is intentionally absent — it is adapter-injected (DR-6),
      // not a user flag. Adding it here would auto-emit a spurious `--surface`
      // CLI flag and let a caller spoof the capability gate.
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'onboard.requested', condition: 'always', role: 'primary', owner: 'orchestrate' },
      { event: 'onboard.executed', condition: 'conditional', description: 'On a non-dry-run that applies the plan', role: 'primary', owner: 'orchestrate' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.onboard'),
    annotations: LOCAL_MUTATION,
  },
  // ─── Init Action ──────────────────────────────────────────────────────────
  // init action removed in Task 011 (onboard swap); the init handler
  // (`handleInitWithWriters`), `init.executed` event, and `install-skills` verb
  // were fully removed in DR-5 (task 018). The `onboard` action above supersedes
  // init (design line 322: "init action → onboard action") — it reuses the same
  // writer list (`getAllWriters()`) via the reconciler's GENERATE step. Removing
  // the action also cleared the #1127 flattener collision between init's legacy
  // `runtime: string` and onboard's `runtime: string[]` in
  // `buildRegistrationSchema`. The `init`/`install-skills` CLI verbs are now
  // DR-5 rename stubs (adapters/cli.ts).
];
