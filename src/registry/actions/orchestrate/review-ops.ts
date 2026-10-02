import { coercedIntArray } from '../../../coerce.js';
import { vacuityWaiver, withCappedShape } from '../../../output-schema-declaration.js';
import { CheckInvariantConformanceOutputSchema } from '../../../verbs/gates/check-invariant-conformance-schema.js';
import { z } from 'zod';
import { declared, none, withActionContract } from '../../action-contract.js';
import { LOCAL_MUTATION, READ_ONLY_LOCAL, READ_ONLY_REMOTE } from '../../annotations.js';
import { ALL_PHASES, PREPARE_REVIEW_PHASES, REVIEW_PHASES, ROLE_ANY, ROLE_LEAD, featureIdSchema } from '../../phases.js';
import type { BuiltinActionDraft, BuiltinToolAction } from '../../types.js';

function contracted(action: BuiltinActionDraft, contract: unknown): BuiltinToolAction {
  return withActionContract(action, contract, { annotations: action.annotations });
}

export const reviewOpsActions: readonly BuiltinToolAction[] = [
  contracted(
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
      requires: none('reconcile_state compares local files against git without an admission obligation'),
      ensures: none('reconcile_state reports drift; it does not append a catalog event'),
      needs: declared('fs:read', 'fs:write'),
      touches: {
        frame: 'single-machine',
        resources: declared(
          { kind: 'path', selector: 'repoRoot' },
          { kind: 'git-ref', selector: 'HEAD' },
        ),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: none('reconcile_state emits no catalog events'),
    },
  ),
  contracted(
    {
      name: 'pre_synthesis_check',
      description: 'Run pre-synthesis checks: task completion, reviews, tests, and stack health',
      schema: z.object({
        /**
         * Required, because the gate declares durable evidence and the observer reads it on the named stream.
         * A call with only `stateFile` has no stream for that record.
         */
        featureId: z.string().min(1),
        /** An optional override. Without it, the gate builds state from the event store through `featureId`. */
        stateFile: z.string().min(1).optional(),
        repoRoot: z.string().optional(),
        skipTests: z.boolean().optional(),
        skipStack: z.boolean().optional(),
        testCommand: z.string().optional(),
      }),
      phases: new Set<string>(['synthesize']),
      roles: ROLE_LEAD,
      gate: { blocking: true, gateClass: 'pre-synthesis' },
      /** It runs the test suite, typecheck, build, and stack assessment, which can take minutes. */
      longRunning: true,
      outputSchema: vacuityWaiver('exarchos_orchestrate.pre_synthesis_check'),
      annotations: LOCAL_MUTATION,
    },
    {
      requires: declared(
        { family: 'synthesis', gate: 'task-completion' },
        { family: 'synthesis', gate: 'tests' },
        { family: 'synthesis', gate: 'typecheck' },
        { family: 'synthesis', gate: 'document' },
        { family: 'synthesis', gate: 'stack' },
      ),
      ensures: declared(
        { source: 'event-append', when: 'always', event: 'gate.executed' },
        { source: 'durable-evidence', when: 'success', evidenceType: 'gate' },
      ),
      needs: declared('fs:read', 'shell:exec'),
      touches: {
        frame: 'single-machine',
        resources: declared(
          { kind: 'path', selector: 'repoRoot' },
          { kind: 'stream', selector: 'featureId' },
        ),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared({
        event: 'gate.executed',
        condition: 'always',
        role: 'primary',
        owner: 'orchestrate',
      }),
    },
  ),
  contracted(
    {
      name: 'check_coderabbit',
      description: 'Query CodeRabbit review state on GitHub PRs — APPROVED/NONE → pass, else fail',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        /** The same coerced integer array as `assess_stack`, so the registration flattener sees one contract. */
        prNumbers: coercedIntArray(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      outputSchema: vacuityWaiver('exarchos_orchestrate.check_coderabbit'),
      annotations: READ_ONLY_REMOTE,
    },
    {
      requires: none('check_coderabbit queries remote review state without an admission obligation'),
      ensures: none('check_coderabbit returns an ephemeral verdict with no durable postcondition'),
      needs: none('check_coderabbit reads GitHub through the host adapter'),
      touches: {
        frame: 'single-machine',
        resources: none('check_coderabbit does not touch local streams, paths, worktrees, or git refs'),
      },
      executionAuthority: { kind: 'host', obligation: 'interactive-authentication' },
      replay: { kind: 'safe-repeat' },
      emissions: none('check_coderabbit emits no catalog events'),
    },
  ),
  contracted(
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
      requires: none('check_polish_scope is a read-only diff measurement'),
      ensures: none('check_polish_scope returns an ephemeral scope verdict'),
      needs: declared('fs:read'),
      touches: {
        frame: 'single-machine',
        resources: declared(
          { kind: 'path', selector: 'repoRoot' },
          { kind: 'git-ref', selector: 'baseBranch' },
        ),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: none('check_polish_scope emits no catalog events'),
    },
  ),
  contracted(
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
      requires: none('needs_schema_sync is a read-only diff measurement'),
      ensures: none('needs_schema_sync returns an ephemeral sync verdict'),
      needs: declared('fs:read'),
      touches: {
        frame: 'single-machine',
        resources: declared(
          { kind: 'path', selector: 'repoRoot' },
          { kind: 'git-ref', selector: 'baseBranch' },
        ),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: none('needs_schema_sync emits no catalog events'),
    },
  ),
  contracted(
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
      requires: none('verify_doc_links is a read-only filesystem check'),
      ensures: none('verify_doc_links returns an ephemeral link verdict'),
      needs: declared('fs:read'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'path', selector: 'docsDir' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: none('verify_doc_links emits no catalog events'),
    },
  ),
  contracted(
    {
      name: 'verify_review_triage',
      description: 'Verify review triage routing — check review.routed events against state PRs',
      schema: z.object({
        /** The handler requires `featureId` or `stateFile`. */
        featureId: z.string().min(1).optional(),
        /**
         * An optional override for file-based workflows, like `eventStream`.
         * Without them, PRs come from the event-store projection and `review.routed` events come from the store.
         */
        stateFile: z.string().min(1).optional(),
        eventStream: z.string().min(1).optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      outputSchema: vacuityWaiver('exarchos_orchestrate.verify_review_triage'),
      annotations: READ_ONLY_LOCAL,
    },
    {
      requires: none('verify_review_triage reads already-routed review facts'),
      ensures: none('verify_review_triage returns an ephemeral routing verdict'),
      needs: none('verify_review_triage reads the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'featureId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: none('verify_review_triage emits no catalog events'),
    },
  ),
  contracted(
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
      /**
       * The gate blocks only on check-mode findings. A blocking-severity check violation folds to HIGH and `NEEDS_FIXES`.
       * Audit-mode entries go into the review subagent prompt, not into handler findings.
       * An advisory-severity check finding shows as MEDIUM and does not block.
       */
      gate: { blocking: true, gateClass: 'invariant-conformance' },
      /**
       * The schema requires `auditPrompt` and `auditInvariantIds`, because a consumer acts on the audit prompt.
       * `architecture/audit-delivery-closure.ts` fails if either field becomes optional.
       */
      outputSchema: withCappedShape(CheckInvariantConformanceOutputSchema),
      /**
       * The gate appends a gate event on each call, so it is not read-only.
       * A read-only annotation lets read-only clients write to the event store.
       * The `RegistryDrift_AutoEmitsImpliesNotReadOnly` test enforces this.
       */
      annotations: LOCAL_MUTATION,
    },
    {
      requires: declared({ family: 'review', gate: 'review' }),
      ensures: declared(
        { source: 'event-append', when: 'always', event: 'gate.executed' },
        { source: 'durable-evidence', when: 'success', evidenceType: 'gate' },
      ),
      needs: declared('fs:read'),
      touches: {
        frame: 'single-machine',
        resources: declared(
          { kind: 'path', selector: 'repoRoot' },
          { kind: 'stream', selector: 'featureId' },
        ),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared({
        event: 'gate.executed',
        condition: 'always',
        role: 'primary',
        owner: 'orchestrate',
      }),
    },
  ),
  contracted(
    {
      name: 'prepare_review',
      description: 'Prepare a review pass as structured data. Default scope serves the back-of-pipeline code-review check catalog. scope:"plan" serves the DR-10 front-of-pipeline plan-review provisioning — a dispatched, fresh-context, adversarial (refute-the-plan) read-only pass over the unified docs/specs/ artifact, provisioned with only {artifact, spec} (never the authoring transcript) and depth-scaled by the frozen designDepth.',
      schema: z.object({
        featureId: z.string().min(1),
        scope: z.string().optional(),
        dimensions: z.array(z.string()).optional(),
        repoRoot: z.string().optional(),
        /** For the plan scope: the artifact under review. `spec` is what it must satisfy, and `designDepth` scales the adversarial rung. */
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
      requires: none('prepare_review provisions the review packet; it does not admit a prior gate'),
      /**
       * The plan scope writes the dispatch record that the revision cap reads.
       * It is not an `ensures`, because the default scope succeeds and writes nothing.
       */
      ensures: none('the plan-review dispatch record is written only on the plan scope, which a postcondition observed on every success cannot express'),
      needs: declared('subagent:spawn'),
      touches: {
        frame: 'single-machine',
        resources: declared(
          { kind: 'path', selector: 'artifact' },
          { kind: 'stream', selector: 'featureId' },
        ),
      },
      executionAuthority: { kind: 'host', obligation: 'agent-spawn' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared({
        event: 'workflow.plan-review-dispatched',
        condition: 'conditional',
        owner: 'orchestrate',
        role: 'primary',
        description: 'One per plan-review dispatch; the default review scope appends nothing',
      }),
    },
  ),
  contracted(
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
      /** Only the `plan` phase. The full `PLAN_PHASES` set makes the action count as a canonical plan gate. */
      phases: new Set<string>(['plan']),
      roles: ROLE_LEAD,
      gate: { blocking: false },
      outputSchema: vacuityWaiver('exarchos_orchestrate.discover_bridge'),
      annotations: LOCAL_MUTATION,
    },
    {
      requires: declared({ kind: 'approvals', minimum: 1 }),
      ensures: declared({ source: 'event-append', when: 'success', event: 'state.patched' }),
      needs: none('discover_bridge records the confirmed link in-process'),
      touches: {
        frame: 'single-machine',
        resources: declared(
          { kind: 'path', selector: 'artifact' },
          { kind: 'stream', selector: 'featureId' },
        ),
      },
      executionAuthority: { kind: 'host', obligation: 'human-approval' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      /**
       * `wf update` is the canonical `state.patched` emitter, but this action appends its own row.
       * The recovery role and the expiry make the shortcut temporary.
       */
      emissions: declared({
        event: 'state.patched',
        condition: 'conditional',
        description: 'On confirm:true — records the discover-bridge link, stitched by correlationId',
        role: 'recovery',
        owner: 'orchestrate',
        recoveryExpiresAt: '2027-12-31T00:00:00.000Z',
      }),
    },
  ),
];
