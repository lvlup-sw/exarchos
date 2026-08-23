import { coercedNonnegativeInt, coercedPositiveInt } from '../../../coerce.js';
import { vacuityWaiver, withCappedShape } from '../../../output-schema-declaration.js';
import { z } from 'zod';
import { LOCAL_MUTATION } from '../../annotations.js';
import { DELEGATE_PHASES, PLAN_PHASES, REVIEW_PHASES, ROLE_LEAD, STACK_PHASES } from '../../phases.js';
import type { BuiltinToolAction } from '../../types.js';
import { DiffHygieneOutputSchema } from '../../../verbs/gates/diff-hygiene.js';

export const gateActions: readonly BuiltinToolAction[] = [
  {
    name: 'check_static_analysis',
    description: 'Run static analysis gate (lint + typecheck) and persist canonical subject-bound evidence.',
    schema: z.object({
      featureId: z.string().min(1),
      taskId: z.string().optional(),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoRoot: z.string().optional(),
      // #1330: the handler threads worktreePath into resolveRepoRoot so
      // `repoRoot: 'auto'` resolves the agent's worktree. The field must be
      // declared here or action-level schema parsing drops it before the
      // handler sees it (the task-completion runbook passes it as a template var).
      worktreePath: z.string().optional(),
      skipLint: z.boolean().optional(),
      skipTypecheck: z.boolean().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D2', gateClass: 'static-analysis' },
    // DR-5: shells out to `npm run lint` and `npm run typecheck`; on
    // non-trivial repos both exceed the 2s heartbeat threshold.
    longRunning: true,
    // T-01/T-02: routed through `runDurableGateProducer` → `runGate`, the
    // single authoritative producer of `gate.executed` (minted from the SAME
    // persisted `admission.evidence-recorded` record). Both rows are genuinely
    // emitted on every call — declaring only the evidence row here understated
    // the contract `task_complete`'s `hasPassingGate('static-analysis')` reads.
    autoEmits: [
      { event: 'admission.evidence-recorded', condition: 'always', role: 'primary', owner: 'orchestrate' },
      { event: 'gate.executed', condition: 'always', role: 'primary', owner: 'orchestrate' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_static_analysis'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_integration_suite',
    description:
      'Run the FULL test suite against the integration tip and fold file-LOAD ' +
      'failures into the failure count (#1329). vitest counts a file that throws ' +
      'at import as "1 failed suite / 0 failed tests" — invisible to per-task ' +
      'gates; this gate makes a load cascade a hard FAIL. Set repoRoot to the ' +
      'integration worktree (or "auto" to resolve the calling delegation\'s ' +
      'worktree). Persists canonical subject-bound evidence. Do NOT use for a single task\'s scoped tests — use ' +
      'check_static_analysis / check_test_adequacy for per-task verification; ' +
      'this gate is the cumulative-regression backstop between merges.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      worktreePath: z.string().optional(),
      taskId: z.string().optional(),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      testScript: z.string().optional(),
    }),
    phases: STACK_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D2', gateClass: 'integration-suite' },
    // Shells out to `npm run test:run -- --reporter=json` over the entire
    // suite; on a real repo this far exceeds the 2s heartbeat threshold.
    longRunning: true,
    // T-01/T-02: routed through `runDurableGateProducer` → `runGate`, which
    // mints `gate.executed` from the same persisted evidence record it just
    // wrote — both rows are genuinely emitted on every call.
    autoEmits: [
      { event: 'admission.evidence-recorded', condition: 'always', role: 'primary', owner: 'orchestrate' },
      { event: 'gate.executed', condition: 'always', role: 'primary', owner: 'orchestrate' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_integration_suite'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_security_scan',
    description: 'Run security pattern scan on diff. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      diffContent: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D1' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always', role: 'primary', owner: 'orchestrate' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_security_scan'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_diff_hygiene',
    description:
      'Scan the branch diff for quality-hygiene findings under one rule pack: context economy ' +
      '(D3 — source-file length, diff breadth, generated bulk), operational resilience ' +
      '(D4 — empty catches, swallowed errors, console.log, unbounded retry loops) and workflow ' +
      'determinism (D5 — .only/.skip, unmocked time and randomness, debug artifacts in tests). ' +
      'Replaces check_context_economy, check_operational_resilience and check_workflow_determinism. ' +
      'Each rule keeps its own gate.executed row under its own gate name and dimension, so ' +
      '`.exarchos.yml` per-gate and per-dimension severity keys resolve unchanged. An undetectable ' +
      'base branch yields an inconclusive carrier that records its verdict, never a silent pass.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    // The pack spans D3-D5 and each rule's own dimension travels on its durable
    // row; this action-level field is the coarse handle. D3 is the one no other
    // action declares, so naming it here keeps `review.dimensions.D3` addressing
    // something (D4 is also declared by check_post_merge, D5 by
    // check_task_decomposition).
    gate: { blocking: false, dimension: 'D3' },
    // One declaration, three rows per call — one per rule, the same shape the
    // three retired actions produced. check_review_verdict is the existing
    // precedent for a single declaration backing several rows.
    autoEmits: [
      { event: 'gate.executed', condition: 'always', role: 'primary', owner: 'orchestrate' },
    ],
    outputSchema: withCappedShape(DiffHygieneOutputSchema),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_review_verdict',
    description: 'Compute review verdict from finding counts. Emits per-dimension and summary gate.executed events. On NEEDS_FIXES, bounds the fix-loop via the shared escalation policy (DR-3): returns escalate:true when the auto-fix bound is hit or a finding is intent-touching.',
    schema: z.object({
      featureId: z.string().min(1),
      high: coercedNonnegativeInt(),
      medium: coercedNonnegativeInt(),
      low: coercedNonnegativeInt(),
      blockedReason: z.string().optional(),
      dimensionResults: z.record(z.string(), z.object({
        passed: z.boolean(),
        findingCount: z.number().int().nonnegative(),
      })).optional(),
      pluginFindings: z.array(z.object({
        source: z.string(),
        severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
        dimension: z.string().optional(),
        file: z.string().optional(),
        line: z.number().int().positive().optional(),
        message: z.string(),
        // DR-3: intent-touching classification for the escalation policy. A
        // spec-category (or explicitly-flagged) finding escalates immediately.
        category: z.string().optional(),
        intentTouching: z.boolean().optional(),
      })).optional(),
      // DR-3: per-loop override of the auto-fix bound (highest precedence over
      // config `escalation.maxIterations` and the built-in default of 5).
      maxFixCycles: coercedPositiveInt().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, gateClass: 'review-verdict' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always', role: 'primary', owner: 'orchestrate' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_review_verdict'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_provenance_chain',
    description: 'Verify design requirement traceability (DR-N) from design doc to plan tasks. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      designPath: z.string().min(1),
      planPath: z.string().min(1),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1', gateClass: 'provenance-chain' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always', role: 'primary', owner: 'orchestrate' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_provenance_chain'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_plan_coverage',
    description: 'Verify plan tasks cover all design sections. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      designPath: z.string().min(1),
      planPath: z.string().min(1),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1', gateClass: 'plan-coverage' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always', role: 'primary', owner: 'orchestrate' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_plan_coverage'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_exploration_depth',
    description:
      'Deep-depth planning gate (DR-4): verifies a `deep`-designDepth spec carries ' +
      'the template-required `### Exploration` section citing the /exarchos:discover ' +
      'research pass by report path + correlationId, failing when the section is ' +
      'absent (or present but not citing the pass). SELF-SKIPS at thin/standard ' +
      'depth — the Exploration citation is a deep-only obligation. Resolves ' +
      'designDepth + the unified docs/specs/ artifact path from explicit args, then ' +
      'from workflow state. Emits a gate.executed event (gate "exploration-depth", ' +
      'layer planning, dimension D1) on every path, including the skip.',
    schema: z.object({
      featureId: z.string().min(1),
      // The unified docs/specs/ artifact. Optional — resolved from workflow-state
      // artifacts (plan preferred, then design) when absent.
      designPath: z.string().optional(),
      // Frozen per-feature designDepth stamp. Optional — resolved from
      // state.designDepth when absent; non-`deep` self-skips.
      designDepth: z.enum(['thin', 'standard', 'deep']).optional(),
      stateFile: z.string().optional(),
    }),
    // Callable in the plan phase, but deliberately NOT the full PLAN_PHASES set:
    // that set is the canonical plan-STRUCTURE binding pinned to the `standard`
    // rung (`setEqualsNames(a.phases, PLAN_PHASE_NAMES)` in phase-kind.test.ts).
    // check_exploration_depth is the DEEP-ONLY obligation the plan-structure
    // resolver appends at `deep` depth — it must stay OUT of the standard-rung
    // binding, so it uses the subset idiom (cf. the check_design_completeness alias).
    phases: new Set<string>(['plan']),
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always', role: 'primary', owner: 'orchestrate' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_exploration_depth'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_test_adequacy',
    description:
      'Per-task test-adequacy kill probe (mutation-testing-at-N=1): reverts the ' +
      "task's source hunks (keeping tests), re-runs the new/changed tests, and " +
      'asserts at least one goes red — proving the tests are not vacuous. ' +
      'Restores the working tree unconditionally (INV-14) and persists canonical ' +
      'subject-bound evidence. Pass repoRoot ("auto" to resolve the calling ' +
      "delegation's worktree). Stamp riskTier + boundaryTouching (from " +
      'prepare_delegation) to let the gate self-skip when the verification ' +
      'policy excludes it for that tier (skipped-by-policy). This is the sole ' +
      'per-task verification gate: it subsumes the regression-coverage intent of ' +
      'the retired check_tdd_compliance (#1587) — outcome-based test adequacy, ' +
      'test-after, NOT commit-order test-first.',
    schema: z.object({
      featureId: z.string().min(1),
      taskId: z.string().min(1),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoRoot: z.string().optional(),
      worktreePath: z.string().optional(),
      operationId: z.string().optional(),
      // Legacy phase carrier retained for compatibility. Durable evidence uses
      // the active persisted phaseAttemptId, never caller-supplied provenance.
      phase: z.string().optional(),
      riskTier: z.enum(['low', 'medium', 'high']).optional(),
      boundaryTouching: z.boolean().optional(),
      // .strict() so the dispatch layer rejects unknown keys (e.g. `base`
      // instead of `baseBranch`) rather than silently defaulting — the #1188
      // protection, inherited from the retired check_tdd_compliance (#1587).
      // Tolerant dispatch strips leaked sibling-action defaults BEFORE this
      // per-action validation, so strict never false-rejects a real dispatch.
    }).strict(),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1', gateClass: 'test-adequacy' },
    // Reverts source + shells out to the resolved test command; on a real repo
    // this exceeds the 2s heartbeat threshold.
    longRunning: true,
    // T-01/T-02: routed through `runDurableGateProducer` → `runGate`, which
    // mints `gate.executed` from the same persisted evidence record it just
    // wrote — both rows are genuinely emitted on every call.
    autoEmits: [
      { event: 'admission.evidence-recorded', condition: 'always', role: 'primary', owner: 'orchestrate' },
      { event: 'gate.executed', condition: 'always', role: 'primary', owner: 'orchestrate' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_test_adequacy'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_contract_drift',
    description:
      'Per-task contract-drift gate (verification-ladder slice 1): regenerates ' +
      'schema bindings (codegen), typechecks the regen, then runs a ' +
      'breaking-change diff against the MERGE-BASE (git merge-base baseBranch ' +
      'HEAD). A drift gate, NOT a write-lock — reports findings, never mutates ' +
      'the tree. Persists canonical subject-bound evidence. Degrades to a ' +
      'skipped/advisory pass when no contract tool resolves ' +
      '(INV-4). Pass repoRoot ("auto" to resolve the calling delegation\'s ' +
      'worktree). On a ' +
      'clean pass, surfaces a one-semantic-test steer in next_actions.',
    // Field names + base types match check_test_adequacy exactly so the shared
    // registration schema (buildRegistrationSchema) never sees a same-name
    // field with a divergent base type.
    schema: z.object({
      featureId: z.string().min(1),
      taskId: z.string().min(1),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoRoot: z.string().optional(),
      worktreePath: z.string().optional(),
      operationId: z.string().optional(),
      riskTier: z.enum(['low', 'medium', 'high']).optional(),
      boundaryTouching: z.boolean().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1', gateClass: 'contract-drift' },
    // Shells out to codegen/typecheck/breaking-diff against a real repo; on a
    // real project this exceeds the 2s heartbeat threshold.
    longRunning: true,
    // T-01/T-02: routed through `runDurableGateProducer` → `runGate`, which
    // mints `gate.executed` from the same persisted evidence record it just
    // wrote — both rows are genuinely emitted on every call.
    autoEmits: [
      { event: 'admission.evidence-recorded', condition: 'always', role: 'primary', owner: 'orchestrate' },
      { event: 'gate.executed', condition: 'always', role: 'primary', owner: 'orchestrate' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_contract_drift'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_mock_boundary',
    description:
      'Per-task mock-boundary gate (verification-ladder slice 1, SIV-4): scans ' +
      "the task's NEW test hunks for mock sites (mock/stub/spy/fake/patch/" +
      'monkeypatch at an identifier boundary) and cross-references each mocked ' +
      'target against the resolved `ownership.firstParty` scope. Mocking a ' +
      'FIRST-PARTY module is low-risk (its contract is visible); mocking an ' +
      'UNOWNED dependency asserts against a fiction — the high-risk pattern. ' +
      'ADVISORY by default (severity resolved via DEFAULTS.review.gates, like ' +
      'tdd-compliance; a project review-gate override still wins). On an unowned ' +
      'finding, surfaces a per-finding steer in next_actions (replace with a ' +
      'hermetic fixture / contract-verified stub / a fake). An explicit `reason` ' +
      'is an escape hatch that passes the gate advisory AND records the ' +
      'acknowledgement in durable evidence. Pass repoRoot ("auto" to resolve ' +
      "the calling delegation's worktree).",
    // Field names + base types match check_test_adequacy / check_contract_drift
    // exactly so the shared registration schema (buildRegistrationSchema) never
    // sees a same-name field with a divergent base type. `reason` reuses the
    // existing optional-string contract (request_synthesize.reason).
    schema: z.object({
      featureId: z.string().min(1),
      taskId: z.string().min(1),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoRoot: z.string().optional(),
      worktreePath: z.string().optional(),
      operationId: z.string().optional(),
      reason: z.string().optional(),
      riskTier: z.enum(['low', 'medium', 'high']).optional(),
      boundaryTouching: z.boolean().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    // Advisory by default — the runtime severity demotion lives in
    // DEFAULTS.review.gates['mock-boundary'] (resolved per-call via
    // resolveGateSeverity). The registry flag mirrors that default so the
    // RunbookDrift blocking-gate coverage check treats it as advisory.
    gate: { blocking: false, dimension: 'D1', gateClass: 'mock-boundary' },
    // T-01/T-02: routed through `runDurableGateProducer` → `runGate`, which
    // mints `gate.executed` from the same persisted evidence record it just
    // wrote — both rows are genuinely emitted on every call.
    autoEmits: [
      { event: 'admission.evidence-recorded', condition: 'always', role: 'primary', owner: 'orchestrate' },
      { event: 'gate.executed', condition: 'always', role: 'primary', owner: 'orchestrate' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_mock_boundary'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'mutation-adequacy',
    description:
      'Verification-ladder slice 3 (R5): the mutation-adequacy backstop for the ' +
      'relaxed verification mix. Runs the resolved mutation command DIFF-SCOPED ' +
      'against `base` (Stryker --since / cargo-mutants --in-diff / mutmut path ' +
      'restriction, resolved from the toolchains SoT), parses the Stryker ' +
      'mutation-testing-report-schema, and returns the fixed carrier ' +
      '{passed, mutationScore, killed, survived, noCoverage, total, report}. ' +
      'Surviving + NoCoverage mutants become next_actions ("write a test that ' +
      'kills <file>:<line>"). ADVISORY by default (severity resolved via ' +
      "DEFAULTS.review.gates['mutation-adequacy']; an explicit override can raise " +
      'it to blocking). An unresolved mutation command → Skipped (reason names ' +
      'remediation); a malformed/empty report → Warning (degrade, never throws). ' +
      "scope:'full' runs full-tree only with offline:true (nightly lane); else a " +
      'deferred advisory (no inline run). Emits mutation.executing_started/executed (INV-10) and a foldable ' +
      'gate.executed carrying mutationScore (INV-1); operationId makes the gate ' +
      'emission idempotent (INV-8). Reuse `base` as a string verbatim.',
    // `base` reuses the existing string field contract (request_synthesize.base /
    // assess_stack.base); `scope`/`worktreePath`/`operationId`/`threshold` match
    // their existing declarations' base types so buildRegistrationSchema never
    // sees a same-name field with a divergent contract (field-collision trap).
    // `scope` is a plain string here (matching prepare_review.scope) and is
    // validated to 'diff'|'full' by the handler — declaring it as an enum would
    // collide with prepare_review's z.string().
    schema: z.object({
      featureId: z.string().min(1),
      base: z.string().min(1),
      // `taskId` lets `repoRoot:'auto'` resolve via the task's worktree.created
      // event (the check_test_adequacy contract). Optional here (the review-gate
      // path often passes an explicit repoRoot/worktreePath); matches the
      // existing `taskId: z.string().optional()` declarations so
      // buildRegistrationSchema sees no divergent same-name contract.
      taskId: z.string().optional(),
      worktreePath: z.string().optional(),
      operationId: z.string().optional(),
      threshold: z.number().min(0).max(1).optional(),
      scope: z.string().optional(),
      // DR-6: explicit offline/opt-in for a full-tree run. Inline `/review` never
      // sets it, so `scope:'full'` stays deferred on the inline path.
      offline: z.boolean().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    // Advisory by default — the runtime severity demotion lives in
    // DEFAULTS.review.gates['mutation-adequacy'] (resolved per-call via
    // resolveGateSeverity); the registry flag mirrors that default.
    gate: { blocking: false, dimension: 'mutation-adequacy' },
    // Shells out to a real mutation runner; on a real repo this exceeds the 2s
    // heartbeat threshold.
    longRunning: true,
    autoEmits: [
      { event: 'mutation.executing_started', condition: 'always', role: 'primary', owner: 'orchestrate' },
      { event: 'mutation.executed', condition: 'always', role: 'primary', owner: 'orchestrate' },
      { event: 'gate.executed', condition: 'always', role: 'primary', owner: 'orchestrate' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.mutation-adequacy'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_post_merge',
    description: 'Post-merge regression check. Emits gate.executed event with dimension D4.',
    schema: z.object({
      featureId: z.string().min(1),
      prUrl: z.string().min(1),
      mergeSha: z.string().min(1),
      // The repository the check is about — both where the test command is
      // resolved and where it runs. The handler and the pure check already
      // thread it; undeclared, action-level schema parsing strips it before
      // the handler sees it and the gate measures the server process's own
      // tree instead of the one that was just merged.
      repoRoot: z.string().min(1).optional(),
    }),
    phases: new Set<string>(['synthesize']),
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D4' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always', role: 'primary', owner: 'orchestrate' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_post_merge'),
    annotations: LOCAL_MUTATION,
  },
];
