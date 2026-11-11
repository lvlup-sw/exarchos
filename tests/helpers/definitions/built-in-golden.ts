/**
 * Renders the golden of the five built-in workflows from the live code.
 *
 * The golden pins each machine, the initial phase, the describe topology, the valid targets,
 * the lowered kernel with its digest, and the admission IR edges. It also pins the result of
 * each stored transition input.
 *
 * Each function takes its inputs as arguments. So this module imports no file of `tests/unit`,
 * and the type check of `tests/` reads no file of that tier.
 */

import { canonicalJson } from '../../../src/contract/request-context.js';
import { lowerBuiltInDefinition } from '../../../src/verbs/prepare/lower-definition.js';
import {
  BUILT_IN_WORKFLOW_IR,
  type EdgeObligation,
  type WorkflowEdgeIR,
} from '../../../src/workflow/admission/built-in-workflow-ir.js';
import { serializeEdgeCondition } from '../../../src/workflow/admission/edge-condition.js';
import {
  executeTransition,
  getHSMDefinition,
  getInitialPhase,
  getValidTransitions,
  isBuiltInWorkflowType,
  listWorkflowTypes,
  serializeTopology,
  type HSMDefinition,
  type WorkflowTypeSummary,
} from '../../../src/workflow/state-machine.js';

/** The kind of a stored transition input. The golden test counts each kind against its floor. */
export type EmissionCaseKind = 'corpus' | 'cancel' | 'cleanup' | 'cap' | 'second-guard';

/** The case kinds in the order of the capture. */
const CASE_KINDS: readonly EmissionCaseKind[] = ['corpus', 'cancel', 'cleanup', 'cap', 'second-guard'];

/**
 * One stored transition input. `state.phase` is the source phase of the case.
 * The golden holds the JSON form of each input, so a replay runs exactly the stored bytes.
 */
export interface EmissionInput {
  readonly caseId: string;
  readonly caseKind: EmissionCaseKind;
  readonly type: string;
  readonly target: string;
  readonly state: Readonly<Record<string, unknown>>;
}

/** The fields of a transition admission corpus fixture that the capture reads. */
export interface CorpusCase {
  readonly id: string;
  readonly workflowType: string;
  readonly from: string;
  readonly to: string;
  readonly state: Readonly<Record<string, unknown>>;
}

/**
 * The input of each composite guard that passes the first inner guard and fails the second.
 * No corpus fail case reaches the second inner guard, so these inputs bind it.
 */
const SECOND_GUARD_CASES: readonly Omit<EmissionInput, 'caseId' | 'caseKind'>[] = [
  {
    type: 'feature',
    target: 'review',
    state: {
      phase: 'delegate',
      tasks: [{ id: 'task-1', status: 'complete' }],
      _events: [{ type: 'team.spawned' }],
    },
  },
  {
    type: 'debug',
    target: 'synthesize',
    state: { phase: 'hotfix-validate', validation: { testsPass: true } },
  },
  {
    type: 'debug',
    target: 'debug-implement',
    state: {
      phase: 'synthesize',
      synthesis: { lastError: 'push failed', retryCount: 0 },
      track: 'hotfix',
    },
  },
  {
    type: 'debug',
    target: 'hotfix-implement',
    state: {
      phase: 'synthesize',
      synthesis: { lastError: 'push failed', retryCount: 0 },
      track: 'thorough',
    },
  },
];

/** The review state that passes the `any-review-failed` guard of each fix-cycle edge. */
const FAILED_REVIEWS: Readonly<Record<string, unknown>> = { quality: { status: 'failed' } };

/** True when the value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the value is one of the case kinds. */
function isCaseKind(value: unknown): value is EmissionCaseKind {
  return CASE_KINDS.some((kind) => kind === value);
}

/**
 * Reads one stored input from a parsed JSON value.
 * @throws When the value does not have the shape of an input. The message names the path.
 */
function toEmissionInput(value: unknown, at: string): EmissionInput {
  if (!isRecord(value)) {
    throw new Error(`${at} is not an object`);
  }
  const { caseId, caseKind, type, target, state } = value;
  if (
    typeof caseId !== 'string' ||
    !isCaseKind(caseKind) ||
    typeof type !== 'string' ||
    typeof target !== 'string' ||
    !isRecord(state)
  ) {
    throw new Error(`${at} is not a stored transition input`);
  }
  return { caseId, caseKind, type, target, state };
}

/** Returns the JSON form of an input, with the key order of a stored input. */
function jsonForm(input: EmissionInput): EmissionInput {
  const copy: unknown = JSON.parse(JSON.stringify(input));
  return toEmissionInput(copy, input.caseId);
}

/** The summaries of the five built-in types, in registry order. A custom type of another test stays out. */
function builtInTypes(): WorkflowTypeSummary['workflowTypes'] {
  return listWorkflowTypes().workflowTypes.filter((summary) => isBuiltInWorkflowType(summary.name));
}

/** Returns an obligation with the node of its presence probe in place of the compiled condition. */
function obligationOf(obligation: EdgeObligation): Record<string, unknown> {
  switch (obligation.kind) {
    case 'none':
      return { kind: 'none' };
    case 'gate':
      return { kind: 'gate', gateId: obligation.gateId, presence: obligation.presence.node };
    case 'approval':
      return {
        kind: 'approval',
        approvalClass: obligation.approvalClass,
        minimumApprovals: obligation.minimumApprovals,
        presence: obligation.presence.node,
      };
  }
}

/** Returns one IR edge with its route node, its serialized route and its obligation. */
function irEdgeOf(edge: WorkflowEdgeIR): Record<string, unknown> {
  return {
    from: edge.from,
    to: edge.to,
    toPhaseKind: edge.toPhaseKind,
    category: edge.category,
    legacyGuardId: edge.legacyGuardId,
    route: edge.routeCondition.node,
    routeSerialized: serializeEdgeCondition(edge.routeCondition),
    obligation: obligationOf(edge.obligation),
  };
}

/** Returns the valid targets of each state that is not final, in state order. */
function validTargetsOf(hsm: HSMDefinition): Record<string, unknown> {
  const targets: Record<string, unknown> = {};
  for (const state of Object.values(hsm.states)) {
    if (state.type === 'final') continue;
    targets[state.id] = getValidTransitions(hsm, state.id);
  }
  return targets;
}

/**
 * Returns the cancel and the cleanup input of each atomic state, and the cap input of each fix-cycle edge.
 * A cap input holds as many fix-cycle events as the cap of the group, so the transition opens the circuit.
 */
function machineInputs(): EmissionInput[] {
  const universal: EmissionInput[] = [];
  const caps: EmissionInput[] = [];
  for (const { name } of builtInTypes()) {
    const hsm = getHSMDefinition(name);
    for (const state of Object.values(hsm.states)) {
      if (state.type !== 'atomic') continue;
      universal.push({
        caseId: `cancel-${name}-${state.id}`,
        caseKind: 'cancel',
        type: name,
        target: 'cancelled',
        state: { phase: state.id },
      });
      universal.push({
        caseId: `cleanup-${name}-${state.id}`,
        caseKind: 'cleanup',
        type: name,
        target: 'completed',
        state: { phase: state.id, _cleanup: { mergeVerified: true } },
      });
    }
    for (const transition of hsm.transitions) {
      if (transition.isFixCycle !== true) continue;
      const parentId = hsm.states[transition.from]?.parent;
      const cap = parentId === undefined ? undefined : hsm.states[parentId]?.maxFixCycles;
      if (parentId === undefined || cap === undefined) continue;
      caps.push({
        caseId: `cap-${name}-${parentId}`,
        caseKind: 'cap',
        type: name,
        target: transition.to,
        state: {
          phase: transition.from,
          reviews: FAILED_REVIEWS,
          _events: Array.from({ length: cap }, () => ({
            type: 'fix-cycle',
            metadata: { compoundStateId: parentId },
          })),
        },
      });
    }
  }
  return [...universal, ...caps];
}

/**
 * Returns the stored inputs of the golden: each corpus case, the cancel and cleanup inputs, the caps and the second-guard inputs.
 * A corpus case keeps the fixture id as its case id and runs from the fixture source phase.
 */
export function captureEmissionInputs(corpus: readonly CorpusCase[]): readonly EmissionInput[] {
  const corpusInputs: EmissionInput[] = corpus.map((fixture) => ({
    caseId: fixture.id,
    caseKind: 'corpus',
    type: fixture.workflowType,
    target: fixture.to,
    state: { ...fixture.state, phase: fixture.from },
  }));
  const secondGuardInputs: EmissionInput[] = SECOND_GUARD_CASES.map((entry) => ({
    caseId: `second-guard-${entry.type}-${String(entry.state.phase)}-to-${entry.target}`,
    caseKind: 'second-guard',
    ...entry,
  }));
  return [...corpusInputs, ...machineInputs(), ...secondGuardInputs].map(jsonForm);
}

/**
 * Reads the stored inputs from the text of a golden file.
 * @throws When the text has no `emissions` list, or an entry is not a stored input.
 */
export function readStoredInputs(goldenText: string): readonly EmissionInput[] {
  const golden: unknown = JSON.parse(goldenText);
  const emissions: unknown = isRecord(golden) ? golden.emissions : undefined;
  if (!Array.isArray(emissions)) {
    throw new Error('the golden has no emissions list');
  }
  const entries: readonly unknown[] = emissions;
  return entries.map((entry, index) =>
    toEmissionInput(isRecord(entry) ? entry.input : undefined, `emissions.${index}.input`),
  );
}

/**
 * Renders the golden text from the live code and the stored inputs.
 * Each input runs through `executeTransition` with a gate resolver that returns no gates, so no policy reaches the result.
 * The text is pretty JSON with a final newline. The machine, the topology and the kernel are JSON strings, so the text pins their bytes.
 */
export function renderBuiltInGolden(inputs: readonly EmissionInput[]): string {
  const types = builtInTypes();
  const workflows: Record<string, unknown> = {};
  for (const { name } of types) {
    const hsm = getHSMDefinition(name);
    const lowered = lowerBuiltInDefinition(name);
    if (lowered === undefined) {
      throw new Error(`the built-in type '${name}' has no lowered definition`);
    }
    workflows[name] = {
      initialPhase: getInitialPhase(name),
      machine: JSON.stringify(hsm),
      topology: JSON.stringify(serializeTopology(name)),
      validTargets: validTargetsOf(hsm),
      kernel: canonicalJson(lowered.definition),
      definitionVersion: lowered.definitionVersion,
      irEdges: BUILT_IN_WORKFLOW_IR.filter((edge) => edge.workflowType === name).map(irEdgeOf),
    };
  }
  const emissions = inputs.map(jsonForm).map((input) => ({
    input,
    result: executeTransition(getHSMDefinition(input.type), { ...input.state }, input.target, () => []),
  }));
  return `${JSON.stringify({ types, workflows, emissions }, null, 2)}\n`;
}
