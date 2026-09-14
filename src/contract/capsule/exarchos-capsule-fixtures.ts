// ─── Capsule fixtures — one corpus, two validators ──────────────────────────
//
// These live under `src/` rather than beside the tests because BOTH sides of
// the round trip import them: the Zod source and the Ajv validator compiled
// from the generated artifact. One corpus is the point — two would drift, and
// the drift would look like agreement.
//
// Every rejecting fixture names the ONE property it violates. A fixture that
// fails for two reasons proves neither, because either rule passing alone would
// still show a rejection.
// ────────────────────────────────────────────────────────────────────────────

import type { ExarchosCapsuleV1 } from './exarchos-capsule.js';

const statement = (text: string): { readonly statement: string } => ({ statement: text });

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

/**
 * A complete, structurally valid capsule. Every other fixture bends this one.
 *
 * It is also referentially SOUND — every id it names resolves — which is what
 * lets the reference tests bend exactly one reference and read the result. A
 * base that already carried a violation would make each of those tests pass for
 * the wrong reason.
 */
export function baseValidCapsule(): ExarchosCapsuleV1 {
  return {
    capsuleSchemaVersion: '1',
    identity: {
      workflowId: 'wf-capsule-corpus',
      definitionVersion: DIGEST_A,
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
      taskResults: { 'task-verify': [{ name: 'passed', type: 'boolean', required: true }] },
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
    settlementContract: { requiredResults: ['task-verify'] },
  };
}

/** The smallest accepted capsule: no `executionProfile`, empty optional arrays. */
export function minimalValidCapsule(): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return {
    ...base,
    intent: { ...base.intent, nonGoals: [] },
    graph: { ...base.graph, dependencies: [], joins: [] },
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

  // ── The authority block: derived from the kernel, closed here ──────────────
  bend('authority is empty', (b) => ({ ...b, authority: {} })),
  bend('an authority category is empty', (b) => ({
    ...b,
    authority: { ...b.authority, invariants: [] },
  })),
  // The one fixture that proves the derivation went DEEP rather than closing
  // only the outer object. The published kernel accepts this document.
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

  // ── Knowledge as a union, not an enum plus a rule ──────────────────────────
  bend('eager knowledge carrying a supplement budget', (b) => ({
    ...b,
    knowledge: { mode: 'eager', rationale: [], patterns: [], glossary: [], supplementBudget: 10 },
  })),
  bend('hybrid knowledge without a budget', (b) => ({
    ...b,
    knowledge: { mode: 'hybrid', rationale: [], patterns: [], glossary: [], unresolvedRefs: [] },
  })),

  // ── The completion predicate stays a closed AST ────────────────────────────
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

  // ── Cardinality obligations this contract adds ─────────────────────────────
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
  // The batch is named by the settlement request, never compiled in: one
  // capsule is settled over as many batches as it takes to get one accepted.
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

  // ── Borrowed kernel vocabulary ─────────────────────────────────────────────
  bend('a definition version that is not a digest', (b) => ({
    ...b,
    identity: { ...b.identity, definitionVersion: 'v7' },
  })),
  bend('a provenance digest that is not a digest', (b) => ({
    ...b,
    provenance: { ...b.provenance, sources: [{ sourceId: 's', digest: 'short' }] },
  })),

  // ── The document is closed at the top too ──────────────────────────────────
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
