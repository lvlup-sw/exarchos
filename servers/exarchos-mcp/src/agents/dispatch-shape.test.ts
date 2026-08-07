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
  type RuntimeCapabilityDeclaration,
} from './dispatch-shape.js';
import { AgentPosture } from './spec.js';
import { Capability } from './capabilities.js';
import { buildSupportMap } from './adapters/support-levels.js';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { handlePrepareReview } from '../orchestrate/prepare-review.js';
import { EventStore } from '../event-store/store.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import type { ToolResult } from '../format.js';

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
