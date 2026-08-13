/**
 * Exit-proof tests for P06-02 — deterministic edge (route) selection
 * (Transition task 010).
 *
 * Proves:
 *   (d) route selection is deterministic and explicit for zero-match and
 *       multi-match, and fails closed on a leading indeterminate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compileEdgeCondition,
  type EdgeConditionDeclaration,
} from './edge-condition.js';
import {
  evaluateEdgeCondition,
  type EdgeConditionFacts,
} from './edge-condition-evaluate.js';
import {
  evaluateEdgeCandidates,
  selectEdge,
  type EdgeCandidate,
} from './edge-condition-select.js';
import {
  BUILT_IN_WORKFLOW_IR,
  FACT_DECLARATION,
  edgeKey,
  getEdgeIR,
  type WorkflowEdgeIR,
} from './built-in-workflow-ir.js';
import {
  adjudicateEdge,
  adjudicateEdgeDecision,
  adjudicateOutboundEdges,
  defaultTranslationContext,
  projectStateToFacts,
} from './legacy-state-translation.js';
import {
  flushLiveShadowEvidence,
  liveShadowEvidenceStreamId,
  liveShadowSink,
} from './live-shadow-observer.js';
import { EventStore } from '../../events/store.js';
import { AdmissionShadowAttemptData } from '../../events/schemas.js';
import { handleWorkflow } from '../composite.js';
import { handleGet, handleSet } from '../tools.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const declaration = {
  fields: {
    phaseKind: 'string',
    boundaryClear: 'boolean',
  },
} as const satisfies EdgeConditionDeclaration;

const compile = (raw: unknown) => compileEdgeCondition(raw, declaration);

// Against facts { phaseKind: 'review' } (boundaryClear absent):
const facts: EdgeConditionFacts = { fields: { phaseKind: 'review' }, events: [] };
const trueCond = compile({ kind: 'factEquals', field: 'phaseKind', value: 'review' });
const falseCond = compile({ kind: 'factEquals', field: 'phaseKind', value: 'plan' });
const indetCond = compile({ kind: 'factEquals', field: 'boundaryClear', value: true });

const edge = (edgeId: string, condition: EdgeCandidate['condition']): EdgeCandidate => ({
  edgeId,
  condition,
});

describe('single-match selection', () => {
  it('selects the only true edge and reports no ambiguity', () => {
    const result = selectEdge(
      [edge('to-plan', falseCond), edge('to-review', trueCond)],
      facts,
    );
    expect(result).toEqual({ outcome: 'selected', edgeId: 'to-review', index: 1, multiMatch: false, matchedEdgeIds: ['to-review'] });
  });
});

describe('(d) zero-match is explicit and deterministic', () => {
  it('returns no-match when every candidate is false', () => {
    const result = selectEdge([edge('a', falseCond), edge('b', falseCond)], facts);
    expect(result).toEqual({ outcome: 'no-match' });
  });

  it('returns no-match for an empty candidate list', () => {
    expect(selectEdge([], facts)).toEqual({ outcome: 'no-match' });
  });
});

describe('(d) multi-match is deterministic (first in order wins) and explicit', () => {
  it('selects the first true candidate and flags multiMatch', () => {
    const result = selectEdge(
      [edge('first', trueCond), edge('second', trueCond)],
      facts,
    );
    expect(result).toEqual({ outcome: 'selected', edgeId: 'first', index: 0, multiMatch: true, matchedEdgeIds: ['first', 'second'] });
  });

  it('selection depends only on order, not on identity', () => {
    const forward = selectEdge([edge('first', trueCond), edge('second', trueCond)], facts);
    const reversed = selectEdge([edge('second', trueCond), edge('first', trueCond)], facts);
    expect(forward).toMatchObject({ edgeId: 'first', index: 0 });
    expect(reversed).toMatchObject({ edgeId: 'second', index: 0 });
  });

  it('is stable across repeated evaluations', () => {
    const candidates = [edge('first', trueCond), edge('second', trueCond)];
    const first = selectEdge(candidates, facts);
    for (let i = 0; i < 50; i += 1) {
      expect(selectEdge(candidates, facts)).toEqual(first);
    }
  });
});

describe('(d) fail-closed on indeterminate (DR-9)', () => {
  it('blocks when the highest-priority non-false candidate is indeterminate', () => {
    const result = selectEdge(
      [edge('skip', falseCond), edge('unknown', indetCond), edge('legal', trueCond)],
      facts,
    );
    expect(result).toEqual({ outcome: 'blocked', edgeId: 'unknown', index: 1 });
  });

  it('does not fall through a leading indeterminate to a later true edge', () => {
    const result = selectEdge([edge('unknown', indetCond), edge('legal', trueCond)], facts);
    expect(result).toEqual({ outcome: 'blocked', edgeId: 'unknown', index: 0 });
  });

  it('skips earlier false edges before selecting a true edge', () => {
    const result = selectEdge([edge('no', falseCond), edge('yes', trueCond)], facts);
    expect(result).toEqual({ outcome: 'selected', edgeId: 'yes', index: 1, multiMatch: false, matchedEdgeIds: ['yes'] });
  });

  it('does not treat a trailing indeterminate as blocking a higher-priority true edge', () => {
    const result = selectEdge([edge('yes', trueCond), edge('unknown', indetCond)], facts);
    expect(result).toEqual({ outcome: 'selected', edgeId: 'yes', index: 0, multiMatch: false, matchedEdgeIds: ['yes'] });
  });
});

describe('evaluateEdgeCandidates', () => {
  it('returns one ordered outcome per candidate', () => {
    const evaluations = evaluateEdgeCandidates(
      [edge('a', trueCond), edge('b', falseCond), edge('c', indetCond)],
      facts,
    );
    expect(evaluations).toEqual([
      { edgeId: 'a', index: 0, outcome: 'true' },
      { edgeId: 'b', index: 1, outcome: 'false' },
      { edgeId: 'c', index: 2, outcome: 'indeterminate' },
    ]);
  });
});


// ─── DR-34 — the route selector is LIVE, not merely built ─────────────────────
//
// `selectEdge`'s only caller used to be the RESERVED `runTransitionCommand`,
// while the SHIPPED path decided route legality by evaluating ONE edge's
// condition in isolation (`adjudicateEdge` -> `evaluateEdgeCondition(
// edge.routeCondition, facts)`), reached from the real HSM guard via
// `recordLiveTransition` and from affordance publication via
// `adjudicateOutboundEdges`. Both selector rules were therefore INERT in
// production: a phase with two simultaneously-true outbound conditions looked
// exactly like an unambiguous one, and a lower-priority edge fell straight
// through a higher-priority candidate whose legality was unknown.
//
// These tests drive the LIVE path (a real event store + state dir, the real
// composite workflow handler, the real HSM guard, the real state projection)
// over topologies that are genuinely ambiguous / genuinely indeterminate.

const LIVE_CTX = defaultTranslationContext('2025-01-01T00:00:00.000Z');

/** The shipped feature outbound set from `plan-review`, in priority order. */
const PLAN_REVIEW_TARGETS = ['delegate', 'blocked', 'plan'] as const;

describe('DR-34 — multi-match detection on the live transition path', () => {
  let stateDir: string;
  let eventStore: EventStore;

  const ctx = () => ({ stateDir, eventStore, enableTelemetry: false });

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'route-selector-live-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    liveShadowSink.clear();
  });

  afterEach(async () => {
    await flushLiveShadowEvidence();
    liveShadowSink.clear();
    eventStore.close();
    await rmrfAsync(stateDir);
  });

  it('SelectEdge_TwoSimultaneouslyTrueConditions_ReportsMultiMatch', async () => {
    const featureId = 'route-selector-multi-match';

    // The SHIPPED feature topology out of `plan-review` is genuinely ambiguous:
    // `-> delegate` carries the always-legal route (its obligation is an
    // approval, not a route condition), so the moment `planReview.gapsFound`
    // turns true the `-> plan` route is simultaneously true.
    const outbound = BUILT_IN_WORKFLOW_IR.filter(
      (e) => e.workflowType === 'feature' && e.from === 'plan-review',
    );
    expect(outbound.map((e) => e.to)).toEqual([...PLAN_REVIEW_TARGETS]);

    const init = await handleWorkflow(
      { action: 'init', featureId, workflowType: 'feature' },
      ctx(),
    );
    expect(init.success).toBe(true);
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'docs/specs/x.md' } },
      stateDir,
      eventStore,
    );
    const toReview = await handleWorkflow(
      { action: 'transition', featureId, target: 'plan-review' },
      ctx(),
    );
    expect(toReview.success).toBe(true);

    // ── Control: the SAME phase, read out of the real store, is unambiguous
    // while `gapsFound` is false. Only `-> delegate` is route-legal. ──────────
    const unambiguous = (
      await handleGet({ featureId }, stateDir, eventStore)
    ).data as Record<string, unknown>;
    const before = adjudicateOutboundEdges(
      'feature',
      'plan-review',
      unambiguous,
      LIVE_CTX,
    );
    expect(before.get('delegate')?.multiMatch).toBe(false);
    expect(before.get('plan')?.multiMatch).toBe(false);

    // ── Make the shipped topology genuinely ambiguous. ───────────────────────
    await handleSet(
      { featureId, updates: { 'planReview.gapsFound': true } },
      stateDir,
      eventStore,
    );
    const ambiguous = (
      await handleGet({ featureId }, stateDir, eventStore)
    ).data as Record<string, unknown>;
    expect(ambiguous['planReview']).toMatchObject({ gapsFound: true });

    // The LIVE transition: real composite handler -> real HSM guard ->
    // `GuardContext.shadowObserver` -> `recordLiveTransition` ->
    // `adjudicateEdge`, which now routes through `selectEdge`.
    const transition = await handleWorkflow(
      { action: 'transition', featureId, target: 'plan' },
      ctx(),
    );
    expect(transition.success).toBe(true);
    await flushLiveShadowEvidence();

    const persisted = await eventStore.query(
      liveShadowEvidenceStreamId(featureId),
      { type: 'admission.shadow-attempt' },
    );
    expect(persisted.length).toBeGreaterThan(0);
    const durable = AdmissionShadowAttemptData.parse(
      persisted[persisted.length - 1]!.data,
    );
    expect(durable.decision.outcome).toBe('allow');

    // ── The ambiguity is DETECTED, not silently resolved to whichever edge
    // the caller happened to ask about. ──────────────────────────────────────
    const verdicts = adjudicateOutboundEdges(
      'feature',
      'plan-review',
      ambiguous,
      LIVE_CTX,
    );
    expect(verdicts.get('delegate')?.multiMatch).toBe(true);
    expect(verdicts.get('plan')?.multiMatch).toBe(true);
    expect(verdicts.get('blocked')?.multiMatch).toBe(true);

    const planEdge = getEdgeIR('feature', 'plan-review', 'plan');
    expect(planEdge).toBeDefined();
    const decision = adjudicateEdgeDecision(planEdge!, ambiguous, LIVE_CTX);
    expect(decision.multiMatch).toBe(true);
    // The colliding edges are NAMED, in priority order — a report, not a flag.
    expect(decision.matchedEdgeIds).toEqual([
      edgeKey('feature', 'plan-review', 'delegate'),
      edgeKey('feature', 'plan-review', 'plan'),
    ]);
    // Ambiguity is surfaced WITHOUT changing the verdict: route legality still
    // composes with admission downstream.
    expect(decision.verdict).toBe('allow');
  });
});

// A REAL two-edge topology whose highest-priority route is `indeterminate`
// against a state that has not been triaged yet: `triage.symptom` is a presence
// fact, so `factEquals` over it is UNKNOWN (K3) while the symptom is absent.
// The fallback edge below is definitely route-legal, which is exactly the
// fall-through the DR-9 fail-closed rule exists to refuse.
const TRIAGE_TOPOLOGY: readonly WorkflowEdgeIR[] = Object.freeze([
  Object.freeze({
    workflowType: 'feature',
    from: 'triage',
    to: 'regression-repro',
    toPhaseKind: 'GATHER',
    category: 'route-condition',
    legacyGuardId: null,
    routeCondition: compileEdgeCondition(
      { kind: 'factEquals', field: 'triage.symptom', value: 'regression' },
      FACT_DECLARATION,
    ),
    obligation: { kind: 'none' },
  }),
  Object.freeze({
    workflowType: 'feature',
    from: 'triage',
    to: 'generic-investigate',
    toPhaseKind: 'GATHER',
    category: 'route-condition',
    legacyGuardId: null,
    routeCondition: compileEdgeCondition({ kind: 'all', operands: [] }, FACT_DECLARATION),
    obligation: { kind: 'none' },
  }),
] satisfies readonly WorkflowEdgeIR[]);

const FALLBACK_EDGE = TRIAGE_TOPOLOGY[1]!;

describe('DR-34 / DR-9 — fail-closed routing on the live transition path', () => {
  it('SelectEdge_IndeterminateHighestPriority_BlocksRatherThanFallsThrough', () => {
    const untriaged = {};

    // The fallback edge, evaluated IN ISOLATION the way the live path used to,
    // is definitely route-legal — so a per-edge decision admits it.
    expect(
      evaluateEdgeCondition(
        FALLBACK_EDGE.routeCondition,
        projectStateToFacts(untriaged),
      ),
    ).toBe('true');
    // ...while the higher-priority candidate's legality is genuinely UNKNOWN.
    expect(
      evaluateEdgeCondition(
        TRIAGE_TOPOLOGY[0]!.routeCondition,
        projectStateToFacts(untriaged),
      ),
    ).toBe('indeterminate');

    // The LIVE decision body (`adjudicateEdge` — what `observeLiveTransition`
    // calls) now selects over the FULL candidate set and BLOCKS.
    expect(
      adjudicateEdge(FALLBACK_EDGE, untriaged, LIVE_CTX, {
        topology: TRIAGE_TOPOLOGY,
      }),
    ).toBe('indeterminate');

    const blocked = adjudicateEdgeDecision(FALLBACK_EDGE, untriaged, LIVE_CTX, {
      topology: TRIAGE_TOPOLOGY,
    });
    expect(blocked.route).toBe('indeterminate');
    expect(blocked.verdict).toBe('indeterminate');

    // Affordance publication fails closed for the whole phase, too.
    const outbound = adjudicateOutboundEdges('feature', 'triage', untriaged, LIVE_CTX, {
      topology: TRIAGE_TOPOLOGY,
      eventLogAvailable: true,
    });
    expect(outbound.get('generic-investigate')?.verdict).toBe('indeterminate');
    expect(outbound.get('regression-repro')?.verdict).toBe('indeterminate');
  });

  it('a DEFINITELY-false higher-priority candidate is skipped, not blocked', () => {
    // The control that proves the block above comes from the UNKNOWN candidate
    // and not from a blanket denial of the fallback edge.
    expect(
      adjudicateEdge(FALLBACK_EDGE, { triage: { symptom: 'flaky test' } }, LIVE_CTX, {
        topology: TRIAGE_TOPOLOGY,
      }),
    ).toBe('allow');
  });

  it('a definitely-true higher-priority candidate wins the route and is reported', () => {
    const state = { triage: { symptom: 'regression' } };
    // Both candidates are now definitely legal (the fallback is always-legal),
    // so the phase is AMBIGUOUS. Selection resolves the winner deterministically
    // (first in order) and NAMES the collision instead of hiding it — route
    // legality still composes with admission downstream, so the lower-priority
    // edge is not denied on route grounds alone.
    const winner = adjudicateEdgeDecision(TRIAGE_TOPOLOGY[0]!, state, LIVE_CTX, {
      topology: TRIAGE_TOPOLOGY,
    });
    const loser = adjudicateEdgeDecision(FALLBACK_EDGE, state, LIVE_CTX, {
      topology: TRIAGE_TOPOLOGY,
    });
    expect(winner.verdict).toBe('allow');
    expect(loser.verdict).toBe('allow');
    expect(winner.multiMatch).toBe(true);
    expect(loser.multiMatch).toBe(true);
    expect(winner.matchedEdgeIds).toEqual([
      edgeKey('feature', 'triage', 'regression-repro'),
      edgeKey('feature', 'triage', 'generic-investigate'),
    ]);
  });

  it('a NO-MATCH candidate set denies every outbound edge', () => {
    // Same topology, but the fallback route is never-legal: nothing leaving the
    // phase is legal, and the selector says so explicitly.
    const neverLegal: readonly WorkflowEdgeIR[] = [
      TRIAGE_TOPOLOGY[0]!,
      {
        ...FALLBACK_EDGE,
        routeCondition: compileEdgeCondition(
          { kind: 'any', operands: [] },
          FACT_DECLARATION,
        ),
      },
    ];
    const state = { triage: { symptom: 'flaky test' } };
    expect(
      adjudicateEdge(neverLegal[1]!, state, LIVE_CTX, { topology: neverLegal }),
    ).toBe('deny');
  });
});
