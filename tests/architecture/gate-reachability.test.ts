/**
 * Every gate-flagged registry action is reachable, and the counts this wave
 * moved are re-pinned where a reader can quote them.
 *
 * A gate declaration is a promise about a governed repository: this obligation
 * was owed, it was discharged, here is the proof. An action that carries gate
 * metadata but that no runbook chain and no phase-kind resolver can reach makes
 * the first half of that promise and can never make the second. It is not
 * merely unused — it inflates every census taken over "the gate population",
 * and it reads as coverage to anyone auditing the declaration surface.
 *
 * ── Why both populations are derived, never transcribed ─────────────────────
 * A guard that compares two hand-written lists agrees with itself. Both sides
 * here come from live imports: the subject from `TOOL_REGISTRY`, the reachable
 * set from `ALL_RUNBOOKS` plus every sequence `resolveGateSet` can produce over
 * the full resolution-context space. The only hand-written list is the orphan
 * roster below, and it is compared for EQUALITY rather than containment — so it
 * cannot silently absorb a new orphan, and it cannot keep naming one that was
 * fixed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_REGISTRY } from '../../src/registry.js';
import { ALL_RUNBOOKS } from '../../src/runbooks/definitions.js';
import {
  KIND_OBLIGATIONS,
  resolveGateSet,
  type PhaseKind,
  type ResolveGateSetCtx,
} from '../../src/workflow/phase-kind.js';
import { RISK_TIER_DANGER_RANK } from '../../src/workflow/verification-policy-resolver.js';
import type { DesignDepth } from '../../src/workflow/plan-depth-policy.js';
import { BUILT_IN_WORKFLOW_TYPES } from '../../src/workflow/admission/built-in-workflow-ir.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A gate-flagged action, reduced to what reachability is decided on. */
interface GateAction {
  readonly id: string;
  readonly name: string;
  readonly gateClass: string | undefined;
}

/**
 * The surviving orphans, one named reason each.
 *
 * This roster may only SHRINK. It is asserted for equality against the measured
 * orphan set, so adding a gate-flagged action that nothing reaches fails until
 * someone either wires it or argues for it here, and repairing one fails until
 * the entry is deleted.
 */
const DECLARED_ORPHANS: Readonly<Record<string, string>> = {
  'exarchos_orchestrate.check_post_merge':
    'Its CI leg queries the host for a pull request by url, so the only chain that could ' +
    'reasonably carry it — merge-orchestration, which lands a subagent worktree branch onto ' +
    'integration — has no pull request to name. Wiring it there today would record a HIGH ' +
    'finding on every run for the absence of something the flow never creates. It is reachable ' +
    'once the CI leg reports "no pull request" as not-applicable rather than as a failure, or ' +
    'once a chain exists that runs after a provider merge.',
  'exarchos_orchestrate.prepare_review':
    'A review-preparation action that assembles the reviewer prompt rather than producing a ' +
    'verdict; its gate flag marks the advisory carrier, not an obligation any resolver owes. ' +
    'Either the flag is wrong or the action belongs in the review chain — unresolved, and out ' +
    'of scope for the retirement pass that pinned this roster.',
  'exarchos_orchestrate.discover_bridge':
    'The discovery-to-plan bridge, bound to the plan phase and invoked by the discover skill ' +
    'directly rather than through a chain. Same open question as the row above: the gate flag ' +
    'claims an obligation the plan-structure resolver does not list.',
};

/** Gate-flagged actions, straight off the live registry. */
function gateFlaggedActions(): readonly GateAction[] {
  const out: GateAction[] = [];
  for (const tool of TOOL_REGISTRY) {
    for (const action of tool.actions) {
      if (action.gate === undefined) continue;
      out.push({ id: `${tool.name}.${action.name}`, name: action.name, gateClass: action.gate.gateClass });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Every `tool.action` pair any runbook chain steps through. */
function runbookStepActions(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const runbook of ALL_RUNBOOKS) {
    for (const step of runbook.steps) out.add(`${step.tool}.${step.action}`);
  }
  return out;
}

/**
 * Every gate name any resolver can produce, over the WHOLE resolution-context
 * space rather than one sampled ctx.
 *
 * Resolver membership is fixed by phase kind, but resolver OUTPUT depends on the
 * context — the ladder on risk tier and boundary-touching, plan structure on
 * design depth, the review roster on workflow type and tier. Sampling one ctx
 * would leave the tier- and depth-coupled obligations out of the reachable set
 * and report their producers as orphans. Each axis is enumerated from a live
 * source so a new tier, kind or workflow type widens this automatically; the
 * depth axis is keyed through `Record<DesignDepth, …>` so a fourth depth is a
 * compile error rather than a silently missing column.
 */
function resolvableGateNames(): ReadonlySet<string> {
  const depths = Object.keys({
    thin: true, standard: true, deep: true,
  } satisfies Record<DesignDepth, true>) as readonly DesignDepth[];
  const tiers = Object.keys(RISK_TIER_DANGER_RANK) as readonly ResolveGateSetCtx['riskTier'][];
  const kinds = Object.keys(KIND_OBLIGATIONS) as readonly PhaseKind[];
  const workflowTypes: readonly (string | undefined)[] = [...BUILT_IN_WORKFLOW_TYPES, undefined];

  const names = new Set<string>();
  for (const kind of kinds) {
    for (const riskTier of tiers) {
      for (const designDepth of [...depths, undefined]) {
        for (const workflowType of workflowTypes) {
          for (const boundaryTouching of [true, false]) {
            const ctx: ResolveGateSetCtx = {
              riskTier,
              boundaryTouching,
              ...(designDepth !== undefined ? { designDepth } : {}),
              ...(workflowType !== undefined ? { workflowType } : {}),
            };
            for (const resolved of resolveGateSet(kind, ctx)) names.add(resolved.gate);
          }
        }
      }
    }
  }
  return names;
}

/**
 * The reachability predicate.
 *
 * Three ways in, because the resolvers speak three vocabularies: the ladder and
 * the plan sequence name ACTIONS, the provider-backed classes name a
 * `gateClass`, and a chain names a `tool.action` pair. All three resolve to the
 * same question — can anything actually cause this gate to run.
 */
function isReachable(
  action: GateAction,
  chains: ReadonlySet<string>,
  resolved: ReadonlySet<string>,
): boolean {
  if (chains.has(action.id)) return true;
  if (resolved.has(action.name)) return true;
  return action.gateClass !== undefined && resolved.has(action.gateClass);
}

function findOrphans(
  actions: readonly GateAction[],
  chains: ReadonlySet<string>,
  resolved: ReadonlySet<string>,
): readonly string[] {
  return actions.filter((a) => !isReachable(a, chains, resolved)).map((a) => a.id).sort();
}

/**
 * The assertion as a callable, so the negative fixtures can RUN it.
 *
 * An inline `expect` cannot be put through a subject built to fail it, and a
 * fixture that only re-checks its own precondition proves nothing about the
 * assertion it was written to trip.
 */
function assertEveryGateFlaggedActionIsReachable(
  actions: readonly GateAction[],
  chains: ReadonlySet<string>,
  resolved: ReadonlySet<string>,
  declared: Readonly<Record<string, string>>,
): void {
  if (actions.length === 0) {
    throw new Error(
      'the gate-flagged population is empty — a reachability check over no subjects passes ' +
        'without checking anything',
    );
  }
  if (resolved.size === 0 && chains.size === 0) {
    throw new Error(
      'neither chains nor resolvers produced anything — every action would read as an orphan, ' +
        'which is a broken derivation rather than a finding',
    );
  }
  const undeclared = findOrphans(actions, chains, resolved).filter((id) => declared[id] === undefined);
  if (undeclared.length > 0) {
    throw new Error(
      `gate-flagged action(s) no runbook chain and no phase-kind resolver can reach: ` +
        `${undeclared.join(', ')}. Wire the gate into a chain or a resolver sequence, retire it, ` +
        'or add it to the orphan roster with the reason it is still declared.',
    );
  }
}

/** Own-level, non-test file count — the same measure the locality cap uses. */
function gateModuleCount(): number {
  const dir = path.join(REPO_ROOT, 'src/verbs/gates');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !/\.(test|bench)\.[cm]?[jt]s$|\.test\.sh$/.test(e.name)).length;
}

describe('gate reachability', () => {
  const actions = gateFlaggedActions();
  const chains = runbookStepActions();
  const resolved = resolvableGateNames();

  it('Denominator_IsAsserted', () => {
    // Everything below is vacuously true over an empty subject. These are the
    // floors that say the derivation resolved something real — and they are
    // floors, not pins, so retiring a gate does not redden them.
    expect(actions.length, 'no action in the registry carries gate metadata').toBeGreaterThanOrEqual(15);
    expect(resolved.size, 'no resolver produced a gate name').toBeGreaterThanOrEqual(15);
    expect(chains.size, 'no runbook step resolved to a tool.action pair').toBeGreaterThanOrEqual(20);

    // Cardinality the other way, so "everything is reachable" cannot be
    // satisfied by a resolver set that contains everything.
    expect(resolved.size).toBeLessThan(actions.length + chains.size);

    // The ctx sweep is load-bearing: the tier-coupled review dimension and the
    // depth-coupled plan gate only appear under part of the space. Sampling one
    // ctx would drop both and report their producers as orphans.
    expect(resolved.has('mutation-adequacy'), 'the HIGH-tier review dimension is missing').toBe(true);
    expect(resolved.has('check_exploration_depth'), 'the deep-depth plan gate is missing').toBe(true);
  });

  it('EveryGateFlaggedAction_IsReachable', () => {
    expect(() =>
      assertEveryGateFlaggedActionIsReachable(actions, chains, resolved, DECLARED_ORPHANS),
    ).not.toThrow();
  });

  it('SeededUnreachableGate_IsNamed', () => {
    // Teeth. A predicate nothing can violate is decoration — so add one
    // gate-flagged action that no chain names, no resolver produces, and whose
    // gateClass nobody owns, and require the guard to name it.
    const seeded: GateAction[] = [
      ...actions,
      { id: 'exarchos_orchestrate.__seeded_unreachable__', name: '__seeded_unreachable__', gateClass: undefined },
    ];
    expect(() =>
      assertEveryGateFlaggedActionIsReachable(seeded, chains, resolved, DECLARED_ORPHANS),
    ).toThrow(/__seeded_unreachable__/);

    // And the coarser loss: a real gate whose chain step was deleted. Drop the
    // review-verdict chain entry and its gateClass from both derivations and the
    // guard must report the producer, not shrug.
    const narrowedChains = new Set([...chains].filter((id) => !id.endsWith('.check_review_verdict')));
    const narrowedResolved = new Set([...resolved].filter((n) => n !== 'review-verdict'));
    expect(() =>
      assertEveryGateFlaggedActionIsReachable(actions, narrowedChains, narrowedResolved, DECLARED_ORPHANS),
    ).toThrow(/check_review_verdict/);
  });

  it('EmptyGatePopulation_FailsTheGuard', () => {
    // The property this file's own denominator protects, executed rather than
    // asserted about: a guard run over nothing must fail, not pass.
    expect(() => assertEveryGateFlaggedActionIsReachable([], chains, resolved, DECLARED_ORPHANS)).toThrow(
      /population is empty/,
    );
    expect(() =>
      assertEveryGateFlaggedActionIsReachable(actions, new Set(), new Set(), DECLARED_ORPHANS),
    ).toThrow(/broken derivation/);
  });

  it('OrphanCount_IsPinnedAtZeroOrDeclared', () => {
    // EQUALITY, not containment. Containment lets the roster keep naming an
    // orphan that was wired — dead cover of exactly the kind the locality
    // exemptions exist to prevent.
    expect(findOrphans(actions, chains, resolved)).toEqual(Object.keys(DECLARED_ORPHANS).sort());

    const registered = new Set(actions.map((a) => a.id));
    for (const [id, reason] of Object.entries(DECLARED_ORPHANS)) {
      expect(registered.has(id), `${id} is on the orphan roster but is not a gate-flagged action`).toBe(true);
      expect(reason.length, `${id} has no stated reason`).toBeGreaterThan(40);
    }
  });

  it('GateDirectoryCap_IsRepinnedAfterShrinkage', () => {
    // The locality exemption for the gate directory says the count may shrink
    // freely and may not grow. That is only true while the pin tracks reality:
    // a pin left above the live count is unspent headroom the next addition can
    // take without argument, which is what "re-pinned after shrinkage" means.
    const locality = fs.readFileSync(path.join(REPO_ROOT, 'tests/architecture/locality.test.ts'), 'utf8');
    const entry = /'src\/verbs\/gates':\s*\{[\s\S]*?grantedAt:\s*(\d+)/.exec(locality);
    expect(entry, 'the gate-directory locality exemption is gone — the cap is unpinned').not.toBeNull();

    const pinned = Number(entry?.[1]);
    const live = gateModuleCount();
    expect(live, 'the gate directory resolved to nothing').toBeGreaterThan(10);
    expect(
      pinned,
      `src/verbs/gates holds ${live} modules but its exemption is pinned at ${pinned}. Re-pin it ` +
        'downward: the difference is headroom a future addition spends without being argued for.',
    ).toBe(live);
  });
});
