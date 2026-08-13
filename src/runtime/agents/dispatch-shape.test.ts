// ─── Posture → dispatch-shape contract (DR-25) ─────────────────────────────
//
// Three properties, one per acceptance criterion:
//
//   1. TOTALITY — every DECLARED posture has exactly one dispatch entry. The
//      enumeration reads `AgentPosture.options` (the Zod declaration in
//      `spec.ts`), never a list retyped here. A retyped list would make the
//      test vacuous, which is precisely the defect the surrounding program
//      exists to eliminate.
//   2. BINDING — `prepare_review` actually emits the anonymous-async shape for
//      its `read-only` posture, in production composition (the real handler,
//      real event store), not against a mock.
//   3. SELF-TEST — a seeded provisioning result whose `dispatch` contradicts
//      its `posture` is REJECTED, so guard-execution failure cannot pass as
//      success.
//
// Plus the INV-4 error path: a shape naming a capability the runtime does not
// declare resolves to the DECLARED fallback, never to a silent degrade.
//
// ── The two authorities behind the totality census (DR-30) ─────────────────
//
// The census claim is "the dispatch table's key set == the declared posture
// vocabulary". Its two sides must not be one authority wearing two names:
//
//   `./spec.ts`           — the Zod `AgentPosture` enum. Runtime-enumerable,
//                           and the declaration every inbound spec is parsed
//                           against.
//   `./dispatch-shape.ts` — the hand-written table, whose key set is read off
//                           the frozen object at runtime.
//
// They are genuinely independent: the table is typed off the interface twin in
// `types.ts`, so `dispatch-shape.ts` never reaches `spec.ts` in the import
// graph. A posture added to one declaration and not the other turns this suite
// RED rather than silently agreeing with itself.
//
// @oracle-sources: ./spec.ts, ./dispatch-shape.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  POSTURE_DISPATCH_MAP,
  DISPATCH_SHAPE_UNSUPPORTED,
  posturesWithDispatchShape,
  dispatchShapeFor,
  resolveDispatchShape,
  validateDispatchShape,
  validateProvisionedDispatch,
  type DispatchLaunch,
  type DispatchShape,
  type RuntimeCapabilityDeclaration,
} from './dispatch-shape.js';
import { AgentPosture } from './spec.js';
import { Capability } from './capabilities.js';
import { buildSupportMap } from './adapters/support-levels.js';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { handlePrepareReview } from '../../verbs/team/prepare-review.js';
import { EventStore } from '../../events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import type { ToolResult } from '../../format.js';

// ─── 1. Totality over the DECLARED posture set ──────────────────────────────

describe('DispatchShape totality (DR-25)', () => {
  it('DispatchShape_EveryDeclaredPosture_HasExactlyOneEntry', () => {
    // AUTHORITY 1 — the declared vocabulary, read from the Zod enum in
    // `spec.ts`. NOT retyped here: a retyped list would compare the table
    // against a copy of itself and prove nothing.
    const declared = AgentPosture.options;
    expect(declared.length).toBeGreaterThan(0);

    // AUTHORITY 2 — the table's OWN key set, read off the frozen object. The
    // table is typed from `types.ts`, so it never reaches `spec.ts`: the two
    // sides of this census can genuinely disagree.
    const entryKeys = Object.keys(POSTURE_DISPATCH_MAP);
    expect(posturesWithDispatchShape()).toEqual(entryKeys);

    // (a) Every DECLARED posture has an entry. A posture added to the enum
    //     without a table row fails here — the mapping cannot be partial.
    for (const posture of declared) {
      expect(
        Object.prototype.hasOwnProperty.call(POSTURE_DISPATCH_MAP, posture),
        `posture "${posture}" is declared in AgentPosture but has no dispatch entry`,
      ).toBe(true);
      expect(dispatchShapeFor(posture)).toBeDefined();
    }

    // (b) EXACTLY one — no extra rows for postures the enum does not declare.
    expect([...entryKeys].sort()).toEqual([...declared].sort());
    expect(entryKeys.length).toBe(declared.length);

    // (c) Each entry self-identifies as its own key, so a copy-paste row that
    //     kept a neighbour's posture cannot masquerade as a distinct entry.
    for (const posture of declared) {
      expect(dispatchShapeFor(posture).posture).toBe(posture);
    }

    // (d) The three shapes are genuinely distinct launches — a table where two
    //     postures collapse to the same launch would satisfy (a)-(c) while
    //     binding nothing.
    const launches = declared.map((p) => {
      const s = dispatchShapeFor(p);
      return `${s.subagent}|${s.naming}|${s.workspace}`;
    });
    expect(new Set(launches).size).toBe(declared.length);

    // (e) Every required capability is drawn from the declared vocabulary, and
    //     each entry actually requires something (an empty `requires` would
    //     make the INV-4 resolution unfalsifiable).
    for (const posture of declared) {
      const shape = dispatchShapeFor(posture);
      expect(shape.requires.length).toBeGreaterThan(0);
      for (const cap of shape.requires) {
        expect(Capability.options).toContain(cap);
      }
    }
  });

  it('DispatchShape_DeclaredPostures_BindTheDocumentedLaunchShapes', () => {
    // The three rows DR-25 names, pinned. This is the policy itself; if it
    // changes, the change must be deliberate.
    expect(dispatchShapeFor('read-only')).toMatchObject({
      subagent: true,
      naming: 'anonymous',
      workspace: 'inherited',
    });
    expect(dispatchShapeFor('task-isolated')).toMatchObject({
      subagent: true,
      naming: 'named',
      workspace: 'worktree',
    });
    expect(dispatchShapeFor('shared-mutating')).toMatchObject({
      subagent: false,
      workspace: 'main-worktree',
    });
  });
});

// ─── 2. The verb actually emits the bound shape ─────────────────────────────

describe('prepare_review emits its bound dispatch shape (DR-25)', () => {
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'dispatch-shape-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    eventStore.close();
    await rmrfAsync(stateDir);
  });

  const dataOf = (result: ToolResult): unknown => {
    expect(result.success).toBe(true);
    return result.data;
  };

  it('PrepareReview_ReadOnlyPosture_EmitsAnonymousAsyncShape', async () => {
    const data = dataOf(
      await handlePrepareReview(
        {
          featureId: 'dr25-plan-review',
          scope: 'plan',
          artifact: 'docs/specs/2026-08-06-internal-mechanics-overhaul.md',
        },
        stateDir,
        eventStore,
      ),
    );

    // Validated through the SAME structural guard the kill fixture is checked
    // with — a payload that declares a posture without binding a dispatch, or
    // binds a contradictory one, fails here.
    const validation = validateProvisionedDispatch(data);
    expect(validation.ok ? null : validation.reason).toBeNull();

    expect(data).toMatchObject({
      posture: 'read-only',
      dispatch: {
        posture: 'read-only',
        subagent: true,
        // The load-bearing bit: `name` is FORBIDDEN. A named read-only spawn is
        // the idle mailbox teammate that never runs the prompt.
        naming: 'anonymous',
        workspace: 'inherited',
      },
    });

    // The emitted shape is the table's, not a restatement that could drift.
    expect(data).toMatchObject({ dispatch: dispatchShapeFor('read-only') });
  });

  it('PrepareReview_CodeReviewScope_AlsoEmitsAnonymousAsyncShape', async () => {
    // The back-of-pipeline catalog path dispatches a reviewer too; leaving it
    // unbound would preserve the improvisation gap on the more common path.
    const data = dataOf(
      await handlePrepareReview({ featureId: 'dr25-code-review' }, stateDir, eventStore),
    );
    const validation = validateProvisionedDispatch(data);
    expect(validation.ok ? null : validation.reason).toBeNull();
    expect(data).toMatchObject({ posture: 'read-only', dispatch: { naming: 'anonymous' } });
  });
});

// ─── 3. Self-test: a contradictory shape is rejected ────────────────────────

describe('DispatchShape validation self-test (DR-25)', () => {
  it('DispatchShape_ShapeContradictsPosture_FailsValidation', () => {
    // The exact contradiction DR-25 names: a `read-only` provisioning carrying
    // a named, worktree-isolated launch.
    const contradictory: DispatchLaunch = {
      subagent: true,
      naming: 'named',
      workspace: 'worktree',
    };

    const direct = validateDispatchShape('read-only', contradictory);
    expect(direct.ok).toBe(false);
    expect(direct.ok ? '' : direct.reason).toContain('contradicts posture "read-only"');

    // …and through the payload guard, which is what a seeded provisioning
    // result goes through.
    const seeded = validateProvisionedDispatch({
      mode: 'plan-review',
      posture: 'read-only',
      dispatch: contradictory,
    });
    expect(seeded.ok).toBe(false);

    // The named-without-isolation shape — the one that produced the 2026-08-07
    // phantom teammates — is rejected for read-only too.
    const namedNoIsolation = validateProvisionedDispatch({
      posture: 'read-only',
      dispatch: { subagent: true, naming: 'named', workspace: 'inherited' },
    });
    expect(namedNoIsolation.ok).toBe(false);

    // A shared-mutating result claiming to be a subagent is rejected.
    const subagentMutator = validateProvisionedDispatch({
      posture: 'shared-mutating',
      dispatch: { subagent: true, naming: 'anonymous', workspace: 'worktree' },
    });
    expect(subagentMutator.ok).toBe(false);

    // Guard-execution proof: the CANONICAL shape for each declared posture
    // passes. A validator that rejected everything would satisfy the negatives
    // above while enforcing nothing.
    for (const posture of AgentPosture.options) {
      const ok = validateProvisionedDispatch({
        posture,
        dispatch: dispatchShapeFor(posture),
      });
      expect(ok.ok, ok.ok ? '' : ok.reason).toBe(true);
    }
  });

  it('DispatchShape_PayloadWithoutDispatchField_FailsValidation', () => {
    // The pre-DR-25 shape: a declared posture with no bound launch. This is the
    // class task 047's frozen kill fixture belongs to.
    const unbound = validateProvisionedDispatch({
      mode: 'plan-review',
      posture: 'read-only',
      adversarial: true,
    });
    expect(unbound.ok).toBe(false);
    expect(unbound.ok ? '' : unbound.reason).toContain('no `dispatch` field');
  });
});

// ─── 4. INV-4 error path: undeclared capability → declared fallback ─────────

describe('DispatchShape runtime resolution (DR-25, INV-4)', () => {
  const codex: RuntimeCapabilityDeclaration = codexAdapter;

  it('DispatchShape_RuntimeLacksWorktreeIsolation_ResolvesDeclaredFallback', () => {
    // Codex declares `isolation:worktree` as `advisory`, not `native` —
    // tolerated but with no primitive behind it. The task-isolated shape
    // therefore cannot be honoured as declared.
    expect(codex.supportLevels['isolation:worktree']).not.toBe('native');

    const resolved = resolveDispatchShape('task-isolated', codex);
    expect(resolved.honoured).toBe(true);
    if (!resolved.honoured) throw new Error('unreachable');
    expect(resolved.degraded).toBe(true);
    if (!resolved.degraded) throw new Error('unreachable');

    // The DECLARED fallback — and it still runs the prompt.
    expect(resolved.shape).toBe(dispatchShapeFor('task-isolated').fallback);
    expect(resolved.shape.subagent).toBe(true);

    // Crucially NOT named-without-isolation: that is the shape that spawns
    // something which never executes.
    expect(resolved.shape.naming).toBe('anonymous');
    expect(
      resolved.shape.naming === 'named' && resolved.shape.workspace !== 'worktree',
    ).toBe(false);

    // The degrade is visible, not silent: the caller can see what it lost.
    expect(resolved.unmet).toContain('isolation:worktree');
    expect(resolved.declaredShape).toBe(dispatchShapeFor('task-isolated'));
  });

  it('DispatchShape_ClaudeDeclaresEveryCapability_ResolvesUndegraded', () => {
    for (const posture of AgentPosture.options) {
      const resolved = resolveDispatchShape(posture, claudeAdapter);
      expect(resolved.honoured, `posture=${posture}`).toBe(true);
      if (!resolved.honoured) throw new Error('unreachable');
      expect(resolved.degraded, `posture=${posture}`).toBe(false);
      expect(resolved.shape).toBe(dispatchShapeFor(posture));
    }
  });

  it('DispatchShape_NoRuntimeSupportsRequirement_ReturnsTypedErrorNotNoOp', () => {
    // A runtime that declares nothing native. `shared-mutating` has no fallback
    // (nothing can honour a mutating dispatch without write), so the result is
    // a TYPED error — never a silently-degraded shape.
    const inert: RuntimeCapabilityDeclaration = {
      runtime: 'inert-harness',
      supportLevels: buildSupportMap('unsupported'),
    };

    for (const posture of AgentPosture.options) {
      const resolved = resolveDispatchShape(posture, inert);
      expect(resolved.honoured, `posture=${posture} must not silently resolve`).toBe(false);
      if (resolved.honoured) throw new Error('unreachable');
      expect(resolved.error.code).toBe(DISPATCH_SHAPE_UNSUPPORTED);
      expect(resolved.error.posture).toBe(posture);
      expect(resolved.error.runtime).toBe('inert-harness');
      expect(resolved.error.unmet.length).toBeGreaterThan(0);
    }
  });

  it('DispatchShape_NoRuntimeDeclarationSupplied_ReturnsCanonicalShape', () => {
    // The provisioning verbs do not know which harness will launch the agent,
    // so they emit the canonical shape (with its `requires` / `fallback`) and
    // let the host run this same resolution.
    for (const posture of AgentPosture.options) {
      const resolved = resolveDispatchShape(posture);
      expect(resolved.honoured).toBe(true);
      if (!resolved.honoured) throw new Error('unreachable');
      expect(resolved.degraded).toBe(false);
      expect(resolved.shape).toBe(dispatchShapeFor(posture));
    }
  });
});

// ─── 5. The table is immutable at RUNTIME, transitively (DR-25, task 059) ───
//
// `readonly` on `DispatchShape` is a COMPILE-TIME claim, and asserting it in a
// test would be circular — it would only restate the declaration the compiler
// already enforces. The claim worth proving is the RUNTIME one, because the
// table is handed out by reference: `dispatchShapeFor` returns the shared
// entry and `resolveDispatchShape` returns the shared `fallback` object to
// every capability-degraded caller. One mutation would corrupt every
// subsequent degraded dispatch process-wide.
//
// So these tests attempt REAL mutations — `Reflect.set` / `Reflect.defineProperty`
// / `Reflect.deleteProperty` (which report refusal by returning `false`) and
// `Object.assign` (which throws on a frozen target in strict mode) — and each
// probe is paired with a CONTROL run against an unfrozen structural twin, so a
// probe that could never mutate anything cannot pass as proof of immutability.

describe('DispatchShape immutability (DR-25)', () => {
  /**
   * A harness that reads and writes natively but cannot spawn. Enough to force
   * `read-only` onto its declared fallback while still MEETING that fallback's
   * own `requires`, so the resolution DEGRADES rather than erroring — which is
   * what puts the shared fallback object in a caller's hands.
   */
  const noSpawn: RuntimeCapabilityDeclaration = {
    runtime: 'no-spawn-harness',
    supportLevels: buildSupportMap('native', { 'subagent:spawn': 'unsupported' }),
  };

  /** A structurally identical shape that is deliberately NOT frozen. */
  function unfrozenTwin(shape: DispatchShape): DispatchShape {
    return { ...shape, requires: [...shape.requires] };
  }

  /**
   * Widening guard used by the reachability walk. A type guard, not a cast:
   * arrays and plain objects both satisfy it, which is what a structural walk
   * needs, and nothing here asserts a type the compiler has not checked.
   */
  function isWalkable(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null;
  }

  /** Every object reachable from `root` by own enumerable properties. */
  function reachable(root: unknown, seen: object[] = []): readonly object[] {
    if (!isWalkable(root) || seen.includes(root)) return seen;
    seen.push(root);
    for (const value of Object.values(root)) reachable(value, seen);
    return seen;
  }

  it('DispatchShape_FallbackMutationAttempt_LeavesTheSharedShapeIntact', () => {
    // The object a capability-degraded runtime is ACTUALLY handed.
    const first = resolveDispatchShape('read-only', noSpawn);
    expect(first.honoured).toBe(true);
    if (!first.honoured) throw new Error('unreachable');
    expect(first.degraded).toBe(true);
    if (!first.degraded) throw new Error('unreachable');
    const degraded = first.shape;
    expect(degraded).toBe(dispatchShapeFor('read-only').fallback);

    // ── PROBE CONTROL ───────────────────────────────────────────────────────
    // The same four techniques against an UNFROZEN structural twin all land.
    // Without this arm, a probe that mutates nothing anywhere would "prove"
    // immutability against any implementation, frozen or not.
    const twin = unfrozenTwin(degraded);
    expect(Reflect.set(twin, 'naming', 'named')).toBe(true);
    expect(twin.naming).toBe('named');
    expect(Reflect.set(twin.requires, 0, 'fs:write')).toBe(true);
    expect(twin.requires[0]).toBe('fs:write');
    expect(Reflect.deleteProperty(twin, 'rationale')).toBe(true);
    expect(twin.rationale).toBeUndefined();
    expect(() => Object.assign(unfrozenTwin(degraded), { naming: 'named' })).not.toThrow();

    // ── THE RUNTIME GUARANTEE ───────────────────────────────────────────────
    // Every probe above, replayed against the SHIPPED fallback. All refused.
    expect(Object.isFrozen(degraded)).toBe(true);
    expect(Object.isFrozen(degraded.requires)).toBe(true);

    expect(Reflect.set(degraded, 'naming', 'named')).toBe(false);
    expect(Reflect.set(degraded, 'workspace', 'worktree')).toBe(false);
    expect(Reflect.set(degraded, 'subagent', true)).toBe(false);
    expect(Reflect.defineProperty(degraded, 'rationale', { value: 'rewritten' })).toBe(false);
    expect(Reflect.deleteProperty(degraded, 'rationale')).toBe(false);
    // The `requires` array too — an entry rewritten in place…
    expect(Reflect.set(degraded.requires, 0, 'fs:write')).toBe(false);
    // …and no APPEND either: a frozen array is non-extensible.
    expect(Reflect.set(degraded.requires, degraded.requires.length, 'fs:write')).toBe(false);
    // The strict-mode THROWING form, which is what an ordinary
    // `shape.naming = 'named'` compiles to at runtime.
    expect(() => Object.assign(degraded, { naming: 'named' })).toThrow(TypeError);

    // ── NOTHING MOVED ───────────────────────────────────────────────────────
    expect(degraded.subagent).toBe(false);
    expect(degraded.naming).toBe('anonymous');
    expect(degraded.workspace).toBe('inherited');
    expect([...degraded.requires]).toEqual(['fs:read']);
    expect(degraded.rationale).toContain('Still runs the prompt');

    // ── …AND THE NEXT DEGRADED DISPATCH IS UNAFFECTED ───────────────────────
    // The point of the whole guarantee. Process-wide corruption through one
    // shared reference is what freezing prevents, so the observable claim is
    // that a LATER resolution still gets the declared shape.
    const second = resolveDispatchShape('read-only', noSpawn);
    expect(second.honoured).toBe(true);
    if (!second.honoured) throw new Error('unreachable');
    expect(second.degraded).toBe(true);
    if (!second.degraded) throw new Error('unreachable');
    expect(second.shape).toBe(degraded);
    expect(second.shape.naming).toBe('anonymous');
    expect(second.shape.subagent).toBe(false);
    expect([...second.shape.requires]).toEqual(['fs:read']);
  });

  it('DispatchShape_EveryNodeReachableFromTheTable_IsFrozenTransitively', () => {
    const nodes = reachable(POSTURE_DISPATCH_MAP);

    // DENOMINATOR — a walk that resolved nothing would satisfy the `filter`
    // below vacuously. The expectation is derived from the table's STRUCTURE
    // (one container, plus an object and a `requires` array per shape and per
    // declared fallback), not from the walk itself.
    const expectedNodes = AgentPosture.options.reduce((total, posture) => {
      const shape = dispatchShapeFor(posture);
      return total + 2 + (shape.fallback === null ? 0 : 2);
    }, 1);
    expect(expectedNodes).toBeGreaterThan(1);
    expect(nodes.length).toBe(expectedNodes);

    // …and it found the specific nodes the old partial freeze left writable.
    expect(nodes).toContain(POSTURE_DISPATCH_MAP);
    for (const posture of AgentPosture.options) {
      const shape = dispatchShapeFor(posture);
      expect(nodes).toContain(shape);
      expect(nodes).toContain(shape.requires);
      if (shape.fallback !== null) {
        expect(nodes).toContain(shape.fallback);
        expect(nodes).toContain(shape.fallback.requires);
      }
    }

    // CONTROL — `Object.isFrozen` must be capable of answering `false` on a
    // node of this shape, or the sweep below is measuring nothing.
    expect(Object.isFrozen(unfrozenTwin(dispatchShapeFor('read-only')))).toBe(false);

    const unfrozen = nodes.filter((node) => !Object.isFrozen(node));
    expect(
      unfrozen.length,
      `${unfrozen.length} object(s) reachable from POSTURE_DISPATCH_MAP are not frozen: ` +
        `${JSON.stringify(unfrozen)}. \`readonly\` is a compile-time claim only — a caller ` +
        `holding the shared shape can still mutate it at runtime.`,
    ).toBe(0);
  });
});
