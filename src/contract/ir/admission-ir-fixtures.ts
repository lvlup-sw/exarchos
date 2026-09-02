// ─── Shared admission IR — shared fixture corpus (P03-06) ────────────────────
//
// The SINGLE corpus validated by BOTH sides of the round-trip: the generated
// JSON Schema (via Ajv) and the authored Zod runtime validators. `roundtrip.
// test.ts` asserts the two agree accept/reject on every entry; `references.
// test.ts` reuses the structurally-valid docs to exercise dangling-reference
// rejection. Kept in one place so the two exit-proof halves cannot drift apart.
//
// Test-only data (the `*-fixtures.ts` module-intent class): never a production
// import target. Fixtures are deliberately typed `unknown` (they include
// malformed inputs); the `o`/`a` helpers narrow via `unknown` casts to poke
// values into a cloned baseline without reaching for `any`.
// ────────────────────────────────────────────────────────────────────────────

/** Narrow an unknown fixture node to a mutable object (test-data navigation). */
const o = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
/** Narrow an unknown fixture node to a mutable array (test-data navigation). */
const a = (v: unknown): unknown[] => v as unknown[];

/** A fresh, deeply-independent, fully-valid shared IR document. */
export function baseValidDoc(): Record<string, unknown> {
  return {
    irVersion: '1',
    workflowId: 'wf.demo',
    policies: [
      { policyId: 'pol.release', requires: ['req.gate', 'req.appr'], onDeny: ['exarchos_event.append'] },
      { policyId: 'pol.simple', requires: [], onDeny: [] },
    ],
    requirements: [
      { requirementId: 'req.gate', kind: 'gate-evidence', gateId: 'gate.build', subjectKind: 'task' },
      {
        requirementId: 'req.appr',
        kind: 'approval',
        approvalClass: 'release',
        minimumApprovals: 2,
        subjectKind: 'workflow',
      },
      {
        requirementId: 'req.corr',
        kind: 'corroboration',
        sourceRequirementId: 'req.gate',
        minimumIndependentSources: 2,
        subjectKind: 'diff',
      },
    ],
    edges: [
      {
        edgeId: 'edge.build',
        from: 's.plan',
        to: 's.review',
        declaration: { fields: { retries: 'number', ok: 'boolean', tag: 'string' }, events: ['built'] },
        condition: {
          kind: 'all',
          operands: [
            { kind: 'eventObserved', event: 'built' },
            { kind: 'counterCompare', field: 'retries', op: 'lte', value: 3 },
            { kind: 'not', operand: { kind: 'factEquals', field: 'ok', value: false } },
            { kind: 'any', operands: [{ kind: 'factPresent', field: 'tag' }] },
          ],
        },
        admits: 'pol.release',
        effect: { actionRef: 'exarchos_event.append' },
      },
    ],
    waivers: [
      {
        waiverId: 'wv.gate',
        scope: { kind: 'workflow', workflowId: 'wf.demo' },
        waives: ['req.gate'],
        expiresAt: '2027-01-01T00:00:00Z',
        authorization: { approvalClass: 'release', minimumApprovals: 1 },
      },
    ],
  };
}

/** A minimal but valid document (empty collections, one gated edge, one waiver). */
export function minimalValidDoc(): Record<string, unknown> {
  return {
    irVersion: '1',
    workflowId: 'wf.min',
    policies: [{ policyId: 'p', requires: [], onDeny: [] }],
    requirements: [{ requirementId: 'r', kind: 'gate-evidence', gateId: 'g', subjectKind: 'commit' }],
    edges: [
      {
        edgeId: 'e',
        from: 'a',
        to: 'b',
        declaration: { fields: {}, events: [] },
        condition: { kind: 'all', operands: [] },
        admits: 'p',
        effect: { actionRef: 'exarchos_event.append' },
      },
    ],
    waivers: [
      {
        waiverId: 'w',
        scope: { kind: 'subject', subjectKind: 'artifact' },
        waives: ['r'],
        expiresAt: '2030-06-15T12:30:00+02:00',
        authorization: { approvalClass: 'ops', minimumApprovals: 1 },
      },
    ],
  };
}

// Convenience navigators into a cloned base document.
const edge0 = (d: Record<string, unknown>): Record<string, unknown> => o(a(d['edges'])[0]);
const cond = (d: Record<string, unknown>): Record<string, unknown> => o(edge0(d)['condition']);
const condOps = (d: Record<string, unknown>): unknown[] => a(cond(d)['operands']);

/** One round-trip corpus entry: a document + whether it is STRUCTURALLY valid. */
export interface RoundTripFixture {
  readonly name: string;
  readonly doc: unknown;
  readonly structurallyValid: boolean;
}

/**
 * Mutate a fresh valid doc in place and tag it. Keeps each malformed fixture a
 * one-line delta from a known-good baseline, so the ONLY thing under test is
 * the specific violation.
 */
function mutate(
  name: string,
  structurallyValid: boolean,
  f: (d: Record<string, unknown>) => void,
): RoundTripFixture {
  const doc = baseValidDoc();
  f(doc);
  return { name, doc, structurallyValid };
}

export const ROUNDTRIP_FIXTURES: readonly RoundTripFixture[] = [
  // ── structurally VALID ──
  { name: 'base valid document', doc: baseValidDoc(), structurallyValid: true },
  { name: 'minimal valid document', doc: minimalValidDoc(), structurallyValid: true },
  mutate('all collections empty', true, (d) => {
    d['policies'] = [];
    d['requirements'] = [];
    d['edges'] = [];
    d['waivers'] = [];
  }),
  mutate('waiver phase-attempt scope', true, (d) => {
    o(a(d['waivers'])[0])['scope'] = { kind: 'phase-attempt', phaseAttemptId: 'pa.1' };
  }),
  mutate('factEquals with string and number scalars', true, (d) => {
    edge0(d)['condition'] = {
      kind: 'all',
      operands: [
        { kind: 'factEquals', field: 'tag', value: 'green' },
        { kind: 'counterCompare', field: 'retries', op: 'gte', value: 0 },
      ],
    };
  }),

  // ── ESCAPE HATCHES (closure property) — must be rejected by BOTH sides ──
  mutate('edge condition node carries an `expression` escape hatch', false, (d) => {
    o(condOps(d)[0])['expression'] = 'a && b';
  }),
  mutate('edge condition node carries a `command` escape hatch', false, (d) => {
    condOps(d).push({ kind: 'factPresent', field: 'x', command: 'rm -rf /' });
  }),
  mutate('unknown edge condition node kind `custom`', false, (d) => {
    condOps(d).push({ kind: 'custom', script: 'do()' });
  }),
  mutate('unknown edge condition node kind `shell`', false, (d) => {
    edge0(d)['condition'] = { kind: 'shell', cmd: 'echo hi' };
  }),
  mutate('factEquals value is a non-scalar object (smuggled closure)', false, (d) => {
    condOps(d)[2] = {
      kind: 'not',
      operand: { kind: 'factEquals', field: 'ok', value: { $fn: 'evil()' } },
    };
  }),
  mutate('policy carries an `exec` escape hatch', false, (d) => {
    o(a(d['policies'])[0])['exec'] = 'node -e "…"';
  }),
  mutate('top-level `script` escape hatch', false, (d) => {
    d['script'] = 'process.exit(1)';
  }),

  // ── other STRUCTURAL violations ──
  mutate('workflowId has a space (not a stable id)', false, (d) => {
    d['workflowId'] = 'wf demo';
  }),
  mutate('workflowId is a shell fragment', false, (d) => {
    d['workflowId'] = '; rm -rf /';
  }),
  mutate('wrong irVersion', false, (d) => {
    d['irVersion'] = '2';
  }),
  mutate('unknown subjectKind enum', false, (d) => {
    o(a(d['requirements'])[0])['subjectKind'] = 'nope';
  }),
  mutate('unknown counterCompare op', false, (d) => {
    o(condOps(d)[1])['op'] = 'neq';
  }),
  mutate('minimumApprovals must be positive', false, (d) => {
    o(a(d['requirements'])[1])['minimumApprovals'] = 0;
  }),
  mutate('corroboration minimumIndependentSources must be >= 2', false, (d) => {
    o(a(d['requirements'])[2])['minimumIndependentSources'] = 1;
  }),
  mutate('waiver.waives may not be empty', false, (d) => {
    o(a(d['waivers'])[0])['waives'] = [];
  }),
  mutate('requirement missing discriminant kind', false, (d) => {
    delete o(a(d['requirements'])[0])['kind'];
  }),
  mutate('edge missing effect', false, (d) => {
    delete edge0(d)['effect'];
  }),
  mutate('expiresAt is not an ISO datetime', false, (d) => {
    o(a(d['waivers'])[0])['expiresAt'] = '2027-01-01';
  }),
  mutate('declaration field type is not a fact type', false, (d) => {
    o(o(edge0(d)['declaration'])['fields'])['retries'] = 'integer';
  }),
  { name: 'not an object at all', doc: 'nope', structurallyValid: false },
  { name: 'null document', doc: null, structurallyValid: false },
  { name: 'array document', doc: [], structurallyValid: false },
];

// ─── Closed edge-condition cases (three-way agreement with the runtime) ──────

/** An edge-condition case tagged with its declaration and structural validity. */
export interface EdgeConditionCase {
  readonly name: string;
  readonly condition: unknown;
  readonly fields: Readonly<Record<string, 'string' | 'number' | 'boolean'>>;
  readonly events: readonly string[];
  /** Whether the runtime `compileEdgeCondition` + the IR schema should accept it. */
  readonly valid: boolean;
}

export const EDGE_CONDITION_CASES: readonly EdgeConditionCase[] = [
  {
    name: 'nested all/any/not/counterCompare/eventObserved',
    condition: {
      kind: 'all',
      operands: [
        { kind: 'eventObserved', event: 'built' },
        { kind: 'counterCompare', field: 'retries', op: 'lte', value: 3 },
        { kind: 'not', operand: { kind: 'factEquals', field: 'ok', value: true } },
        { kind: 'any', operands: [{ kind: 'factPresent', field: 'tag' }] },
      ],
    },
    fields: { retries: 'number', ok: 'boolean', tag: 'string' },
    events: ['built'],
    valid: true,
  },
  {
    name: 'empty all is the always-legal constant',
    condition: { kind: 'all', operands: [] },
    fields: {},
    events: [],
    valid: true,
  },
  {
    name: 'expression escape hatch is rejected',
    condition: { kind: 'factEquals', field: 'ok', value: true, expression: 'a && b' },
    fields: { ok: 'boolean' },
    events: [],
    valid: false,
  },
  {
    name: 'unknown kind is rejected',
    condition: { kind: 'custom', command: 'sh -c evil' },
    fields: {},
    events: [],
    valid: false,
  },
  {
    name: 'non-scalar factEquals value is rejected',
    condition: { kind: 'factEquals', field: 'ok', value: { nested: true } },
    fields: { ok: 'boolean' },
    events: [],
    valid: false,
  },
];
