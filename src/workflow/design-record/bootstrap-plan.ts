/**
 * Plans the prefix of an empty workflow stream through its first task batch.
 * Each exit requires the checks frozen at its own source entry.
 * RESERVED(issue: #1927, owner: exarchos, expires: 2027-02-28)
 * The atomic prepare bootstrap handler will call this planner.
 */
import { buildValidatedEvent } from '../../events/event-factory.js';
import { recordedInitialPhaseOf } from '../../events/event-validation.js';
import { PhaseEnteredData, WorkflowEventBase, type WorkflowEvent } from '../../events/schemas.js';
import { foldGuardInput, type GuardInput } from '../../projections/guard-input/fold.js';
import type { EdgeConditionNode } from '../admission/edge-condition.js';
import { readFrozenGateSequence } from '../admission/freeze-requirements.js';
import { dangerBoundaryTouching, resolveDangerCoordinate } from '../admission/requirement-context.js';
import { PhaseAttemptIdSchema } from '../admission/types.js';
import { decide } from '../decide/decide.js';
import { compileDecideDefinition, type DecideDefinition, type DecideEdge, type DecideStep } from '../decide/edges.js';
import { phaseEntryOf, phaseMoveEvents } from '../decide/emit.js';
import { phaseRowsOf } from '../decide/rows.js';
import { isBuiltInDefinitionType } from '../definitions/built-in.js';
import type { ExarchosDefinition } from '../definitions/extension.js';
import { classifyStep } from '../definitions/step-locator.js';
import { allocatePhaseAttemptId } from '../phase-attempt-id.js';
import { KIND_OBLIGATIONS } from '../phase-kind.js';
import { resolvePlanDepthPolicy, type DesignDepth, type PlanDepthGateName } from '../plan-depth-policy.js';
import type { VerificationProfile } from '../verification/profile.js';
import {
  evaluatePlanCoverage,
  evaluatePlanDecomposition,
  evaluatePlanExploration,
  evaluatePlanProvenance,
  evaluatePlanTestPaths,
  evaluatePlanTraceability,
} from './plan-checks.js';
import type { DesignRecordSnapshot } from './schema.js';
import { validateDesignRecord, type PlanFinding } from './validate.js';

export interface BootstrapPlanInput {
  readonly workflowType: string;
  readonly definition: ExarchosDefinition;
  readonly snapshot: DesignRecordSnapshot;
  readonly approvedDigest: string;
  readonly designDepth: DesignDepth;
  readonly profile: VerificationProfile;
  readonly skipPhases: readonly string[];
  /** Start and compatibility patch from the validated intent, with provisional envelope values for the fold. */
  readonly seed: readonly [start: WorkflowEvent, patch: WorkflowEvent];
}

interface SourceDischarge {
  readonly phase: string;
  readonly phaseAttemptId: string;
  readonly gates: readonly PlanDepthGateName[];
}

type RefusalCode = 'BOOTSTRAP_UNSUPPORTED' | 'PHASE_NOT_PREPARABLE' | 'PLAN_UNSOUND' | 'DESIGN_APPROVAL_MISMATCH';

interface BootstrapRefusal {
  readonly ok: false;
  readonly code: RefusalCode;
  readonly message: string;
  readonly source?: Omit<SourceDischarge, 'gates'>;
  readonly gate?: string;
  readonly findings?: readonly PlanFinding[];
}

export type BootstrapPlanResult = BootstrapRefusal | {
  readonly ok: true;
  /** Complete planned rows with provisional sequence and timestamp values. */
  readonly rows: readonly WorkflowEvent[];
  readonly phase: string;
  readonly phaseAttemptId: string;
  readonly discharges: readonly SourceDischarge[];
  readonly effects: readonly 'log'[];
};

class BootstrapRefused extends Error {
  constructor(readonly refusal: BootstrapRefusal) {
    super(refusal.message);
  }
}

/** A refusal carries diagnostics and discards the local row buffer. */
function refuse(code: RefusalCode, message: string, detail?: Omit<BootstrapRefusal, 'ok' | 'code' | 'message'>): never {
  throw new BootstrapRefused({ ok: false, code, message, ...detail });
}

interface Boundary {
  readonly phase: string;
  readonly phaseAttemptId: string;
  readonly index: number;
  readonly from?: string;
}

interface GateResult {
  readonly passed: boolean;
  readonly reason?: string;
  readonly findings?: readonly PlanFinding[];
}

/** Each evaluator runs on the immutable design capture and resolved profile. */
const CHECKS: Readonly<Record<PlanDepthGateName, (input: BootstrapPlanInput) => GateResult>> = {
  check_task_decomposition: ({ snapshot }) => evaluatePlanDecomposition(snapshot),
  check_plan_coverage: ({ snapshot }) => evaluatePlanCoverage(snapshot),
  spec_coverage_check: ({ snapshot, profile }) => evaluatePlanTestPaths(snapshot, profile),
  check_provenance_chain: ({ snapshot }) => evaluatePlanProvenance(snapshot),
  generate_traceability: ({ snapshot }) => evaluatePlanTraceability(snapshot),
  check_exploration_depth: ({ snapshot }) => evaluatePlanExploration(snapshot),
};

/** The approval binds the exact typed capture before any phase is selected. */
function validateInputs(input: BootstrapPlanInput, def: DecideDefinition): Boundary {
  const { snapshot, approvedDigest, seed: [start, patch] } = input;
  if (approvedDigest !== snapshot.digest) {
    refuse('DESIGN_APPROVAL_MISMATCH', 'Bootstrap approval must name the captured design digest.');
  }
  const validation = validateDesignRecord(snapshot);
  if (!validation.passed) refuse('PLAN_UNSOUND', 'The typed plan is unsound.', { findings: validation.findings });

  const initialPhase = recordedInitialPhaseOf(start);
  const attempt = PhaseAttemptIdSchema.safeParse(start.data?.phaseAttemptId);
  if (typeof start.timestamp !== 'string' || typeof patch.timestamp !== 'string') {
    refuse('BOOTSTRAP_UNSUPPORTED', 'Bootstrap fold rows require provisional timestamps.');
  }
  WorkflowEventBase.parse(start);
  WorkflowEventBase.parse(patch);
  if (initialPhase === undefined || initialPhase !== def.entryStepId ||
      start.data?.workflowType !== def.workflowType || start.data.featureId !== start.streamId ||
      typeof start.data.repoRoot !== 'string' || start.data.repoRoot.trim().length === 0 || !attempt.success ||
      start.sequence !== 1 || patch.sequence !== 2 || patch.streamId !== start.streamId || patch.type !== 'state.patched') {
    refuse('BOOTSTRAP_UNSUPPORTED', 'Bootstrap requires a coherent versioned start and compatibility patch.');
  }
  const state = foldGuardInput([start, patch]);
  const artifacts = state.artifacts as { design?: unknown; plan?: unknown } | undefined;
  const review = state.planReview as { approved?: unknown } | undefined;
  const scope = state.explore as { scopeAssessment?: unknown } | undefined;
  if (artifacts?.design !== snapshot.reference || artifacts.plan !== snapshot.reference || review?.approved !== true) {
    refuse('DESIGN_APPROVAL_MISMATCH', 'Bootstrap compatibility facts must name the approved design record.');
  }
  if (def.workflowType === 'refactor' && (state.track !== 'overhaul' ||
      typeof scope?.scopeAssessment !== 'string' || scope.scopeAssessment.trim().length === 0)) {
    refuse('BOOTSTRAP_UNSUPPORTED', 'Refactor bootstrap requires overhaul scope assessment.');
  }
  return { phase: initialPhase, phaseAttemptId: attempt.data, index: 0 };
}

/** The source entry follows its own start or transition and the rows of that same boundary. */
function frozenGates(
  rows: readonly WorkflowEvent[],
  state: GuardInput,
  boundary: Boundary,
  kind: 'GATHER' | 'PLAN' | 'IMPLEMENT',
  depth: DesignDepth,
): readonly PlanDepthGateName[] {
  const { phase, phaseAttemptId, index, from } = boundary;
  const source = { phase, phaseAttemptId };
  const [owner, ...trail] = rows.slice(index);
  const entry = trail.at(-1);
  const prefix = trail.slice(0, -1);
  const hasBoundary = from === undefined
    ? owner?.type === 'workflow.started' && recordedInitialPhaseOf(owner) === phase &&
      prefix.length === 1 && prefix[0]?.type === 'state.patched'
    : owner?.type === 'workflow.transition' && owner.data?.from === from && owner.data.to === phase &&
      (prefix.length === 1 || (prefix.length === 2 && prefix[0]?.type === 'workflow.compound-entry')) &&
      prefix.at(-1)?.type === 'phase.exited' && prefix.at(-1)?.data?.phase === from &&
      prefix.at(-1)?.data?.allRequiredGatesPassed === true;
  if (!hasBoundary || owner?.data?.phaseAttemptId !== phaseAttemptId ||
      state.phase !== phase || state.phaseAttemptId !== phaseAttemptId || entry?.type !== 'phase.entered') {
    refuse('BOOTSTRAP_UNSUPPORTED', `No unambiguous frozen entry for '${phase}' on its active attempt.`, { source });
  }

  const obligation = PhaseEnteredData.safeParse(entry.data);
  const coordinate = resolveDangerCoordinate({ risk: state.riskTier, boundary: state.boundaryTouching });
  if (!obligation.success || obligation.data.phase !== phase || obligation.data.kind !== kind ||
      obligation.data.resolver !== (KIND_OBLIGATIONS[kind].gates?.resolver ?? null) ||
      obligation.data.policySource !== 'builtin' || obligation.data.mode !== 'enforce' ||
      obligation.data.riskTier !== coordinate.risk ||
      obligation.data.boundaryTouching !== dangerBoundaryTouching(coordinate) ||
      obligation.data.posture !== KIND_OBLIGATIONS[kind].posture ||
      obligation.data.designDepth !== (kind === 'PLAN' ? depth : undefined)) {
    refuse('BOOTSTRAP_UNSUPPORTED', `Malformed or mismatched frozen obligation for '${phase}'.`, { source });
  }
  const gates = readFrozenGateSequence(obligation.data.resolvedGates);
  const expected = kind === 'PLAN' ? resolvePlanDepthPolicy(depth).sequence : [];
  if (gates === null || gates.length !== expected.length) {
    refuse('BOOTSTRAP_UNSUPPORTED', `Incomplete or unexpected frozen gate list for '${phase}'.`, { source });
  }
  return gates.map(({ family, gate }, offset) => {
    const required = expected[offset];
    if (family !== 'plan' || required === undefined || gate !== required) {
      refuse('BOOTSTRAP_UNSUPPORTED', `Unexpected frozen gate '${family}/${gate}' for '${phase}'.`, { source, gate });
    }
    return required;
  });
}

/** Each check must give an explicit pass before the shared emitter can report the source exit. */
function discharge(input: BootstrapPlanInput, boundary: Boundary, gates: readonly PlanDepthGateName[]): SourceDischarge {
  const { phase, phaseAttemptId } = boundary;
  const source = { phase, phaseAttemptId };
  for (const gate of gates) {
    let result: GateResult;
    try {
      result = CHECKS[gate](input);
    } catch (error) {
      refuse('PLAN_UNSOUND', `Frozen gate '${gate}' failed for '${phase}': ${messageOf(error)}`, { source, gate });
    }
    if (result.passed !== true) {
      const reason = result.reason ?? 'The required check did not pass.';
      refuse('PLAN_UNSOUND', `Frozen gate '${gate}' failed for '${phase}': ${reason}`, {
        source, gate, ...(result.findings === undefined ? {} : { findings: result.findings }),
      });
    }
  }
  return { ...source, gates };
}

const USER_FACTS: ReadonlySet<string> = new Set(['artifacts.plan', 'artifacts.planNonEmpty', 'planReview.approved']);

/** Every leaf of a user condition must use an approved-plan fact. */
function supportedUserCondition(node: EdgeConditionNode): boolean {
  switch (node.kind) {
    case 'all':
    case 'any':
      return node.operands.every(supportedUserCondition);
    case 'not':
      return supportedUserCondition(node.operand);
    case 'factPresent':
    case 'factEquals':
      return USER_FACTS.has(node.field);
    default:
      return false;
  }
}

/** The shared decide counts admitted edges, including edges to the same target. */
function nextEdge(def: DecideDefinition, state: GuardInput): DecideEdge {
  const outcome = decide(def, state, { kind: 'settle' });
  if (outcome.kind !== 'admit' || outcome.move.edgeKind !== 'explicit') {
    refuse('BOOTSTRAP_UNSUPPORTED', `Phase '${String(state.phase)}' requires exactly one admitted bootstrap edge.`);
  }
  const move = outcome.move;
  if (move.isFixCycle || move.isRevision || move.to === def.cancel?.to || move.to === def.cleanup?.to ||
      def.groups.some((group) => group.groupId === move.to)) {
    refuse('BOOTSTRAP_UNSUPPORTED', `Unsupported bootstrap edge '${move.transitionId}'.`);
  }
  return move;
}

/** Every candidate user edge must decide from the closed bootstrap facts. */
function requireSupportedUserEdges(input: BootstrapPlanInput, def: DecideDefinition, phase: unknown): void {
  if (isBuiltInDefinitionType(input.workflowType)) return;
  for (const edge of def.edges) {
    if (edge.from !== phase) continue;
    const obligation = input.definition.exarchos.edges[edge.transitionId]?.obligation;
    if (obligation === undefined || !supportedUserCondition(edge.route.node) ||
        (edge.presence !== undefined && !supportedUserCondition(edge.presence.node)) ||
        (obligation.kind === 'approval' && (obligation.approvalClass !== 'plan-review' || obligation.minimumApprovals !== 1))) {
      refuse('BOOTSTRAP_UNSUPPORTED', `Unsupported predicate on bootstrap edge '${edge.transitionId}'.`);
    }
  }
}

/** The selected step must be a task batch or a supported source. */
function stepOf(input: BootstrapPlanInput, def: DecideDefinition, phase: string): DecideStep & {
  readonly kind: 'GATHER' | 'PLAN' | 'IMPLEMENT';
} {
  const step = def.steps.find((candidate) => candidate.stepId === phase);
  const taskBatch = classifyStep(input.definition, phase) === 'task-batch';
  const kind = step?.kind;
  if (step === undefined || step.isFinal ||
      (kind !== 'PLAN' && kind !== 'GATHER' && !(kind === 'IMPLEMENT' && taskBatch))) {
    refuse('PHASE_NOT_PREPARABLE', `Phase '${phase}' is outside the supported task-batch prefix.`);
  }
  return { ...step, kind };
}

/** Give fold-only envelopes to the shared validated payloads. */
function appendPlanned(
  rows: WorkflowEvent[],
  events: Parameters<typeof phaseRowsOf>[0],
  seed: WorkflowEvent,
  guardId?: string,
): void {
  const payloads = phaseRowsOf(events, seed.streamId, { rows, guardId, includeDesignDepth: true });
  for (const payload of payloads) {
    rows.push(buildValidatedEvent(seed.streamId, rows.length + 1, { ...payload, timestamp: seed.timestamp }));
  }
}

interface PlannedHop {
  readonly state: GuardInput;
  readonly move: DecideEdge;
}

/** A skip must preserve each phase and the exact admitted edge under the same fold. */
function requirePreservedPrefix(
  input: BootstrapPlanInput,
  def: DecideDefinition,
  phases: ReadonlySet<string>,
  hops: readonly PlannedHop[],
): void {
  if (input.skipPhases.length === 0) return;
  const skipped = compileDecideDefinition(input.workflowType, input.definition, input.skipPhases);
  for (const skip of input.skipPhases) {
    const members = def.groups.find((group) => group.groupId === skip)?.members ?? [];
    if (phases.has(skip) || members.some((phase) => phases.has(phase))) {
      refuse('BOOTSTRAP_UNSUPPORTED', `Skip '${skip}' removes a phase in the required bootstrap prefix.`);
    }
  }
  for (const { state, move } of hops) {
    requireSupportedUserEdges(input, skipped, state.phase);
    if (JSON.stringify(nextEdge(skipped, state)) !== JSON.stringify(move)) {
      refuse('BOOTSTRAP_UNSUPPORTED', `Skip policy changes bootstrap edge '${move.transitionId}'.`);
    }
  }
}

/** Use the same error text for evaluator and row validation faults. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds a complete pure prefix or returns a refusal with no appendable rows. */
export function planBootstrapPrefix(input: BootstrapPlanInput): BootstrapPlanResult {
  try {
    const def = compileDecideDefinition(input.workflowType, input.definition);
    let boundary = validateInputs(input, def);
    const [start] = input.seed;
    const rows = [...input.seed];
    const fold = () => foldGuardInput(rows, { authoritativeTasks: input.snapshot.tasks });
    const initial = stepOf(input, def, boundary.phase);
    const state = fold();
    const entry = phaseEntryOf({
      workflowType: def.workflowType,
      from: boundary.phase,
      to: boundary.phase,
      kind: initial.kind,
      designDepth: input.designDepth,
      stateCoordinate: resolveDangerCoordinate({ risk: state.riskTier, boundary: state.boundaryTouching }),
    });
    if (!entry.ok) refuse('BOOTSTRAP_UNSUPPORTED', entry.result.errorMessage ?? 'Initial entry resolution failed.');
    appendPlanned(rows, [entry.event], start);

    const phases = new Set<string>();
    const hops: PlannedHop[] = [];
    const discharges: SourceDischarge[] = [];
    const effects: 'log'[] = [];
    while (!phases.has(boundary.phase) && phases.size < def.steps.length) {
      const { phase, phaseAttemptId } = boundary;
      phases.add(phase);
      const step = stepOf(input, def, phase);
      const state = fold();
      const gates = frozenGates(rows, state, boundary, step.kind, input.designDepth);
      if (step.kind === 'IMPLEMENT') {
        requirePreservedPrefix(input, def, phases, hops);
        return { ok: true, rows, phase, phaseAttemptId, discharges, effects };
      }

      discharges.push(discharge(input, boundary, gates));
      requireSupportedUserEdges(input, def, phase);
      const move = nextEdge(def, state);
      const attempt = allocatePhaseAttemptId(start.streamId, phase, move.to, phaseAttemptId, rows.length);
      const result = phaseMoveEvents(def, { ...state, designDepth: input.designDepth, _pendingPhaseAttemptId: attempt }, move);
      if (!result.success) refuse('BOOTSTRAP_UNSUPPORTED', result.errorMessage ?? 'Bootstrap entry resolution failed.');
      if (result.historyUpdates && Object.keys(result.historyUpdates).length > 0) {
        refuse('BOOTSTRAP_UNSUPPORTED', `Bootstrap edge '${move.transitionId}' has an unsupported history effect.`);
      }
      for (const effect of result.effects) {
        if (effect !== 'log') refuse('BOOTSTRAP_UNSUPPORTED', `Bootstrap edge '${move.transitionId}' has unsupported effect '${effect}'.`);
        effects.push(effect);
      }
      hops.push({ state, move });
      boundary = { phase: move.to, phaseAttemptId: attempt, index: rows.length, from: phase };
      appendPlanned(rows, result.events, start, move.guardId);
    }
    refuse('BOOTSTRAP_UNSUPPORTED', `Bootstrap prefix repeats phase '${boundary.phase}'.`);
  } catch (error) {
    if (error instanceof BootstrapRefused) return error.refusal;
    return { ok: false, code: 'BOOTSTRAP_UNSUPPORTED', message: messageOf(error) };
  }
}
