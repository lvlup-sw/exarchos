// ─── DR-5 (T-08): a bare boolean cannot satisfy an artifact requirement ──────
//
// `makeArtifactGuard` used to evaluate `artifacts[field] != null`, so
// `{"artifacts":{"plan":true}}` — or `false`, `0`, `''`, `'   '`, `{}` — passed
// a phase gate that exists to require a REAL artifact reference. The admission
// algebra already knew better (`artifacts.planNonEmpty` demands a trimmed
// non-empty string), but that rejection lived only in the shadow/validation
// layer; the shipped transition path bypassed it.
//
// These tests assert the rejection on the SHIPPED TRANSITION PATH, i.e. the
// exact primitive production calls:
//
//   exarchos_workflow { action: 'transition' | 'set' }   (workflow/tools.ts)
//     └─ hsmTransitionGuard.attempt(...)                 (hsm-transition-guard.ts)
//         └─ executeTransition(hsm, state, targetPhase)  (state-machine.ts)
//             └─ transition.guard.evaluate(state)        (guards.ts)
//
// `DefaultHSMTransitionGuard` is the REAL collaborator (no mocked guard, no
// mocked HSM). `eventStore: null` is the documented pure-evaluation mode of
// `GuardContext` — it makes the test hermetic (no temp dirs, no I/O) while
// still walking the whole production decision path.
//
// Every track that routes an edge through `makeArtifactGuard` is enumerated in
// ARTIFACT_EDGES below — feature, refactor, debug (x2) and discovery — plus
// oneshot, which reaches the same contract through `oneshotPlanSet` and is
// pinned here so the two surfaces cannot drift apart again.

import { describe, expect, it } from 'vitest';

import { DefaultHSMTransitionGuard } from './hsm-transition-guard.js';
import { guards } from './guards.js';
import { createFeatureHSM, createDebugHSM, createRefactorHSM, createDiscoveryHSM, createOneshotHSM } from './hsm-definitions.js';
import type { HSMDefinition } from './types.js';

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
 * EVERY built-in track whose shipped transition path gates on an artifact
 * reference. Derived by enumerating `makeArtifactGuard` call sites in guards.ts
 * (design/plan/rca/fixDesign/report) and matching them to the HSM edges that
 * actually reference them in hsm-definitions.ts. `designArtifactExists` is
 * defined but wired to NO edge (retired with `ideate` in DR-4/#1581), so it has
 * no shipped-path row here — it is covered by the direct-evaluate test below.
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
  {
    // Not a `makeArtifactGuard` edge, but the SAME contract over the same
    // state field. Enumerated so "rejected on every track" is literally true
    // and so a future loosening of either surface is caught here.
    workflowType: 'oneshot',
    from: 'plan',
    to: 'implementing',
    field: 'plan',
    guardId: 'oneshot-plan-set',
    validValue: 'docs/specs/2026-08-04-small.md',
  },
];

/** Structural check: the enumeration above matches the real HSM definitions. */
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

/**
 * Drives the SHIPPED transition path end-to-end and returns the production
 * outcome. No guard/HSM is stubbed; `eventStore: null` only skips emission.
 */
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

// ─── The named acceptance tests ──────────────────────────────────────────────

describe('ArtifactGuard_BareBooleanPlan_RejectsRequirement', () => {
  it.each(ARTIFACT_EDGES.map((e) => [`${e.workflowType}:${e.from}→${e.to}`, e] as const))(
    'ArtifactGuard_BareBooleanPlan_RejectsRequirement — %s',
    async (_label, edge) => {
      // `true` is the headline defect: a bare boolean satisfied `!= null`.
      await expectRejected(edge, true, 'true');
      // `false` was ALSO admitted by `!= null` — the loose check never even
      // looked at truthiness, so the "boolean" defect is two-sided.
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

// ─── Supporting contract: the full non-artifact-reference value space ────────

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
  // Liveness control. Without this the tightened guard could be a
  // permanently-closed gate and the rejection tests would still pass.
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
  // `makeArtifactGuard` has a legacy fallback onto the top-level `state[field]`.
  // Tightening only the `artifacts.*` branch would leave the bypass open.
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

// ─── Retired-but-defined guard: same contract, evaluated directly ────────────

describe('ArtifactGuard_DesignArtifactExists_RequiresTypedReference', () => {
  // `designArtifactExists` is produced by `makeArtifactGuard` but wired to no
  // edge today. DR-5 says a bare boolean cannot satisfy a requirement — so the
  // factory itself must reject, not just the currently-wired edges. Evaluated
  // directly because there is no shipped edge to drive.
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

// ─── Enumeration integrity ───────────────────────────────────────────────────

describe('ArtifactGuard_EdgeEnumeration_MatchesTheRealHSMs', () => {
  // Pins the parameterisation to reality: if a track renames a phase or moves
  // an artifact edge, this fails instead of silently under-covering a track.
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
