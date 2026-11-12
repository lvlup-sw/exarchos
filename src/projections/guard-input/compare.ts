/**
 * The comparator of the two guard inputs of one transition: the state document and the ledger fold.
 *
 * The comparator compares the phase, the edge-condition facts, the guard config keys and two keys of each task.
 * It also gives the decide verdict of each edge out of the document phase on both inputs, over the built-in definition.
 * The ledger fold decides each call, and the state document is the compared side.
 * Each difference gets a class. The comparator does no I/O, and a throw of the facts step becomes a value.
 * It reads each input in place and never spreads or clones an input, because a spread reads each getter of the input.
 */
import { isDeepStrictEqual } from 'node:util';

import { FACT_DECLARATION } from '../../workflow/admission/built-in-workflow-ir.js';
import { evaluateEdgeCondition, type EdgeConditionFacts } from '../../workflow/admission/edge-condition-evaluate.js';
import { projectStateToFacts } from '../../workflow/admission/legacy-state-translation.js';
import { verdictOf as edgeVerdictOf, type EdgeVerdict } from '../../workflow/decide/decide.js';
import { compileDecideDefinition, type DecideDefinition } from '../../workflow/decide/edges.js';
import { builtInDefinition, isBuiltInDefinitionType, type BuiltInWorkflowType } from '../../workflow/definitions/built-in.js';
import { isPlainObject } from '../../workflow/state-mutation.js';
import type { GuardInput } from './fold.js';

/** The class of one difference between the state document and the ledger fold. */
export type DisagreementClass =
  | 'phase'
  | 'risk-tier'
  | 'task-status'
  | 'task-list'
  | 'merge-orchestrator'
  | 'unexplained';

/** The decide verdict of one edge on one input. A throw of the facts step gives `throw` for each edge of that input. */
type Verdict = EdgeVerdict['verdict'] | 'throw';

/** One key whose value differs between the two inputs. A key that is absent on one side holds `undefined` there. */
interface GuardInputDifference {
  readonly key: string;
  readonly document: unknown;
  readonly fold: unknown;
}

/** The decide verdict of one edge on each input. The universal cleanup move has the transition id `cleanup`. */
interface EdgeVerdicts {
  readonly transitionId: string;
  readonly to: string;
  readonly document: Verdict;
  readonly fold: Verdict;
}

/** The result of a comparison of the two guard inputs of one transition. */
export interface GuardInputComparison {
  /** The workflow type of the document. */
  readonly workflowType: string;
  /** The phase of each input. A phase that is not a string is an empty string here, and the difference keeps the raw value. */
  readonly phase: { readonly document: string; readonly fold: string };
  /** The keys that differ, in the order of the phase keys, the facts, the config keys and the task keys. */
  readonly differences: readonly GuardInputDifference[];
  /** Each edge that the decide evaluated, so a caller can count the denominator. */
  readonly edges: readonly EdgeVerdicts[];
  /** The classes of the differences, in the order of `CLASS_ORDER`, each one time. */
  readonly classes: readonly DisagreementClass[];
  /** True when no key differs and each edge gives the same verdict on both inputs. */
  readonly agrees: boolean;
}

/** A difference with its class. */
interface ClassedDifference extends GuardInputDifference {
  readonly disagreementClass: DisagreementClass;
}

/** The outcome of the facts step on one input. A throw of the step is the outcome `throw`. */
type FactsOutcome = { readonly ok: true; readonly facts: EdgeConditionFacts } | { readonly ok: false };

/** The task id and the status of one task entry of an input. */
interface TaskEntry {
  readonly id: string;
  readonly status: unknown;
}

/** The two task keys of one task id. */
interface TaskStanding {
  readonly complete: boolean;
  readonly failed: boolean;
}

/** One edge that the comparator evaluates: its transition id, its target and its verdict on the facts of one input. */
interface ComparedEdge {
  readonly transitionId: string;
  readonly to: string;
  readonly verdictOn: (facts: EdgeConditionFacts) => EdgeVerdict['verdict'];
}

/** The order of the classes in a comparison. */
const CLASS_ORDER: readonly DisagreementClass[] = [
  'phase',
  'risk-tier',
  'task-status',
  'task-list',
  'merge-orchestrator',
  'unexplained',
];

/** The config keys of the guard input: the risk tier, the boundary status and the injected keys, in the order of the transition handler. */
const CONFIG_KEYS: readonly string[] = [
  'riskTier',
  'boundaryTouching',
  '_requiredReviews',
  '_maxPlanRevisions',
  '_mutationEnforcement',
  '_mutationThreshold',
  '_maxNoCoverage',
];

/** The facts that summarize the task list. Their class comes from the two lists of task ids. */
const TASK_FACTS: ReadonlySet<string> = new Set(['tasks.allComplete', 'tasks.count']);

/** The facts that read the merge state. Their class comes from the two merge orchestrator phases. */
const MERGE_FACTS: ReadonlySet<string> = new Set(['mergePending.entryReady', 'mergePending.exitReady']);

/** The transition id of the universal cleanup move in a comparison. */
const CLEANUP_TRANSITION_ID = 'cleanup';

/** The compiled built-in definitions with no skip, by workflow type. A compile is pure, so each type compiles one time. */
const unskippedDefinitions = new Map<string, DecideDefinition>();

/** Returns the value when it is a string, and otherwise an empty string. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Orders two strings by their UTF-16 code units. */
function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** Returns one classed difference when the two values are not deeply equal, and otherwise no difference. */
function differenceOf(
  key: string,
  document: unknown,
  fold: unknown,
  disagreementClass: DisagreementClass,
): readonly ClassedDifference[] {
  return isDeepStrictEqual(document, fold) ? [] : [{ key, document, fold, disagreementClass }];
}

/** Runs the facts step on one input and catches a throw. */
function factsOf(input: GuardInput): FactsOutcome {
  try {
    return { ok: true, facts: projectStateToFacts(input) };
  } catch {
    return { ok: false };
  }
}

/**
 * Returns the fact differences: each field of `FACT_DECLARATION`, then the key `events[<type>]` for each declared event type.
 * When the facts step throws on one side, only the key `facts` differs. When it throws on both sides, nothing differs.
 */
function factDifferences(
  document: FactsOutcome,
  fold: FactsOutcome,
  taskClass: DisagreementClass,
  mergeClass: DisagreementClass,
): readonly ClassedDifference[] {
  if (!document.ok || !fold.ok) {
    return differenceOf('facts', document.ok ? 'ok' : 'throw', fold.ok ? 'ok' : 'throw', 'unexplained');
  }
  const fieldDifferences = Object.keys(FACT_DECLARATION.fields).flatMap((field) => {
    const factClass = TASK_FACTS.has(field) ? taskClass : MERGE_FACTS.has(field) ? mergeClass : 'unexplained';
    return differenceOf(field, document.facts.fields[field], fold.facts.fields[field], factClass);
  });
  const eventDifferences = (FACT_DECLARATION.events ?? []).flatMap((type) =>
    differenceOf(`events[${type}]`, document.facts.events.includes(type), fold.facts.events.includes(type), 'unexplained'),
  );
  return [...fieldDifferences, ...eventDifferences];
}

/** Returns the task entries of an input, in list order. An entry with no string `id` gets the id `#<index>`. */
function taskEntries(input: GuardInput): readonly TaskEntry[] {
  const tasks = input.tasks;
  if (!Array.isArray(tasks)) return [];
  const list: readonly unknown[] = tasks;
  return list.map((task, index) => ({
    id: isPlainObject(task) && typeof task.id === 'string' ? task.id : `#${index}`,
    status: isPlainObject(task) ? task.status : undefined,
  }));
}

/**
 * Returns the two task keys of each task id.
 * A task id is complete when each entry of the id is complete, and failed when an entry of the id is failed.
 */
function taskStandings(entries: readonly TaskEntry[]): ReadonlyMap<string, TaskStanding> {
  const standings = new Map<string, TaskStanding>();
  for (const entry of entries) {
    const prior = standings.get(entry.id);
    standings.set(entry.id, {
      complete: (prior?.complete ?? true) && entry.status === 'complete',
      failed: (prior?.failed ?? false) || entry.status === 'failed',
    });
  }
  return standings;
}

/** Returns the differences of the keys `tasks[<id>].complete` and `tasks[<id>].failed` for each task id in either list, by sorted task id. */
function taskDifferences(
  document: readonly TaskEntry[],
  fold: readonly TaskEntry[],
  taskClass: DisagreementClass,
): readonly ClassedDifference[] {
  const documentStandings = taskStandings(document);
  const foldStandings = taskStandings(fold);
  const ids = [...new Set([...documentStandings.keys(), ...foldStandings.keys()])].sort(compareText);
  return ids.flatMap((id) => {
    const documentStanding = documentStandings.get(id);
    const foldStanding = foldStandings.get(id);
    return [
      ...differenceOf(`tasks[${id}].complete`, documentStanding?.complete, foldStanding?.complete, taskClass),
      ...differenceOf(`tasks[${id}].failed`, documentStanding?.failed, foldStanding?.failed, taskClass),
    ];
  });
}

/** Returns the sorted list of the task ids of the entries. */
function sortedTaskIds(entries: readonly TaskEntry[]): readonly string[] {
  return entries.map((entry) => entry.id).sort(compareText);
}

/** Returns the phase of the merge orchestrator of an input, or `undefined` when the input holds none. */
function mergePhaseOf(input: GuardInput): unknown {
  const merge = input.mergeOrchestrator;
  return isPlainObject(merge) ? merge.phase : undefined;
}

/** Returns the decide form of a built-in definition with the skipped phases, as the transition handler compiles it. */
function decideDefinitionOf(
  workflowType: BuiltInWorkflowType,
  skipPhases: readonly string[] | undefined,
): DecideDefinition {
  if (skipPhases !== undefined) return compileDecideDefinition(workflowType, builtInDefinition(workflowType), skipPhases);
  const cached = unskippedDefinitions.get(workflowType);
  if (cached !== undefined) return cached;
  const compiled = compileDecideDefinition(workflowType, builtInDefinition(workflowType));
  unskippedDefinitions.set(workflowType, compiled);
  return compiled;
}

/**
 * Returns each edge that the decide can evaluate from `phase`. These are the explicit edges out of the step in edge order, then the universal cleanup move.
 * A final step gives no edge. A phase that is no step gives only the cleanup move, because a cleanup request admits from it.
 */
function edgesOutOf(def: DecideDefinition, phase: string): readonly ComparedEdge[] {
  const step = def.steps.find((candidate) => candidate.stepId === phase);
  if (step?.isFinal === true) return [];
  const explicit = def.edges
    .filter((edge) => edge.from === phase)
    .map((edge): ComparedEdge => ({
      transitionId: edge.transitionId,
      to: edge.to,
      verdictOn: (facts) => edgeVerdictOf(edge, facts).verdict,
    }));
  const cleanup = def.cleanup;
  if (cleanup?.edgeKind !== 'cleanup') return explicit;
  const cleanupEdge: ComparedEdge = {
    transitionId: CLEANUP_TRANSITION_ID,
    to: cleanup.to,
    verdictOn: (facts) => {
      const outcome = evaluateEdgeCondition(cleanup.condition, facts);
      return outcome === 'true' ? 'allow' : outcome === 'false' ? 'deny' : 'indeterminate';
    },
  };
  return [...explicit, cleanupEdge];
}

/** Gives the verdict of one edge on the facts outcome of one input. A throw of the facts step gives `throw`. */
function verdictOn(edge: ComparedEdge, facts: FactsOutcome): Verdict {
  return facts.ok ? edge.verdictOn(facts.facts) : 'throw';
}

/**
 * Compares the guard input of the state document with the guard input of the ledger fold.
 * The type of the document selects the built-in definition, compiled with `options.skipPhases` as the transition handler compiles it.
 * The edges come from the document phase. A type that is not built in gives no comparison.
 * @throws when `options.skipPhases` names a phase that the definition cannot skip, as the transition handler does.
 */
export function compareGuardInputs(
  document: GuardInput,
  fold: GuardInput,
  options: { readonly skipPhases?: readonly string[] } = {},
): GuardInputComparison | undefined {
  const workflowType = document.workflowType;
  if (!isBuiltInDefinitionType(workflowType)) return undefined;
  const def = decideDefinitionOf(workflowType, options.skipPhases);

  const documentPhase = document.phase;
  const foldPhase = fold.phase;
  const documentTasks = taskEntries(document);
  const foldTasks = taskEntries(fold);
  const taskClass: DisagreementClass = isDeepStrictEqual(sortedTaskIds(documentTasks), sortedTaskIds(foldTasks))
    ? 'task-status'
    : 'task-list';
  const mergeClass: DisagreementClass = isDeepStrictEqual(mergePhaseOf(document), mergePhaseOf(fold))
    ? 'unexplained'
    : 'merge-orchestrator';

  const documentFacts = factsOf(document);
  const foldFacts = factsOf(fold);
  const classed: readonly ClassedDifference[] = [
    ...differenceOf('phase', documentPhase, foldPhase, 'phase'),
    ...differenceOf('workflowType', workflowType, fold.workflowType, 'unexplained'),
    ...factDifferences(documentFacts, foldFacts, taskClass, mergeClass),
    ...CONFIG_KEYS.flatMap((key) => differenceOf(key, document[key], fold[key], 'risk-tier')),
    ...taskDifferences(documentTasks, foldTasks, taskClass),
  ];

  const verdicts: readonly EdgeVerdicts[] = edgesOutOf(def, textOf(documentPhase)).map((edge) => ({
    transitionId: edge.transitionId,
    to: edge.to,
    document: verdictOn(edge, documentFacts),
    fold: verdictOn(edge, foldFacts),
  }));

  const found = new Set<DisagreementClass>(classed.map((difference) => difference.disagreementClass));
  if (classed.length === 0 && verdicts.some((verdict) => verdict.document !== verdict.fold)) found.add('unexplained');

  return {
    workflowType,
    phase: { document: textOf(documentPhase), fold: textOf(foldPhase) },
    differences: classed.map(({ key, document: documentValue, fold: foldValue }) => ({
      key,
      document: documentValue,
      fold: foldValue,
    })),
    edges: verdicts,
    classes: CLASS_ORDER.filter((disagreementClass) => found.has(disagreementClass)),
    agrees: classed.length === 0 && verdicts.every((verdict) => verdict.document === verdict.fold),
  };
}
