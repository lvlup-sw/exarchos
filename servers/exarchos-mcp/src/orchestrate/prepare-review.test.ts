import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handlePrepareReview, type PrepareReviewArgs } from './prepare-review.js';
import { QUALITY_CHECK_CATALOG } from '../review/check-catalog.js';
import { EventStore } from '../event-store/store.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { resolveWorkflowState } from './resolve-state.js';
import type { ToolResult } from '../format.js';

// ─── Typed assertion helpers ────────────────────────────────────────────────

interface IntentGrounding {
  mode: string;
  intended: { surfaces: string[]; summary: string; transcriptSummary?: string };
  instruction: string;
}

interface PrepareReviewData {
  catalog: { version: string; dimensions: readonly { id: string }[] };
  findingFormat: string;
  pluginStatus: {
    impeccable: { enabled: boolean };
  };
  intent?: { changedFiles: string[]; surfaces: string[]; summary: string };
  intentGrounding?: IntentGrounding;
}

function expectSuccess(result: ToolResult): PrepareReviewData {
  expect(result.success).toBe(true);
  return result.data as PrepareReviewData;
}

function expectError(result: ToolResult): { code: string; message: string } {
  expect(result.success).toBe(false);
  return result.error as { code: string; message: string };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

// DR-1 (#1593): the handler now takes (args, stateDir, eventStore). A real
// store + stateDir is provisioned per-test so the code-review path's
// `persistIntent` has a canonical surface to write to (and, for featureIds with
// no inited workflow, fail soft without breaking the catalog response). The
// plan-review path early-returns before touching intent, so the store is inert
// there.
let stateDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'prepare-review-state-'));
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
});

afterEach(async () => {
  // Release the SQLite handles before removing the dir — on Windows an open
  // exarchos.db/-wal/-shm handle makes the rm fail (EBUSY/EPERM). rmrfAsync
  // also retries, covering the handle-close race. (store.ts close() contract.)
  eventStore.close();
  await rmrfAsync(stateDir);
});

/** Thread the per-test real EventStore + stateDir into the 3-arg handler. */
function callPrepareReview(args: PrepareReviewArgs): Promise<ToolResult> {
  return handlePrepareReview(args, stateDir, eventStore);
}

describe('handlePrepareReview', () => {
  it('HandlePrepareReview_DefaultArgs_ReturnsCatalogWithAllDimensions', async () => {
    const data = expectSuccess(await callPrepareReview({ featureId: 'test-default' }));
    expect(data.catalog.dimensions.length).toBe(QUALITY_CHECK_CATALOG.dimensions.length);
  });

  it('HandlePrepareReview_DimensionFilter_ReturnsOnlyRequestedDimensions', async () => {
    const data = expectSuccess(await callPrepareReview({
      featureId: 'test-filter',
      dimensions: ['error-handling', 'resilience'],
    }));
    expect(data.catalog.dimensions.length).toBe(2);
    expect(data.catalog.dimensions.map(d => d.id)).toEqual(['error-handling', 'resilience']);
  });

  it('HandlePrepareReview_InvalidDimension_ReturnsError', async () => {
    const err = expectError(await callPrepareReview({
      featureId: 'test-invalid',
      dimensions: ['nonexistent-dimension'],
    }));
    expect(err.code).toBe('INVALID_INPUT');
  });

  it('HandlePrepareReview_PluginStatusNoConfig_DefaultsToEnabled', async () => {
    const data = expectSuccess(await callPrepareReview({ featureId: 'test-plugin-default' }));
    expect(data.pluginStatus.impeccable.enabled).toBe(true);
  });

  it('PrepareReview_PluginStatus_OmitsAxiom', async () => {
    // axiom is excised (#1477) — pluginStatus must not carry an axiom entry.
    const data = expectSuccess(await callPrepareReview({ featureId: 'test-omits-axiom' }));
    expect('axiom' in data.pluginStatus).toBe(false);
  });

  it('HandlePrepareReview_FindingFormatIncluded_IsNonEmptyString', async () => {
    const data = expectSuccess(await callPrepareReview({ featureId: 'test-format' }));
    expect(typeof data.findingFormat).toBe('string');
    expect(data.findingFormat.length).toBeGreaterThan(0);
  });

  it('HandlePrepareReview_CatalogVersion_MatchesCatalogConstant', async () => {
    const data = expectSuccess(await callPrepareReview({ featureId: 'test-version' }));
    expect(data.catalog.version).toBe(QUALITY_CHECK_CATALOG.version);
  });

  it('HandlePrepareReview_MissingFeatureId_ReturnsError', async () => {
    const err = expectError(await callPrepareReview({ featureId: '' }));
    expect(err.code).toBe('INVALID_INPUT');
  });

  // ─── Config-driven plugin status ──────────────────────────────────────

  describe('config-driven plugin status', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'prepare-review-'));
    });

    afterEach(async () => {
      await rmrfAsync(tempDir);
    });

    it('HandlePrepareReview_RepoRootWithConfig_ReadsPluginStatus', async () => {
      writeFileSync(join(tempDir, '.exarchos.yml'), `plugins:\n  impeccable:\n    enabled: false\n`);
      const data = expectSuccess(await callPrepareReview({ featureId: 'test-config', repoRoot: tempDir }));
      expect(data.pluginStatus.impeccable.enabled).toBe(false);
    });

    it('HandlePrepareReview_RepoRootNoConfig_DefaultsToEnabled', async () => {
      const data = expectSuccess(await callPrepareReview({ featureId: 'test-no-config', repoRoot: tempDir }));
      expect(data.pluginStatus.impeccable.enabled).toBe(true);
    });

    it('HandlePrepareReview_NoRepoRoot_DefaultsToEnabled', async () => {
      const data = expectSuccess(await callPrepareReview({ featureId: 'test-no-root' }));
      expect(data.pluginStatus.impeccable.enabled).toBe(true);
    });
  });

  // ─── DR-10 (#1581 task 024): plan-review reframed as a fresh-context ────────
  //     adversarial gate, designDepth-scaled.
  describe('plan-review provisioning (DR-10, task 024)', () => {
    interface PlanReviewData {
      mode: string;
      posture: string;
      adversarial: boolean;
      instruction: string;
      rung: { name: string; voters: number };
      provisionedContext: {
        artifact: string;
        spec: string;
        authoringTranscriptIncluded: boolean;
      };
      verdictFormat: string;
    }
    const planData = (r: ToolResult): PlanReviewData => {
      expect(r.success).toBe(true);
      return r.data as PlanReviewData;
    };

    it('PlanReview_DispatchedReviewer_ReceivesNoAuthorTranscript', async () => {
      // The reviewer is provisioned with ONLY {artifact, spec} — never the
      // authoring transcript (INV-11 read-only, fresh context).
      const data = planData(
        await callPrepareReview(
          {
            featureId: 'pr-feat',
            scope: 'plan',
            artifact: 'docs/specs/2026-06-22-feat.md',
            spec: 'docs/specs/2026-06-22-feat.md#requirements',
          },
        ),
      );
      expect(data.mode).toBe('plan-review');
      expect(data.posture).toBe('read-only');
      expect(data.provisionedContext.artifact).toBe('docs/specs/2026-06-22-feat.md');
      expect(data.provisionedContext.spec).toBe('docs/specs/2026-06-22-feat.md#requirements');
      // The structural guarantee: no transcript is carried, and the provisioning
      // has no key that could smuggle one in.
      expect(data.provisionedContext.authoringTranscriptIncluded).toBe(false);
      expect('transcript' in data.provisionedContext).toBe(false);
      expect('authoringContext' in data.provisionedContext).toBe(false);
      // The instruction reminds the reviewer it lacks the transcript.
      expect(data.instruction.toLowerCase()).toContain('transcript');
    });

    it('PlanReview_RefutationPosture_EmitsEvidenceVerdict', async () => {
      const data = planData(
        await callPrepareReview(
          { featureId: 'pr-feat', scope: 'plan-review', artifact: 'docs/specs/x.md' },
        ),
      );
      expect(data.adversarial).toBe(true);
      // Prompted to refute / default-to-reject — not a rubric pass.
      expect(data.instruction.toLowerCase()).toMatch(/refute|reject/);
      // The verdict format is evidence-emitting: concrete gaps, not a score.
      expect(data.verdictFormat).toContain('PlanReviewVerdict');
      expect(data.verdictFormat).toContain('gaps');
      expect(data.verdictFormat).toMatch(/refuted|survives/);
    });

    it('PlanReview_ThinDepth_UsesLightRung', async () => {
      // thin → the light rung, single voter — cost stays risk-proportional and
      // must NOT escalate to the multi-voter panel.
      const data = planData(
        await callPrepareReview(
          { featureId: 'pr-feat', scope: 'plan', artifact: 'docs/specs/x.md', designDepth: 'thin' },
        ),
      );
      expect(data.rung.name).toBe('light');
      expect(data.rung.voters).toBe(1);
    });

    it('PlanReview_DeepDepth_UsesMultiVoterPanel', async () => {
      const data = planData(
        await callPrepareReview(
          { featureId: 'pr-feat', scope: 'plan', artifact: 'docs/specs/x.md', designDepth: 'deep' },
        ),
      );
      expect(data.rung.name).toBe('panel');
      expect(data.rung.voters).toBeGreaterThan(1);
    });

    it('PlanReview_AbsentDesignDepth_DefaultsStandardRung', async () => {
      const data = planData(
        await callPrepareReview(
          { featureId: 'pr-feat', scope: 'plan', artifact: 'docs/specs/x.md' },
        ),
      );
      expect(data.rung.name).toBe('standard');
    });

    it('PlanReview_NoSpec_DefaultsToUnifiedArtifact', async () => {
      // In the collapsed world the artifact carries its own design-rationale §,
      // so an omitted spec falls back to the artifact itself.
      const data = planData(
        await callPrepareReview(
          { featureId: 'pr-feat', scope: 'plan', artifact: 'docs/specs/x.md' },
        ),
      );
      expect(data.provisionedContext.spec).toBe('docs/specs/x.md');
    });

    it('PlanReview_MissingArtifact_ReturnsError', async () => {
      const err = expectError(
        await callPrepareReview({ featureId: 'pr-feat', scope: 'plan' }),
      );
      expect(err.code).toBe('INVALID_INPUT');
      expect(err.message).toContain('artifact');
    });

    it('PrepareReview_NonPlanScope_ServesCodeReviewCatalogUnchanged', async () => {
      // A non-plan scope (or absent) still serves the back-of-pipeline catalog —
      // the plan-review branch must not capture code-review traffic.
      const data = expectSuccess(
        await callPrepareReview({ featureId: 'cr-feat', scope: 'code' }),
      );
      expect((data as { catalog?: unknown }).catalog).toBeDefined();
    });
  });

  // ─── DR-1 (#1593) task 005: REVIEW grounds the spec-review checklist in the ──
  //     captured intent (intended-vs-delivered), degrading to diff-only when no
  //     intent is resolvable.
  describe('intent grounding (DR-1 task 005)', () => {
    /**
     * A self-contained git repo whose `main...HEAD` diff is a single
     * deterministic file — so `changedFilesAgainstBase(repoRoot)` resolves a
     * non-empty changed-file set without depending on the live working tree.
     */
    function seedRepoWithDiff(): string {
      const repo = mkdtempSync(join(tmpdir(), 'prepare-review-repo-'));
      const git = (...a: string[]): void => {
        execFileSync('git', a, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
      };
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      writeFileSync(join(repo, 'base.txt'), 'base\n');
      git('add', '-A');
      git('commit', '-qm', 'base');
      git('checkout', '-q', '-b', 'feat');
      mkdirSync(join(repo, 'servers'), { recursive: true });
      writeFileSync(join(repo, 'servers', 'a.ts'), 'export const x = 1;\n');
      git('add', '-A');
      git('commit', '-qm', 'change');
      return repo;
    }

    it('PrepareReview_WithIntent_GroundsSpecReviewChecklist', async () => {
      const repo = seedRepoWithDiff();
      try {
        const data = expectSuccess(
          await callPrepareReview({ featureId: 'cr-grounded', repoRoot: repo, scope: 'code' }),
        );
        // Intent is meaningful (non-empty diff) → the grounding directive is present.
        expect(data.intent?.changedFiles).toContain('servers/a.ts');
        expect(data.intentGrounding).toBeDefined();
        const grounding = data.intentGrounding as IntentGrounding;
        expect(grounding.mode).toBe('intended-vs-delivered');
        // It references the intent's surfaces + summary (intended-vs-delivered).
        expect(grounding.intended.surfaces).toEqual(data.intent?.surfaces);
        expect(grounding.intended.summary).toBe(data.intent?.summary);
        expect(grounding.intended.surfaces).toContain('servers');
        expect(grounding.instruction.toLowerCase()).toContain('intended');
        expect(grounding.instruction.toLowerCase()).toContain('delivered');
        // The catalog is still served alongside the grounding.
        expect(data.catalog.dimensions.length).toBe(QUALITY_CHECK_CATALOG.dimensions.length);
      } finally {
        await rmrfAsync(repo);
      }
    });

    it('PrepareReview_NoIntent_DegradesToDiffOnly', async () => {
      // A non-git repoRoot ⇒ `changedFilesAgainstBase` returns [] ⇒ empty intent.
      const emptyDir = mkdtempSync(join(tmpdir(), 'prepare-review-empty-'));
      try {
        const data = expectSuccess(
          await callPrepareReview({ featureId: 'cr-no-intent', repoRoot: emptyDir, scope: 'code' }),
        );
        // No resolvable diff → no fabricated intent grounding (diff-only review).
        expect(data.intent?.changedFiles).toEqual([]);
        expect(data.intentGrounding).toBeUndefined();
        expect('intentGrounding' in data).toBe(false);
        // The catalog is returned unchanged.
        expect(data.catalog.dimensions.length).toBe(QUALITY_CHECK_CATALOG.dimensions.length);
      } finally {
        await rmrfAsync(emptyDir);
      }
    });
  });
});

// ─── DR-2 (WLM-6) task 004: stateful `prepare_review scope:plan` — count + cap ──
//     at the one unskippable provisioning seam.
//
// `prepare_review scope:plan` is the ONLY server action an agent must call to
// obtain a fresh-context adversarial plan-review, so it is where the revision
// loop is bounded by construction. Each call records a counted
// `workflow.plan-review-dispatched` event (ordinal 0 = the initial review =
// revision 0; ordinal N = the N-th re-dispatch = revision N); the projection
// folds the MAX ordinal into `planReview.revisionCount` — the field the
// `revisionsExhausted` guard reads. Over-cap re-dispatches are refused at the
// seam with a park-at-`blocked` envelope.
describe('plan-review bound at the provisioning seam (WLM-6 DR-2, task 004)', () => {
  const DISPATCH_EVENT = 'workflow.plan-review-dispatched';

  /** The folded `planReview.revisionCount` — the exact value the guard reads. */
  async function revisionCount(featureId: string): Promise<number | undefined> {
    const resolved = await resolveWorkflowState({ featureId, eventStore });
    if ('error' in resolved) throw new Error('state did not resolve');
    const planReview = resolved.state.planReview as { revisionCount?: number } | undefined;
    return planReview?.revisionCount;
  }

  const planArgs = (featureId: string): PrepareReviewArgs => ({
    featureId,
    scope: 'plan',
    artifact: 'docs/specs/2026-07-03-feat.md',
  });

  it('PrepareReviewPlan_InitialDispatch_EmitsNoCounter', async () => {
    // The initial review consumes NO revision: revisionCount stays 0. An
    // ordinal-0 dispatch marker IS recorded (a traceless initial is
    // indistinguishable from the first re-dispatch on a pure event-sourced
    // stream), but the projection folds ordinal 0 → revisionCount 0, so the
    // counter does not increment.
    const featureId = 'dr2-initial';
    const result = await callPrepareReview(planArgs(featureId));
    expect(result.success).toBe(true);
    expect((result.data as { mode: string }).mode).toBe('plan-review');

    const events = await eventStore.query(featureId, { type: DISPATCH_EVENT });
    expect(events).toHaveLength(1);
    expect((events[0].data as { ordinal: number }).ordinal).toBe(0);
    // The load-bearing contract: the initial did not increment the counter.
    expect(await revisionCount(featureId)).toBe(0);
  });

  it('PrepareReviewPlan_ReDispatch_EmitsCountedEvent', async () => {
    // A re-dispatch (a second provisioning) records a counted event that folds
    // to revisionCount 1 — the value the `revisionsExhausted` guard reads.
    const featureId = 'dr2-redispatch';
    await callPrepareReview(planArgs(featureId)); // initial (ordinal 0)
    const result = await callPrepareReview(planArgs(featureId)); // re-dispatch (ordinal 1)
    expect(result.success).toBe(true);

    const events = await eventStore.query(featureId, { type: DISPATCH_EVENT });
    expect(events).toHaveLength(2);
    expect((events[1].data as { ordinal: number }).ordinal).toBe(1);
    expect(await revisionCount(featureId)).toBe(1);
  });

  it('PrepareReviewPlan_PastCap_RefusesWithBlockedAffordance', async () => {
    // Error-handling AC: with the default cap (maxPlanRevisions = 1, no repoRoot),
    // the initial + one re-dispatch consume the single revision; the NEXT
    // re-dispatch is refused at the seam with a structured park-at-`blocked`
    // envelope that NAMES the count and the cap and carries the resume affordance
    // (INV-5b/INV-12) — and provisions nothing further.
    const featureId = 'dr2-cap';
    await callPrepareReview(planArgs(featureId)); // ordinal 0 (revision 0)
    await callPrepareReview(planArgs(featureId)); // ordinal 1 (revision 1)
    expect(await revisionCount(featureId)).toBe(1);

    const refused = await callPrepareReview(planArgs(featureId)); // over cap
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('PLAN_REVISIONS_EXHAUSTED');
    // Names both the consumed count and the cap.
    expect(refused.error?.message).toContain('1/1');
    // INV-5b: a valid target + a suggested-fix transition to `blocked`.
    expect(refused.error?.validTargets).toContain('blocked');
    expect(refused.error?.suggestedFix?.params).toMatchObject({ to: 'blocked' });
    // INV-12: a `next_actions` affordance to park at `blocked`.
    const nextActions = refused.next_actions as { verb: string; validTargets?: string[] }[];
    expect(nextActions?.some((a) => a.verb === 'blocked')).toBe(true);

    // Provisions nothing: no third dispatch event, revisionCount unchanged.
    const events = await eventStore.query(featureId, { type: DISPATCH_EVENT });
    expect(events).toHaveLength(2);
    expect(await revisionCount(featureId)).toBe(1);
  });

  it('PrepareReviewPlan_CrashRetrySameOrdinal_IdempotentByKey', async () => {
    // INV-8: the dispatch event carries a deterministic idempotency key
    // (`${featureId}:plan-review-dispatch:${ordinal}`), so a same-ordinal
    // crash-retry re-provision collapses at the storage layer rather than
    // double-counting.
    const featureId = 'dr2-idempotent';
    await callPrepareReview(planArgs(featureId)); // ordinal 0
    await callPrepareReview(planArgs(featureId)); // ordinal 1
    const before = await eventStore.query(featureId, { type: DISPATCH_EVENT });
    expect(before).toHaveLength(2);
    // The handler used the deterministic key for ordinal 1.
    expect(before[1].idempotencyKey).toBe(`${featureId}:plan-review-dispatch:1`);

    // Re-append the SAME-ordinal event (the crash-retry) with the same key.
    await eventStore.append(
      featureId,
      { type: DISPATCH_EVENT, data: { featureId, ordinal: 1 } },
      { idempotencyKey: `${featureId}:plan-review-dispatch:1` },
    );

    // Collapsed at the storage layer — no duplicate, count unchanged.
    const after = await eventStore.query(featureId, { type: DISPATCH_EVENT });
    expect(after).toHaveLength(2);
    expect(await revisionCount(featureId)).toBe(1);
  });

  it('PrepareReviewPlan_MissingArtifact_RefusesBeforeAnyEmission', async () => {
    // The artifact validation still fires FIRST — a bad request never records a
    // dispatch marker (no state mutation on an invalid input).
    const featureId = 'dr2-noartifact';
    const result = await callPrepareReview({ featureId, scope: 'plan' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(await eventStore.query(featureId, { type: DISPATCH_EVENT })).toHaveLength(0);
  });
});

// ─── DR-2 (WLM-6) task 005: bypass-closure + off-by-one + zero-on-survive ──────
//     regression suite. These prove the property the old edge counter lacked:
//     the bound holds even when the agent NEVER traverses `plan-review → plan`.
describe('plan-review bound regressions (WLM-6 DR-2, task 005)', () => {
  const DISPATCH_EVENT = 'workflow.plan-review-dispatched';

  async function revisionCount(featureId: string): Promise<number | undefined> {
    const resolved = await resolveWorkflowState({ featureId, eventStore });
    if ('error' in resolved) throw new Error('state did not resolve');
    const planReview = resolved.state.planReview as { revisionCount?: number } | undefined;
    return planReview?.revisionCount;
  }

  const planArgs = (featureId: string, repoRoot?: string): PrepareReviewArgs => ({
    featureId,
    scope: 'plan',
    artifact: 'docs/specs/2026-07-03-feat.md',
    ...(repoRoot ? { repoRoot } : {}),
  });

  it('PlanReview_ReprovisionWithoutTransition_StillCountedAndCapped', async () => {
    // THE EXACT BYPASS, CLOSED. Re-provision repeatedly through the seam WITHOUT
    // ever traversing the `plan-review → plan` HSM edge (the seam involves no
    // transition at all — every call is "without transition" by construction).
    // The count still rises and the over-cap call is refused. Default cap = 1.
    const featureId = 'dr2-bypass';

    await callPrepareReview(planArgs(featureId)); // initial (revision 0)
    expect(await revisionCount(featureId)).toBe(0);

    await callPrepareReview(planArgs(featureId)); // re-dispatch (revision 1) — no transition
    expect(await revisionCount(featureId)).toBe(1); // count ROSE despite no edge traversal

    const refused = await callPrepareReview(planArgs(featureId)); // over cap — no transition
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('PLAN_REVISIONS_EXHAUSTED');

    // The loop is bounded: no third dispatch, count pinned at the cap.
    expect(await eventStore.query(featureId, { type: DISPATCH_EVENT })).toHaveLength(2);
    expect(await revisionCount(featureId)).toBe(1);
  });

  it('PlanReview_OffByOne_PermitsExactlyNCycles', async () => {
    // `max-plan-revisions: N` permits EXACTLY N revise-and-re-review cycles; the
    // initial review is NOT a revision. With N=3: the initial + 3 re-dispatches
    // are provisioned (calls 1..4), the 4th re-dispatch (call 5) is refused.
    const N = 3;
    const repo = mkdtempSync(join(tmpdir(), 'dr2-offbyone-'));
    try {
      writeFileSync(join(repo, '.exarchos.yml'), `workflow:\n  max-plan-revisions: ${N}\n`);
      const featureId = 'dr2-offbyone';

      // Initial (revision 0) + N re-dispatches (revisions 1..N) all succeed.
      for (let i = 0; i <= N; i++) {
        const r = await callPrepareReview(planArgs(featureId, repo));
        expect(r.success, `call ${i} (revision ${Math.max(0, i)}) should provision`).toBe(true);
      }
      expect(await revisionCount(featureId)).toBe(N);

      // The (N+1)-th re-dispatch is refused at the seam.
      const refused = await callPrepareReview(planArgs(featureId, repo));
      expect(refused.success).toBe(false);
      expect(refused.error?.code).toBe('PLAN_REVISIONS_EXHAUSTED');
      expect(refused.error?.message).toContain(`${N}/${N}`);

      // Exactly N+1 dispatch markers persisted (1 initial + N revisions); the
      // refused call added none.
      expect(await eventStore.query(featureId, { type: DISPATCH_EVENT })).toHaveLength(N + 1);
    } finally {
      await rmrfAsync(repo);
    }
  });

  it('PlanReview_SurvivesVerdict_ConsumesZero', async () => {
    // A "survives" verdict yields no re-dispatch (the agent does not call the
    // seam again), so it consumes ZERO revisions: revisionCount stays 0 and only
    // the initial ordinal-0 marker exists. Contrast a gaps verdict, which drives
    // a counted re-dispatch.
    const featureId = 'dr2-survives';
    const r = await callPrepareReview(planArgs(featureId)); // initial review — survives
    expect(r.success).toBe(true);

    // No re-dispatch → zero revisions consumed.
    const events = await eventStore.query(featureId, { type: DISPATCH_EVENT });
    expect(events).toHaveLength(1);
    expect((events[0].data as { ordinal: number }).ordinal).toBe(0);
    expect(await revisionCount(featureId)).toBe(0);
  });
});
