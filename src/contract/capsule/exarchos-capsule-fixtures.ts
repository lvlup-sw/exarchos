/**
 * The capsule fixture corpus. Both the Zod source and the Ajv validator from the generated
 * artifact import it, so it lives under `src/`. Two corpora can drift, and the drift can look like
 * agreement.
 *
 * Each rejecting fixture breaks exactly one property. A fixture that fails for two reasons proves
 * neither rule.
 */

import { contentDigest } from './capsule-digest.js';
import type { ExarchosCapsuleV1 } from './exarchos-capsule.js';

const statement = (text: string): { readonly statement: string } => ({ statement: text });

const DIGEST_B = 'b'.repeat(64);

/**
 * The kernel definition of the base capsule. Its one step is the step that `task-verify` names.
 * The `definitionVersion` of the base capsule is the digest of this document, so the two agree.
 */
export function baseValidDefinition(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    name: 'capsule-corpus',
    steps: [
      { kind: 'skill', stepId: 'step-verify', stepName: 'verify', isTerminal: true, stepType: 'work' },
    ],
    transitions: [],
    branchPoints: [],
    loops: [],
    forkPoints: [],
    failureHandlers: [],
    approvalPoints: [],
  };
}

/**
 * A complete, structurally valid capsule. Each rejecting fixture changes this one.
 *
 * Each id that it names resolves. Thus a reference test can break exactly one reference and read
 * the result. A base with a violation lets those tests pass for the wrong reason.
 */
export function baseValidCapsule(): ExarchosCapsuleV1 {
  return {
    capsuleSchemaVersion: '1',
    identity: {
      workflowId: 'wf-capsule-corpus',
      definitionVersion: contentDigest(baseValidDefinition()),
      designVersion: 'design-1',
      capsuleVersion: 7,
    },
    intent: {
      goals: [statement('settle one batch against a pinned capsule')],
      nonGoals: [statement('compile the capsule')],
      successCriteria: [statement('every claim is adjudicated exactly once')],
    },
    authority: {
      invariants: [statement('history is append-only')],
      assumptions: [statement('the event store is SQLite')],
      delegatedDecisions: [statement('field naming inside a task result')],
      escalationBoundaries: [statement('any change to a published schema')],
    },
    graph: {
      tasks: [
        { taskId: 'task-compile', title: 'compile the segment' },
        { taskId: 'task-verify', title: 'verify the result', stepId: 'step-verify' },
      ],
      dependencies: [{ from: 'task-compile', to: 'task-verify' }],
      joins: [{ joinId: 'join-all', waitsFor: ['task-compile', 'task-verify'], mode: 'all' }],
      completionPredicate: {
        condition: { kind: 'factPresent', field: 'verified' },
        declares: { fields: { verified: 'boolean' }, events: ['execution.settled'] },
      },
    },
    contracts: {
      taskInputs: { 'task-compile': [{ name: 'source', type: 'string', required: true }] },
      taskResults: {
        'task-verify': [
          { name: 'passed', type: 'boolean', required: true },
          { name: 'worktreePath', type: 'string', required: false },
        ],
      },
      evidenceKinds: ['test', 'diff'],
      deviationEnvelope: { allowedDeviationKinds: ['invalidated-assumption'], requiresApproval: true },
    },
    knowledge: {
      mode: 'eager',
      rationale: [statement('settlement adjudicates against the pinned capsule')],
      patterns: [],
      glossary: [],
    },
    provenance: {
      sources: [{ sourceId: 'decision-record', digest: DIGEST_B }],
      compiledAt: '2026-09-12T00:00:00Z',
      compilerVersion: 'capsule-compiler-0',
    },
    settlementContract: {
      requiredResults: ['task-verify'],
      taskVerification: {
        'task-verify': { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
      },
    },
  };
}

/** The smallest accepted capsule: no `executionProfile`, no verification terms, empty optional arrays. */
export function minimalValidCapsule(): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return {
    ...base,
    intent: { ...base.intent, nonGoals: [] },
    graph: { ...base.graph, dependencies: [], joins: [] },
    settlementContract: { requiredResults: base.settlementContract.requiredResults },
  };
}

/** One corpus entry. `valid` is what BOTH validators must independently answer. */
export interface CapsuleFixture {
  readonly name: string;
  readonly valid: boolean;
  readonly document: unknown;
}

function bend(name: string, mutate: (base: ExarchosCapsuleV1) => unknown): CapsuleFixture {
  return { name, valid: false, document: mutate(baseValidCapsule()) };
}

/** The base capsule with its one task's base replaced, and nothing else changed. */
function withBase(base: ExarchosCapsuleV1, baseRef: string): unknown {
  return {
    ...base,
    settlementContract: {
      ...base.settlementContract,
      taskVerification: { 'task-verify': { riskTier: 'low', boundaryTouching: false, baseRef } },
    },
  };
}

/** The shared corpus. Both the Zod source and the Ajv validator run every entry. */
export const CAPSULE_ROUNDTRIP_FIXTURES: readonly CapsuleFixture[] = [
  { name: 'the base capsule', valid: true, document: baseValidCapsule() },
  { name: 'minimal — no executionProfile', valid: true, document: minimalValidCapsule() },
  {
    name: 'with an executionProfile',
    valid: true,
    document: { ...baseValidCapsule(), executionProfile: { capabilities: ['worktree'] } },
  },
  {
    name: 'hybrid knowledge with a budget',
    valid: true,
    document: {
      ...baseValidCapsule(),
      knowledge: {
        mode: 'hybrid',
        rationale: [],
        patterns: [],
        glossary: [],
        unresolvedRefs: ['design-record-2'],
        supplementBudget: 4096,
      },
    },
  },

  bend('authority is empty', (b) => ({ ...b, authority: {} })),
  bend('an authority category is empty', (b) => ({
    ...b,
    authority: { ...b.authority, invariants: [] },
  })),
  /**
   * This fixture proves that the derivation closes the nested statement objects too. The published
   * kernel accepts this document.
   */
  bend('an unknown key INSIDE an authority statement', (b) => ({
    ...b,
    authority: {
      ...b.authority,
      invariants: [{ statement: 'history is append-only', smuggled: true }],
    },
  })),
  bend('an authority statement is blank', (b) => ({
    ...b,
    authority: { ...b.authority, invariants: [{ statement: '' }] },
  })),

  bend('eager knowledge carrying a supplement budget', (b) => ({
    ...b,
    knowledge: { mode: 'eager', rationale: [], patterns: [], glossary: [], supplementBudget: 10 },
  })),
  bend('hybrid knowledge without a budget', (b) => ({
    ...b,
    knowledge: { mode: 'hybrid', rationale: [], patterns: [], glossary: [], unresolvedRefs: [] },
  })),

  bend('a predicate node carrying an expression', (b) => ({
    ...b,
    graph: {
      ...b.graph,
      completionPredicate: {
        condition: { kind: 'factPresent', field: 'verified', expression: 'rm -rf /' },
        declares: { fields: {}, events: [] },
      },
    },
  })),
  bend('a predicate node of an unknown kind', (b) => ({
    ...b,
    graph: {
      ...b.graph,
      completionPredicate: {
        condition: { kind: 'shellOut', command: 'true' },
        declares: { fields: {}, events: [] },
      },
    },
  })),

  bend('no goals', (b) => ({ ...b, intent: { ...b.intent, goals: [] } })),
  bend('no success criteria', (b) => ({ ...b, intent: { ...b.intent, successCriteria: [] } })),
  bend('no tasks', (b) => ({ ...b, graph: { ...b.graph, tasks: [] } })),
  bend('no evidence kinds', (b) => ({
    ...b,
    contracts: { ...b.contracts, evidenceKinds: [] },
  })),
  bend('no required results', (b) => ({
    ...b,
    settlementContract: { ...b.settlementContract, requiredResults: [] },
  })),
  bend('a verification tier outside the vocabulary', (b) => ({
    ...b,
    settlementContract: {
      ...b.settlementContract,
      taskVerification: {
        'task-verify': { riskTier: 'extreme', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
      },
    },
  })),
  bend('verification terms with no base', (b) => ({
    ...b,
    settlementContract: {
      ...b.settlementContract,
      taskVerification: { 'task-verify': { riskTier: 'low', boundaryTouching: false } },
    },
  })),
  bend('a base that starts with a dash', (b) => withBase(b, '-feature')),
  bend('a base that names a range', (b) => withBase(b, 'main..feature/x')),
  bend('a base that holds whitespace', (b) => withBase(b, 'feature x')),
  /**
   * The settlement request names the batch. The capsule does not, because one capsule can settle
   * over many batches until one is accepted.
   */
  bend('a batch id compiled into the settlement contract', (b) => ({
    ...b,
    settlementContract: { ...b.settlementContract, batchId: 'batch-0001' },
  })),
  bend('no provenance sources', (b) => ({
    ...b,
    provenance: { ...b.provenance, sources: [] },
  })),
  bend('a join waiting on one task', (b) => ({
    ...b,
    graph: { ...b.graph, joins: [{ joinId: 'j', waitsFor: ['task-compile'], mode: 'all' }] },
  })),

  bend('a definition version that is not a digest', (b) => ({
    ...b,
    identity: { ...b.identity, definitionVersion: 'v7' },
  })),
  bend('a provenance digest that is not a digest', (b) => ({
    ...b,
    provenance: { ...b.provenance, sources: [{ sourceId: 's', digest: 'short' }] },
  })),

  bend('an unknown top-level key', (b) => ({ ...b, capsuleNotes: 'smuggled' })),
  bend('a capsule version below one', (b) => ({
    ...b,
    identity: { ...b.identity, capsuleVersion: 0 },
  })),
  bend('a compiledAt that is not a timestamp', (b) => ({
    ...b,
    provenance: { ...b.provenance, compiledAt: 'yesterday' },
  })),
];
