// The contract from agent posture to dispatch shape. The suite proves three properties:
//
//   1. Totality: each declared posture has exactly one dispatch entry. The census reads
//      `AgentPosture.options`, because a posture list retyped here makes the test vacuous.
//   2. Binding: `prepare_review` emits the anonymous shape for its `read-only` posture, through the
//      real handler and a real event store.
//   3. Self-test: validation rejects a provisioning result whose `dispatch` contradicts its `posture`.
//
// When the runtime does not declare a required capability, the shape resolves to the declared
// fallback or to a typed error. It never degrades silently.
//
// The census compares two independent authorities: the Zod `AgentPosture` enum in `spec.ts`, and
// the key set of the frozen table in `dispatch-shape.ts`. The table takes its posture type from
// `types.ts`, so `dispatch-shape.ts` never imports `spec.ts`.
//
// @oracle-sources: ../../../../src/runtime/agents/spec.ts, ../../../../src/runtime/agents/dispatch-shape.ts

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
} from '../../../../src/runtime/agents/dispatch-shape.js';
import { AgentPosture } from '../../../../src/runtime/agents/spec.js';
import { Capability } from '../../../../src/runtime/agents/capabilities.js';
import { buildSupportMap } from '../../../../src/runtime/agents/adapters/support-levels.js';
import { claudeAdapter } from '../../../../src/runtime/agents/adapters/claude.js';
import { codexAdapter } from '../../../../src/runtime/agents/adapters/codex.js';
import { handlePrepareReview } from '../../../../src/verbs/team/prepare-review.js';
import { EventStore } from '../../../../src/events/store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import type { ToolResult } from '../../../../src/format.js';

describe('DispatchShape totality (DR-25)', () => {
  /**
   * Compares the Zod enum in `spec.ts` with the own key set of the frozen table. Five checks:
   *
   * - Each declared posture has an entry, so the mapping cannot be partial.
   * - The table has no entry for an undeclared posture.
   * - Each entry names its own key, so a copied row cannot pass as a distinct entry.
   * - The launches are distinct. Two postures with one launch bind nothing.
   * - Each entry requires at least one capability, and each capability is in the declared
   *   vocabulary. An empty `requires` makes the runtime resolution unfalsifiable.
   */
  it('DispatchShape_EveryDeclaredPosture_HasExactlyOneEntry', () => {
    const declared = AgentPosture.options;
    expect(declared.length).toBeGreaterThan(0);

    const entryKeys = Object.keys(POSTURE_DISPATCH_MAP);
    expect(posturesWithDispatchShape()).toEqual(entryKeys);

    for (const posture of declared) {
      expect(
        Object.prototype.hasOwnProperty.call(POSTURE_DISPATCH_MAP, posture),
        `posture "${posture}" is declared in AgentPosture but has no dispatch entry`,
      ).toBe(true);
      expect(dispatchShapeFor(posture)).toBeDefined();
    }

    expect([...entryKeys].sort()).toEqual([...declared].sort());
    expect(entryKeys.length).toBe(declared.length);

    for (const posture of declared) {
      expect(dispatchShapeFor(posture).posture).toBe(posture);
    }

    const launches = declared.map((p) => {
      const s = dispatchShapeFor(p);
      return `${s.subagent}|${s.naming}|${s.workspace}`;
    });
    expect(new Set(launches).size).toBe(declared.length);

    for (const posture of declared) {
      const shape = dispatchShapeFor(posture);
      expect(shape.requires.length).toBeGreaterThan(0);
      for (const cap of shape.requires) {
        expect(Capability.options).toContain(cap);
      }
    }
  });

  /** Pins the three rows of the policy, so a change to the table must be deliberate. */
  it('DispatchShape_DeclaredPostures_BindTheDocumentedLaunchShapes', () => {
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

  /**
   * `validateProvisionedDispatch` rejects a payload that binds no dispatch, or a contradictory one.
   * The `anonymous` naming is the important field: a named read-only spawn is an idle mailbox
   * teammate that never runs the prompt. The emitted shape must also match the table entry.
   */
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

    const validation = validateProvisionedDispatch(data);
    expect(validation.ok ? null : validation.reason).toBeNull();

    expect(data).toMatchObject({
      posture: 'read-only',
      dispatch: {
        posture: 'read-only',
        subagent: true,
        naming: 'anonymous',
        workspace: 'inherited',
      },
    });

    expect(data).toMatchObject({ dispatch: dispatchShapeFor('read-only') });
  });

  /**
   * The code-review scope also dispatches a reviewer. It is the more common path, so its payload
   * must bind the shape too.
   */
  it('PrepareReview_CodeReviewScope_AlsoEmitsAnonymousAsyncShape', async () => {
    const data = dataOf(
      await handlePrepareReview({ featureId: 'dr25-code-review' }, stateDir, eventStore),
    );
    const validation = validateProvisionedDispatch(data);
    expect(validation.ok ? null : validation.reason).toBeNull();
    expect(data).toMatchObject({ posture: 'read-only', dispatch: { naming: 'anonymous' } });
  });
});

describe('DispatchShape validation self-test (DR-25)', () => {
  /**
   * The contradiction is a `read-only` provisioning with a named, worktree-isolated launch. The
   * validator must also reject a named launch without isolation, which produces phantom teammates,
   * and a `shared-mutating` result that claims a subagent. The last loop proves that the validator
   * runs: the canonical shape of each declared posture must pass. A validator that rejects
   * everything satisfies the negative checks and enforces nothing.
   */
  it('DispatchShape_ShapeContradictsPosture_FailsValidation', () => {
    const contradictory: DispatchLaunch = {
      subagent: true,
      naming: 'named',
      workspace: 'worktree',
    };

    const direct = validateDispatchShape('read-only', contradictory);
    expect(direct.ok).toBe(false);
    expect(direct.ok ? '' : direct.reason).toContain('contradicts posture "read-only"');

    const seeded = validateProvisionedDispatch({
      mode: 'plan-review',
      posture: 'read-only',
      dispatch: contradictory,
    });
    expect(seeded.ok).toBe(false);

    const namedNoIsolation = validateProvisionedDispatch({
      posture: 'read-only',
      dispatch: { subagent: true, naming: 'named', workspace: 'inherited' },
    });
    expect(namedNoIsolation.ok).toBe(false);

    const subagentMutator = validateProvisionedDispatch({
      posture: 'shared-mutating',
      dispatch: { subagent: true, naming: 'anonymous', workspace: 'worktree' },
    });
    expect(subagentMutator.ok).toBe(false);

    for (const posture of AgentPosture.options) {
      const ok = validateProvisionedDispatch({
        posture,
        dispatch: dispatchShapeFor(posture),
      });
      expect(ok.ok, ok.ok ? '' : ok.reason).toBe(true);
    }
  });

  /**
   * The payload declares a posture and binds no launch. The frozen payload in
   * `tests/unit/verbs/dispatch-shape.kill-fixture.test.ts` is of this class.
   */
  it('DispatchShape_PayloadWithoutDispatchField_FailsValidation', () => {
    const unbound = validateProvisionedDispatch({
      mode: 'plan-review',
      posture: 'read-only',
      adversarial: true,
    });
    expect(unbound.ok).toBe(false);
    expect(unbound.ok ? '' : unbound.reason).toContain('no `dispatch` field');
  });
});

describe('DispatchShape runtime resolution (DR-25, INV-4)', () => {
  const codex: RuntimeCapabilityDeclaration = codexAdapter;

  /**
   * Codex declares `isolation:worktree` as `advisory`, which has no primitive behind it. Thus the
   * `task-isolated` shape resolves to its declared fallback. The fallback still runs the prompt and
   * is anonymous, because a named shape without isolation spawns a teammate that never runs. The
   * result names the unmet capability and the declared shape, so the degrade is visible.
   */
  it('DispatchShape_RuntimeLacksWorktreeIsolation_ResolvesDeclaredFallback', () => {
    expect(codex.supportLevels['isolation:worktree']).not.toBe('native');

    const resolved = resolveDispatchShape('task-isolated', codex);
    expect(resolved.honoured).toBe(true);
    if (!resolved.honoured) throw new Error('unreachable');
    expect(resolved.degraded).toBe(true);
    if (!resolved.degraded) throw new Error('unreachable');

    expect(resolved.shape).toBe(dispatchShapeFor('task-isolated').fallback);
    expect(resolved.shape.subagent).toBe(true);

    expect(resolved.shape.naming).toBe('anonymous');
    expect(
      resolved.shape.naming === 'named' && resolved.shape.workspace !== 'worktree',
    ).toBe(false);

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

  /**
   * A runtime that declares nothing native meets no shape and no fallback. Each posture must give a
   * typed error, never a silently degraded shape.
   */
  it('DispatchShape_NoRuntimeSupportsRequirement_ReturnsTypedErrorNotNoOp', () => {
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

  /**
   * The provisioning verbs do not know which harness launches the agent. They emit the canonical
   * shape with its `requires` and `fallback`, and the host runs this same resolution.
   */
  it('DispatchShape_NoRuntimeDeclarationSupplied_ReturnsCanonicalShape', () => {
    for (const posture of AgentPosture.options) {
      const resolved = resolveDispatchShape(posture);
      expect(resolved.honoured).toBe(true);
      if (!resolved.honoured) throw new Error('unreachable');
      expect(resolved.degraded).toBe(false);
      expect(resolved.shape).toBe(dispatchShapeFor(posture));
    }
  });
});

/**
 * `readonly` on `DispatchShape` is a compile-time claim. The runtime claim needs proof, because
 * `dispatchShapeFor` and `resolveDispatchShape` hand out shared references. One mutation corrupts
 * each later degraded dispatch in the process.
 *
 * The tests attempt real mutations. A `Reflect` probe returns `false` on a refusal, and
 * `Object.assign` throws on a frozen target. The control arm runs the set, delete and assign
 * probes on `unfrozenTwin`, an unfrozen copy, to prove that those probes can mutate.
 *
 * `noSpawn` cannot spawn but meets the `requires` of the `read-only` fallback. Thus the resolution
 * degrades and returns the shared fallback object. `reachable` collects the root and each object
 * under it, through own enumerable properties.
 */
describe('DispatchShape immutability (DR-25)', () => {
  const noSpawn: RuntimeCapabilityDeclaration = {
    runtime: 'no-spawn-harness',
    supportLevels: buildSupportMap('native', { 'subagent:spawn': 'unsupported' }),
  };

  function unfrozenTwin(shape: DispatchShape): DispatchShape {
    return { ...shape, requires: [...shape.requires] };
  }

  function isWalkable(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null;
  }

  function reachable(root: unknown, seen: object[] = []): readonly object[] {
    if (!isWalkable(root) || seen.includes(root)) return seen;
    seen.push(root);
    for (const value of Object.values(root)) reachable(value, seen);
    return seen;
  }

  /**
   * The subject is the fallback object that a degraded runtime receives. The control arm runs first:
   * without it, a probe that mutates nothing proves immutability for any implementation. The shipped
   * fallback must then refuse each probe, which includes an in-place write and an append on
   * `requires`. `Object.assign` covers the throwing form of a plain assignment in strict mode. Last,
   * a later resolution must return the same fallback object with its values unchanged.
   */
  it('DispatchShape_FallbackMutationAttempt_LeavesTheSharedShapeIntact', () => {
    const first = resolveDispatchShape('read-only', noSpawn);
    expect(first.honoured).toBe(true);
    if (!first.honoured) throw new Error('unreachable');
    expect(first.degraded).toBe(true);
    if (!first.degraded) throw new Error('unreachable');
    const degraded = first.shape;
    expect(degraded).toBe(dispatchShapeFor('read-only').fallback);

    const twin = unfrozenTwin(degraded);
    expect(Reflect.set(twin, 'naming', 'named')).toBe(true);
    expect(twin.naming).toBe('named');
    expect(Reflect.set(twin.requires, 0, 'fs:write')).toBe(true);
    expect(twin.requires[0]).toBe('fs:write');
    expect(Reflect.deleteProperty(twin, 'rationale')).toBe(true);
    expect(twin.rationale).toBeUndefined();
    expect(() => Object.assign(unfrozenTwin(degraded), { naming: 'named' })).not.toThrow();

    expect(Object.isFrozen(degraded)).toBe(true);
    expect(Object.isFrozen(degraded.requires)).toBe(true);

    expect(Reflect.set(degraded, 'naming', 'named')).toBe(false);
    expect(Reflect.set(degraded, 'workspace', 'worktree')).toBe(false);
    expect(Reflect.set(degraded, 'subagent', true)).toBe(false);
    expect(Reflect.defineProperty(degraded, 'rationale', { value: 'rewritten' })).toBe(false);
    expect(Reflect.deleteProperty(degraded, 'rationale')).toBe(false);
    expect(Reflect.set(degraded.requires, 0, 'fs:write')).toBe(false);
    expect(Reflect.set(degraded.requires, degraded.requires.length, 'fs:write')).toBe(false);
    expect(() => Object.assign(degraded, { naming: 'named' })).toThrow(TypeError);

    expect(degraded.subagent).toBe(false);
    expect(degraded.naming).toBe('anonymous');
    expect(degraded.workspace).toBe('inherited');
    expect([...degraded.requires]).toEqual(['fs:read']);
    expect(degraded.rationale).toContain('Still runs the prompt');

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

  /**
   * The expected node count comes from the structure of the table, not from the walk. The table has
   * one container, and an object and a `requires` array for each shape and each fallback. Thus an
   * empty walk cannot pass. A control proves that `Object.isFrozen` can return `false` for a node of
   * this shape.
   */
  it('DispatchShape_EveryNodeReachableFromTheTable_IsFrozenTransitively', () => {
    const nodes = reachable(POSTURE_DISPATCH_MAP);

    const expectedNodes = AgentPosture.options.reduce((total, posture) => {
      const shape = dispatchShapeFor(posture);
      return total + 2 + (shape.fallback === null ? 0 : 2);
    }, 1);
    expect(expectedNodes).toBeGreaterThan(1);
    expect(nodes.length).toBe(expectedNodes);

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
