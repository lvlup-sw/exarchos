import { coercedIntArray } from '../../../coerce.js';
import { vacuityWaiver, withCappedShape } from '../../../output-schema-declaration.js';
import { CheckInvariantConformanceOutputSchema } from '../../../verbs/gates/check-invariant-conformance-schema.js';
import { z } from 'zod';
import { LOCAL_MUTATION, READ_ONLY_LOCAL, READ_ONLY_REMOTE } from '../../annotations.js';
import { ALL_PHASES, PREPARE_REVIEW_PHASES, REVIEW_PHASES, ROLE_ANY, ROLE_LEAD, featureIdSchema } from '../../phases.js';
import type { BuiltinToolAction } from '../../types.js';

export const reviewOpsActions: readonly BuiltinToolAction[] = [
  {
    name: 'reconcile_state',
    description: 'Reconcile workflow state file against git and filesystem reality',
    schema: z.object({
      stateFile: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
      repoRoot: z.string().min(1),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.reconcile_state'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'pre_synthesis_check',
    description: 'Run pre-synthesis checks: task completion, reviews, tests, and stack health',
    schema: z.object({
      // featureId OR stateFile — the handler enforces "at least one source".
      featureId: z.string().min(1).optional(),
      // INV-1: the event store is the sole source of truth. `stateFile` is an
      // optional override; when omitted the gate materializes state from the
      // event store via `featureId` (MCP-only workflows have no `.state.json`).
      stateFile: z.string().min(1).optional(),
      repoRoot: z.string().optional(),
      skipTests: z.boolean().optional(),
      skipStack: z.boolean().optional(),
      testCommand: z.string().optional(),
    }),
    phases: new Set<string>(['synthesize']),
    roles: ROLE_LEAD,
    gate: { blocking: true },
    // DR-5: runs the full project test suite + typecheck + build + stack
    // assessment; routinely seconds-to-minutes on real repos.
    longRunning: true,
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.pre_synthesis_check'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_coderabbit',
    description: 'Query CodeRabbit review state on GitHub PRs — APPROVED/NONE → pass, else fail',
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      // DR-3/Task 010 — same coerced int-array param as assess_stack's
      // prNumbers so the shared registration flattener sees one contract.
      prNumbers: coercedIntArray(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_coderabbit'),
    annotations: READ_ONLY_REMOTE,
  },
  {
    name: 'check_polish_scope',
    description: 'Check if polish refactor scope has expanded beyond limits (>5 files, >2 modules)',
    schema: z.object({
      repoRoot: z.string(),
      baseBranch: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_polish_scope'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'needs_schema_sync',
    description: 'Detect API file modifications (Endpoints.cs, Models/, Requests/, etc.) requiring schema sync',
    schema: z.object({
      repoRoot: z.string(),
      baseBranch: z.string().optional(),
      diffFile: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.needs_schema_sync'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'verify_doc_links',
    description: 'Check that internal markdown links resolve to existing files',
    schema: z.object({
      docFile: z.string().optional(),
      docsDir: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.verify_doc_links'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'verify_review_triage',
    description: 'Verify review triage routing — check review.routed events against state PRs',
    schema: z.object({
      // featureId OR stateFile — the handler enforces "at least one source".
      featureId: z.string().min(1).optional(),
      // INV-1: PRs resolve from the event-store projection; `review.routed`
      // events are queried directly from the store. Both file inputs are
      // OPTIONAL overrides for legacy file-based workflows.
      stateFile: z.string().min(1).optional(),
      eventStream: z.string().min(1).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.verify_review_triage'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'check_invariant_conformance',
    description: 'Evaluate invariant conformance as a review dimension (DR-3/DR-4). Projects the effective invariant catalog for (workflow-type, review, touched-files), evaluates check-mode combinator trees against the diff, renders audit-mode prompts for the review subagent, and folds findings into the review verdict by context-resolved severity. Emits gate.executed; read-only otherwise.',
    schema: z.object({
      featureId: z.string().min(1),
      workflowType: z.string().optional(),
      phase: z.string().optional(),
      touchedFiles: z.array(z.string()).optional(),
      diff: z.string().optional(),
      diffContent: z.string().optional(),
      repoRoot: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    // DR-15 / task 027: this gate BLOCKS on check-mode findings only. Raising
    // INV-13/14/16 to `mode:check` (alongside INV-4) gave the gate deterministic
    // mechanical findings; a blocking-severity check violation (INV-4/14/16)
    // folds to a HIGH → NEEDS_FIXES. The scope to check-mode is STRUCTURAL, not
    // a flag knob: the 11 audit-mode entries render into the review subagent's
    // PROMPT (never a programmatic finding in this handler), and an
    // advisory-severity check finding (INV-13) surfaces as MEDIUM without
    // gating — so declaring `blocking:true` cannot red CI on the unproven
    // audit-mode rules.
    gate: { blocking: true },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    // DR-4 / task 069: PAID DOWN. This gate governs conformance to the catalog
    // that contains the anti-vacuity invariant, and it used to advertise
    // `EnvelopeSchema(z.unknown())` — total over every payload shape, including
    // the wrong ones. `auditPrompt` is the one field the audit-mode path exists
    // to deliver, so a consumer instructed to act on it needs the contract to
    // guarantee its presence and its name; `auditInvariantIds` is its enumerable
    // checklist. Both are declared REQUIRED, and
    // `architecture/audit-delivery-closure.ts` reddens if either stops being so.
    // Its allowlist entry MOVED to `VACUITY_RETIRED` — a shrink, which leaves the
    // pinned seed digest unchanged.
    outputSchema: withCappedShape(CheckInvariantConformanceOutputSchema),
    // The gate reads the catalog and computes a verdict, but `emitGateEvent`s
    // on every call — so it is NOT readOnly. Annotating it read-only would let
    // readonly-capability clients mutate the event store. LOCAL_MUTATION
    // matches the actual write surface and the rest of the check_* family that
    // auto-emits gate.executed (see check_convergence / check_review_verdict);
    // the `RegistryDrift_AutoEmitsImpliesNotReadOnly` invariant enforces this.
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'prepare_review',
    description: 'Prepare a review pass as structured data. Default scope serves the back-of-pipeline code-review check catalog. scope:"plan" serves the DR-10 front-of-pipeline plan-review provisioning — a dispatched, fresh-context, adversarial (refute-the-plan) read-only pass over the unified docs/specs/ artifact, provisioned with only {artifact, spec} (never the authoring transcript) and depth-scaled by the frozen designDepth.',
    schema: z.object({
      featureId: z.string().min(1),
      scope: z.string().optional(),
      dimensions: z.array(z.string()).optional(),
      repoRoot: z.string().optional(),
      // DR-10 (plan-review scope) — the unified artifact under review, the
      // spec it must satisfy, and the frozen planning depth (scales the
      // adversarial rung; the second consumer of designDepth).
      artifact: z.string().optional(),
      spec: z.string().optional(),
      designDepth: z.enum(['thin', 'standard', 'deep']).optional(),
    }),
    phases: PREPARE_REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false },
    outputSchema: vacuityWaiver('exarchos_orchestrate.prepare_review'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'discover_bridge',
    description: 'Opt-in deep-rung escalation (DR-7): bridge the unified spec to a /exarchos:discover research pre-pass, stitched by a deterministic correlationId. Requires author confirmation (confirm:true) — never auto-spawns. On confirmation it records the link as a state.patched event on the feature stream (report path + discover stream id + correlationId) so provenance spans both documents.',
    schema: z.object({
      featureId: featureIdSchema,
      artifact: z.string().min(1),
      confirm: z.boolean().optional(),
      reportPath: z.string().optional(),
      discoverFeatureId: z.string().optional(),
      correlationId: z.string().optional(),
    }),
    // The deep-rung authoring affordance fires during PLAN authoring. A single
    // 'plan' phase — deliberately NOT the full PLAN_PHASES set (the task-013
    // canonical-plan-gate binding trap).
    phases: new Set<string>(['plan']),
    roles: ROLE_LEAD,
    gate: { blocking: false },
    autoEmits: [
      { event: 'state.patched', condition: 'conditional', description: 'On confirm:true — records the discover-bridge link, stitched by correlationId' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.discover_bridge'),
    annotations: LOCAL_MUTATION,
  },
];
