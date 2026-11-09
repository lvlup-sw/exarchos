// These tests check the admission IR that derives from the built-in definitions. The golden
// recorded the hand-written IR before the definition files existed. So each derived edge must
// equal its golden edge, field for field. A changed guard id in a definition changes only its edge.
//
// @oracle-sources: ../__fixtures__/built-in.golden.json, ../../../../src/workflow/admission/built-in-workflow-ir.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_WORKFLOW_IR,
  BUILT_IN_WORKFLOW_TYPES,
  TASKS_COMPLETE_CONDITION,
  deriveWorkflowEdges,
  edgesForWorkflow,
  getEdgeIR,
  type EdgeObligation,
  type WorkflowEdgeIR,
} from '../../../../src/workflow/admission/built-in-workflow-ir.js';
import { serializeEdgeCondition } from '../../../../src/workflow/admission/edge-condition.js';
import { builtInDefinition } from '../../../../src/workflow/definitions/built-in.js';

/** The golden that the code before the definition files wrote. No test writes it. */
const GOLDEN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../__fixtures__/built-in.golden.json',
);

/** The number of edges of each built-in type, in roster order. */
const EDGE_COUNTS: readonly number[] = [12, 16, 17, 4, 2];

/** True when the value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the IR edges that the golden recorded for one built-in type. */
function goldenEdges(type: string): readonly unknown[] {
  const golden: unknown = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const workflows = isRecord(golden) ? golden.workflows : undefined;
  const workflow = isRecord(workflows) ? workflows[type] : undefined;
  const edges = isRecord(workflow) ? workflow.irEdges : undefined;
  if (!Array.isArray(edges)) throw new Error(`the golden has no IR edges for '${type}'`);
  const list: readonly unknown[] = edges;
  return list;
}

/** Returns the JSON form of an obligation, with the node of its presence probe. */
function obligationJson(obligation: EdgeObligation): Record<string, unknown> {
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

/** Returns one IR edge in the form of a golden edge. */
function edgeJson(edge: WorkflowEdgeIR): Record<string, unknown> {
  return {
    from: edge.from,
    to: edge.to,
    toPhaseKind: edge.toPhaseKind,
    category: edge.category,
    legacyGuardId: edge.legacyGuardId,
    route: edge.routeCondition.node,
    routeSerialized: serializeEdgeCondition(edge.routeCondition),
    obligation: obligationJson(edge.obligation),
  };
}

/** Returns a mutable copy of the feature definition. */
function featureClone(): ReturnType<typeof builtInDefinition> {
  return structuredClone(builtInDefinition('feature'));
}

describe('the admission IR that derives from the built-in definitions', () => {
  /**
   * The IR holds 51 edges, with the types in roster order and 12, 16, 17, 4 and 2 edges.
   * Each edge equals its golden edge, field for field.
   */
  it('DerivedIR_TheEdges_Are51In12_16_17_4_2', () => {
    expect(BUILT_IN_WORKFLOW_IR).toHaveLength(51);
    const expectedTypes = BUILT_IN_WORKFLOW_TYPES.flatMap((type, index) =>
      Array.from({ length: EDGE_COUNTS[index] ?? 0 }, () => type),
    );
    expect(BUILT_IN_WORKFLOW_IR.map((edge) => edge.workflowType)).toEqual(expectedTypes);
    for (const type of BUILT_IN_WORKFLOW_TYPES) {
      const golden = goldenEdges(type);
      expect(edgesForWorkflow(type).map(edgeJson), type).toEqual(golden);
      expect(golden.length, type).toBeGreaterThan(0);
    }
  });

  /** The capsule condition that every task is complete equals the gate presence of the refactor delegate edge. */
  it('DerivedIR_TasksCompleteCondition_IsTheOverhaulDelegateGatePresence', () => {
    const obligation = getEdgeIR('refactor', 'overhaul-delegate', 'overhaul-review')?.obligation;
    expect(obligation?.kind).toBe('gate');
    if (obligation?.kind !== 'gate') return;
    expect(obligation.presence.node).toEqual(TASKS_COMPLETE_CONDITION.node);
    expect(serializeEdgeCondition(obligation.presence)).toBe(serializeEdgeCondition(TASKS_COMPLETE_CONDITION));
    expect(obligation.presence.declaration).toEqual(TASKS_COMPLETE_CONDITION.declaration);
  });

  /** A clone of feature with another guard id on its first edge changes that edge only. */
  it('DerivedIR_ASwappedGuardId_ChangesOnlyThatEdge', () => {
    const clone = featureClone();
    const authored = clone.exarchos.edges['plan->plan-review'];
    expect(authored?.guardId).toBe('plan-artifact-exists');
    if (authored === undefined) return;
    authored.guardId = 'design-artifact-exists';

    const swapped = deriveWorkflowEdges('feature', clone);
    const live = edgesForWorkflow('feature');
    expect(swapped).toHaveLength(live.length);
    const changed = swapped
      .filter((edge, index) => !isDeepStrictEqual(edge, live[index]))
      .map((edge) => `${edge.from}->${edge.to}`);
    expect(changed).toEqual(['plan->plan-review']);
    expect(swapped[0]?.legacyGuardId).toBe('design-artifact-exists');
    expect(live[0]?.legacyGuardId).toBe('plan-artifact-exists');
    expect({ ...swapped[0], legacyGuardId: 'plan-artifact-exists' }).toEqual(live[0]);
  });

  /** A route that names a fact outside the vocabulary stops the derivation with an error that names the edge. */
  it('DerivedIR_AnUndeclaredFactInARoute_ThrowsAndNamesTheEdge', () => {
    const clone = featureClone();
    const authored = clone.exarchos.edges['review->delegate'];
    expect(authored?.route).toBeDefined();
    if (authored === undefined) return;
    authored.route = { kind: 'factEquals', field: 'reviews.noSuchFact', value: true };

    expect(() => deriveWorkflowEdges('feature', clone)).toThrow(
      /the route of the built-in edge 'feature review->delegate' does not compile/,
    );
    expect(() => deriveWorkflowEdges('feature', featureClone())).not.toThrow();
  });
});
