/**
 * An artifact requirement must reject every value that is not a non-blank string. A bare boolean,
 * a number, an object or a blank string must not pass a phase gate.
 *
 * The tests drive the production path: `DefaultHSMTransitionGuard.attempt` calls
 * `executeTransition`, which calls the guard of the edge. No guard and no HSM is mocked.
 * `eventStore: null` is the pure-evaluation mode of `GuardContext`, so the tests do no I/O.
 */

import { describe, expect, it } from 'vitest';

import { DefaultHSMTransitionGuard } from '../../../src/workflow/hsm-transition-guard.js';
import { guards } from '../../../src/workflow/guards.js';
import { createFeatureHSM, createDebugHSM, createRefactorHSM, createDiscoveryHSM, createOneshotHSM } from '../../../src/workflow/hsm-definitions.js';
import type { HSMDefinition } from '../../../src/workflow/types.js';

interface ArtifactEdge {
  /** Workflow track id, as registered in the state machine. */
  readonly workflowType: string;
  readonly from: string;
  readonly to: string;
  /** `state.artifacts.<field>` the guard reads. */
  readonly field: string;
  /** Guard id surfaced in the GUARD_FAILED envelope. */
  readonly guardId: string;
  /** A legitimate artifact reference for this field (positive control). */
  readonly validValue: string;
}

/**
 * Each HSM edge whose guard comes from `makeArtifactGuard`, plus the oneshot plan edge.
 * `designArtifactExists` is wired to no edge, so a direct-evaluate test below covers it.
 */
const ARTIFACT_EDGES: readonly ArtifactEdge[] = [
  {
    workflowType: 'feature',
    from: 'plan',
    to: 'plan-review',
    field: 'plan',
    guardId: 'plan-artifact-exists',
    validValue: 'docs/specs/2026-08-04-thing.md',
  },
  {
    workflowType: 'refactor',
    from: 'overhaul-plan',
    to: 'overhaul-plan-review',
    field: 'plan',
    guardId: 'plan-artifact-exists',
    validValue: 'docs/specs/2026-08-04-overhaul.md',
  },
  {
    workflowType: 'debug',
    from: 'rca',
    to: 'design',
    field: 'rca',
    guardId: 'rca-document-complete',
    validValue: 'docs/rca/2026-08-04-outage.md',
  },
  {
    workflowType: 'debug',
    from: 'design',
    to: 'debug-implement',
    field: 'fixDesign',
    guardId: 'fix-design-complete',
    validValue: 'docs/designs/2026-08-04-fix.md',
  },
  {
    workflowType: 'discovery',
    from: 'synthesizing',
    to: 'completed',
    field: 'report',
    guardId: 'report-artifact-exists',
    validValue: 'docs/research/2026-08-04-report.md',
  },
  /**
   * The oneshot edge uses `oneshotPlanSet`, not `makeArtifactGuard`. It applies the same contract
   * to the same field, so a looser check on either guard fails here.
   */
  {
    workflowType: 'oneshot',
    from: 'plan',
    to: 'implementing',
    field: 'plan',
    guardId: 'oneshot-plan-set',
    validValue: 'docs/specs/2026-08-04-small.md',
  },
];

/** Maps each track to its HSM factory, so a test can check `ARTIFACT_EDGES` against the real HSMs. */
const HSM_BY_TRACK: Readonly<Record<string, () => HSMDefinition>> = {
  feature: createFeatureHSM,
  refactor: createRefactorHSM,
  debug: createDebugHSM,
  discovery: createDiscoveryHSM,
  oneshot: createOneshotHSM,
};

const transitionGuard = new DefaultHSMTransitionGuard();

function stateFor(edge: ArtifactEdge, value: unknown): Record<string, unknown> {
  return {
    featureId: 'dr5-artifact-guard',
    phase: edge.from,
    workflowType: edge.workflowType,
    artifacts: { [edge.field]: value },
  };
}

/** Runs the production transition path and returns its outcome. `eventStore: null` only skips the emission. */
async function attempt(
  edge: ArtifactEdge,
  state: Record<string, unknown>,
): Promise<Awaited<ReturnType<DefaultHSMTransitionGuard['attempt']>>> {
  return transitionGuard.attempt(state.featureId as string, edge.from, edge.to, {
    state,
    workflowType: edge.workflowType,
    eventStore: null,
  });
}

async function expectRejected(
  edge: ArtifactEdge,
  value: unknown,
  label: string,
): Promise<void> {
  const result = await attempt(edge, stateFor(edge, value));
  const where = `${edge.workflowType}:${edge.from}→${edge.to} (artifacts.${edge.field} = ${label})`;
  expect(result.ok, `${where} must be REFUSED on the shipped transition path`).toBe(false);
  if (result.ok === false && result.reason === 'guard-failed') {
    expect(result.guardId, `${where} must be refused by ${edge.guardId}`).toBe(edge.guardId);
    expect(result.errorCode, `${where} must surface GUARD_FAILED`).toBe('GUARD_FAILED');
  } else {
    throw new Error(`${where} was refused for the wrong reason: ${JSON.stringify(result)}`);
  }
}

/** `true` and `false` must both fail. A `!= null` check admits both values. */
describe('ArtifactGuard_BareBooleanPlan_RejectsRequirement', () => {
  it.each(ARTIFACT_EDGES.map((e) => [`${e.workflowType}:${e.from}→${e.to}`, e] as const))(
    'ArtifactGuard_BareBooleanPlan_RejectsRequirement — %s',
    async (_label, edge) => {
      await expectRejected(edge, true, 'true');
      await expectRejected(edge, false, 'false');
    },
  );
});

describe('ArtifactGuard_WhitespaceOnlyPlan_RejectsRequirement', () => {
  it.each(ARTIFACT_EDGES.map((e) => [`${e.workflowType}:${e.from}→${e.to}`, e] as const))(
    'ArtifactGuard_WhitespaceOnlyPlan_RejectsRequirement — %s',
    async (_label, edge) => {
      await expectRejected(edge, '   ', "'   '");
      await expectRejected(edge, '\n\t\n ', "'\\n\\t\\n '");
      await expectRejected(edge, '', "''");
    },
  );
});

describe('ArtifactGuard_NonStringArtifactValues_RejectedOnEveryTrack', () => {
  const NON_REFERENCES: ReadonlyArray<readonly [string, unknown]> = [
    ['number 1', 1],
    ['number 0', 0],
    ['plain object', {}],
    ['object with path field', { path: 'docs/specs/x.md' }],
    ['array', ['docs/specs/x.md']],
  ];

  it.each(ARTIFACT_EDGES.map((e) => [`${e.workflowType}:${e.from}→${e.to}`, e] as const))(
    'rejects every non-string artifact value — %s',
    async (_label, edge) => {
      for (const [label, value] of NON_REFERENCES) {
        await expectRejected(edge, value, label);
      }
    },
  );
});

describe('ArtifactGuard_TypedArtifactReference_AdmittedOnEveryTrack', () => {
  /** Liveness control. Without it, a gate that is always closed passes every rejection test. */
  it.each(ARTIFACT_EDGES.map((e) => [`${e.workflowType}:${e.from}→${e.to}`, e] as const))(
    'admits a real artifact path — %s',
    async (_label, edge) => {
      const result = await attempt(edge, stateFor(edge, edge.validValue));
      expect(
        result.ok,
        `${edge.workflowType}:${edge.from}→${edge.to} must ADMIT a real artifact path`,
      ).toBe(true);
    },
  );
});

describe('ArtifactGuard_TopLevelFallbackField_RequiresTypedReference', () => {
  /** `makeArtifactGuard` also reads the top-level `state[field]`. That fallback must apply the same check. */
  it.each(ARTIFACT_EDGES.filter((e) => e.guardId !== 'oneshot-plan-set').map(
    (e) => [`${e.workflowType}:${e.from}→${e.to}`, e] as const,
  ))('rejects a bare boolean in the top-level fallback — %s', async (_label, edge) => {
    const state: Record<string, unknown> = {
      featureId: 'dr5-artifact-guard',
      phase: edge.from,
      workflowType: edge.workflowType,
      [edge.field]: true,
    };
    const result = await attempt(edge, state);
    expect(
      result.ok,
      `${edge.workflowType}: top-level ${edge.field}=true must not satisfy ${edge.guardId}`,
    ).toBe(false);
  });

  it.each(ARTIFACT_EDGES.filter((e) => e.guardId !== 'oneshot-plan-set').map(
    (e) => [`${e.workflowType}:${e.from}→${e.to}`, e] as const,
  ))('still admits a real path in the top-level fallback — %s', async (_label, edge) => {
    const state: Record<string, unknown> = {
      featureId: 'dr5-artifact-guard',
      phase: edge.from,
      workflowType: edge.workflowType,
      [edge.field]: edge.validValue,
    };
    const result = await attempt(edge, state);
    expect(result.ok).toBe(true);
  });
});

describe('ArtifactGuard_DesignArtifactExists_RequiresTypedReference', () => {
  /**
   * `designArtifactExists` comes from `makeArtifactGuard` but is wired to no edge. The factory
   * itself must reject, so the test evaluates the guard directly.
   */
  it('rejects bare booleans and whitespace-only values', () => {
    for (const bad of [true, false, 0, 1, {}, [], '', '   ', '\n\t ']) {
      expect(
        guards.designArtifactExists.evaluate({ artifacts: { design: bad } }),
        `artifacts.design = ${JSON.stringify(bad)} must not satisfy the guard`,
      ).not.toBe(true);
    }
  });

  it('admits a real design path', () => {
    expect(
      guards.designArtifactExists.evaluate({ artifacts: { design: 'docs/designs/x.md' } }),
    ).toBe(true);
  });
});

describe('ArtifactGuard_EdgeEnumeration_MatchesTheRealHSMs', () => {
  /** If a track renames a phase or moves an artifact edge, this test fails and shows the gap. */
  it.each(ARTIFACT_EDGES.map((e) => [`${e.workflowType}:${e.from}→${e.to}`, e] as const))(
    'edge exists with the expected guard — %s',
    (_label, edge) => {
      const hsm = HSM_BY_TRACK[edge.workflowType]!();
      const t = hsm.transitions.find((x) => x.from === edge.from && x.to === edge.to);
      expect(t, `${edge.workflowType} has no ${edge.from}→${edge.to} edge`).toBeDefined();
      expect(t!.guard!.id).toBe(edge.guardId);
    },
  );

  it('covers every track that wires a makeArtifactGuard-produced guard', () => {
    const artifactGuardIds = new Set([
      'plan-artifact-exists',
      'design-artifact-exists',
      'rca-document-complete',
      'fix-design-complete',
      'report-artifact-exists',
    ]);
    const wired = new Set<string>();
    for (const [track, make] of Object.entries(HSM_BY_TRACK)) {
      for (const t of make().transitions) {
        if (t.guard && artifactGuardIds.has(t.guard.id)) {
          wired.add(`${track}:${t.from}→${t.to}`);
        }
      }
    }
    const covered = new Set(
      ARTIFACT_EDGES.map((e) => `${e.workflowType}:${e.from}→${e.to}`),
    );
    for (const edge of wired) {
      expect(covered.has(edge), `uncovered artifact edge: ${edge}`).toBe(true);
    }
    expect(wired.size).toBeGreaterThan(0);
  });
});
