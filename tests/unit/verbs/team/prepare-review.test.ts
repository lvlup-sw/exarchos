import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handlePrepareReview, type PrepareReviewArgs } from '../../../../src/verbs/team/prepare-review.js';
import { QUALITY_CHECK_CATALOG } from '../../../../src/review/check-catalog.js';
import { EventStore } from '../../../../src/events/store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { resolveWorkflowState } from '../../../../src/verbs/resolve-state.js';
import type { ToolResult } from '../../../../src/format.js';

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

/** Each test gets a real event store and state directory, which the handler takes as arguments. */
let stateDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'prepare-review-state-'));
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
});

/** Closes the store before removal, because an open SQLite handle makes removal fail on Windows. */
afterEach(async () => {
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

  /** Plan review is an adversarial gate in a fresh context. Its rung scales with `designDepth`. */
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

    /**
     * The reviewer gets only the artifact and the spec. The provisioned context has no
     * key that can carry the authoring transcript.
     */
    it('PlanReview_DispatchedReviewer_ReceivesNoAuthorTranscript', async () => {
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
      expect(data.provisionedContext.authoringTranscriptIncluded).toBe(false);
      expect('transcript' in data.provisionedContext).toBe(false);
      expect('authoringContext' in data.provisionedContext).toBe(false);
      expect(data.instruction.toLowerCase()).toContain('transcript');
    });

    /** The instruction asks the reviewer to refute the plan. The verdict lists gaps, not a score. */
    it('PlanReview_RefutationPosture_EmitsEvidenceVerdict', async () => {
      const data = planData(
        await callPrepareReview(
          { featureId: 'pr-feat', scope: 'plan-review', artifact: 'docs/specs/x.md' },
        ),
      );
      expect(data.adversarial).toBe(true);
      expect(data.instruction.toLowerCase()).toMatch(/refute|reject/);
      expect(data.verdictFormat).toContain('PlanReviewVerdict');
      expect(data.verdictFormat).toContain('gaps');
      expect(data.verdictFormat).toMatch(/refuted|survives/);
    });

    /** A thin design gets one voter, so the cost stays in proportion to the risk. */
    it('PlanReview_ThinDepth_UsesLightRung', async () => {
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

    /** The artifact holds its own design rationale, so an omitted spec falls back to the artifact. */
    it('PlanReview_NoSpec_DefaultsToUnifiedArtifact', async () => {
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

    /** The plan-review branch must not take code-review calls. */
    it('PrepareReview_NonPlanScope_ServesCodeReviewCatalogUnchanged', async () => {
      const data = expectSuccess(
        await callPrepareReview({ featureId: 'cr-feat', scope: 'code' }),
      );
      expect((data as { catalog?: unknown }).catalog).toBeDefined();
    });
  });

  /**
   * The code review grounds its spec-review checklist in the captured intent. Without a
   * resolvable intent, the review uses only the diff. `seedRepoWithDiff` builds a
   * repository whose `main...HEAD` diff is one file, so the tests do not read the live tree.
   */
  describe('intent grounding (DR-1 task 005)', () => {
    async function seedRepoWithDiff(): Promise<string> {
      const repo = mkdtempSync(join(tmpdir(), 'prepare-review-repo-'));
      const git = async (...a: string[]): Promise<void> => {
        await execFileAsync('git', a, { cwd: repo });
      };
      await git('init', '-q', '-b', 'main');
      await git('config', 'user.email', 'test@example.com');
      await git('config', 'user.name', 'Test');
      writeFileSync(join(repo, 'base.txt'), 'base\n');
      await git('add', '-A');
      await git('commit', '-qm', 'base');
      await git('checkout', '-q', '-b', 'feat');
      mkdirSync(join(repo, 'servers'), { recursive: true });
      writeFileSync(join(repo, 'servers', 'a.ts'), 'export const x = 1;\n');
      await git('add', '-A');
      await git('commit', '-qm', 'change');
      return repo;
    }

    it('PrepareReview_WithIntent_GroundsSpecReviewChecklist', async () => {
      const repo = await seedRepoWithDiff();
      try {
        const data = expectSuccess(
          await callPrepareReview({ featureId: 'cr-grounded', repoRoot: repo, scope: 'code' }),
        );
        expect(data.intent?.changedFiles).toContain('servers/a.ts');
        expect(data.intentGrounding).toBeDefined();
        const grounding = data.intentGrounding as IntentGrounding;
        expect(grounding.mode).toBe('intended-vs-delivered');
        expect(grounding.intended.surfaces).toEqual(data.intent?.surfaces);
        expect(grounding.intended.summary).toBe(data.intent?.summary);
        expect(grounding.intended.surfaces).toContain('servers');
        expect(grounding.instruction.toLowerCase()).toContain('intended');
        expect(grounding.instruction.toLowerCase()).toContain('delivered');
        expect(data.catalog.dimensions.length).toBe(QUALITY_CHECK_CATALOG.dimensions.length);
      } finally {
        await rmrfAsync(repo);
      }
    });

    /** A `repoRoot` that is not a git repository gives no changed files and an empty intent. */
    it('PrepareReview_NoIntent_DegradesToDiffOnly', async () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'prepare-review-empty-'));
      try {
        const data = expectSuccess(
          await callPrepareReview({ featureId: 'cr-no-intent', repoRoot: emptyDir, scope: 'code' }),
        );
        expect(data.intent?.changedFiles).toEqual([]);
        expect(data.intentGrounding).toBeUndefined();
        expect('intentGrounding' in data).toBe(false);
        expect(data.catalog.dimensions.length).toBe(QUALITY_CHECK_CATALOG.dimensions.length);
      } finally {
        await rmrfAsync(emptyDir);
      }
    });
  });
});

/**
 * An agent calls `prepare_review` with `scope: 'plan'` to get a plan review, so this
 * action bounds the revision loop. Each call appends a `workflow.plan-review-dispatched`
 * event with an ordinal. The projection folds the highest ordinal into
 * `planReview.revisionCount`, which the `revisionsExhausted` guard reads. A call past
 * the cap is refused with a `blocked` next action.
 */
describe('plan-review bound at the provisioning seam (WLM-6 DR-2, task 004)', () => {
  const DISPATCH_EVENT = 'workflow.plan-review-dispatched';

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

  /** The first review appends an ordinal 0 marker, and the projection folds ordinal 0 to a count of 0. */
  it('PrepareReviewPlan_InitialDispatch_EmitsNoCounter', async () => {
    const featureId = 'dr2-initial';
    const result = await callPrepareReview(planArgs(featureId));
    expect(result.success).toBe(true);
    expect((result.data as { mode: string }).mode).toBe('plan-review');

    const events = await eventStore.query(featureId, { type: DISPATCH_EVENT });
    expect(events).toHaveLength(1);
    expect((events[0].data as { ordinal: number }).ordinal).toBe(0);
    expect(await revisionCount(featureId)).toBe(0);
  });

  /** A second call appends ordinal 1, which folds to a count of 1. */
  it('PrepareReviewPlan_ReDispatch_EmitsCountedEvent', async () => {
    const featureId = 'dr2-redispatch';
    await callPrepareReview(planArgs(featureId));
    const result = await callPrepareReview(planArgs(featureId));
    expect(result.success).toBe(true);

    const events = await eventStore.query(featureId, { type: DISPATCH_EVENT });
    expect(events).toHaveLength(2);
    expect((events[1].data as { ordinal: number }).ordinal).toBe(1);
    expect(await revisionCount(featureId)).toBe(1);
  });

  /**
   * With the default cap of 1 and no `repoRoot`, the third call is refused. The refusal
   * names the count and the cap, offers `blocked`, and appends no event.
   */
  it('PrepareReviewPlan_PastCap_RefusesWithBlockedAffordance', async () => {
    const featureId = 'dr2-cap';
    await callPrepareReview(planArgs(featureId));
    await callPrepareReview(planArgs(featureId));
    expect(await revisionCount(featureId)).toBe(1);

    const refused = await callPrepareReview(planArgs(featureId));
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('PLAN_REVISIONS_EXHAUSTED');
    expect(refused.error?.message).toContain('1/1');
    expect(refused.error?.validTargets).toContain('blocked');
    expect(refused.error?.suggestedFix?.params).toMatchObject({ to: 'blocked' });
    const nextActions = refused.next_actions as { verb: string; validTargets?: string[] }[];
    expect(nextActions?.some((a) => a.verb === 'blocked')).toBe(true);

    const events = await eventStore.query(featureId, { type: DISPATCH_EVENT });
    expect(events).toHaveLength(2);
    expect(await revisionCount(featureId)).toBe(1);
  });

  /** The event key holds the feature ID and the ordinal, so the store drops a second append of the same ordinal. */
  it('PrepareReviewPlan_CrashRetrySameOrdinal_IdempotentByKey', async () => {
    const featureId = 'dr2-idempotent';
    await callPrepareReview(planArgs(featureId));
    await callPrepareReview(planArgs(featureId));
    const before = await eventStore.query(featureId, { type: DISPATCH_EVENT });
    expect(before).toHaveLength(2);
    expect(before[1].idempotencyKey).toBe(`${featureId}:plan-review-dispatch:1`);

    await eventStore.append(
      featureId,
      { type: DISPATCH_EVENT, data: { featureId, ordinal: 1 } },
      { idempotencyKey: `${featureId}:plan-review-dispatch:1` },
    );

    const after = await eventStore.query(featureId, { type: DISPATCH_EVENT });
    expect(after).toHaveLength(2);
    expect(await revisionCount(featureId)).toBe(1);
  });

  /** The artifact check runs first, so a bad request appends no dispatch event. */
  it('PrepareReviewPlan_MissingArtifact_RefusesBeforeAnyEmission', async () => {
    const featureId = 'dr2-noartifact';
    const result = await callPrepareReview({ featureId, scope: 'plan' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(await eventStore.query(featureId, { type: DISPATCH_EVENT })).toHaveLength(0);
  });
});

/**
 * The bound holds when the agent never takes the transition from `plan-review` to
 * `plan`. The initial review is not a revision.
 */
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

  /** The calls make no transition, but the count still rises and the call past the default cap of 1 is refused. */
  it('PlanReview_ReprovisionWithoutTransition_StillCountedAndCapped', async () => {
    const featureId = 'dr2-bypass';

    await callPrepareReview(planArgs(featureId));
    expect(await revisionCount(featureId)).toBe(0);

    await callPrepareReview(planArgs(featureId));
    expect(await revisionCount(featureId)).toBe(1);

    const refused = await callPrepareReview(planArgs(featureId));
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('PLAN_REVISIONS_EXHAUSTED');

    expect(await eventStore.query(featureId, { type: DISPATCH_EVENT })).toHaveLength(2);
    expect(await revisionCount(featureId)).toBe(1);
  });

  /** `max-plan-revisions: N` permits N re-dispatches after the initial review and refuses the next one. */
  it('PlanReview_OffByOne_PermitsExactlyNCycles', async () => {
    const N = 3;
    const repo = mkdtempSync(join(tmpdir(), 'dr2-offbyone-'));
    try {
      writeFileSync(join(repo, '.exarchos.yml'), `workflow:\n  max-plan-revisions: ${N}\n`);
      const featureId = 'dr2-offbyone';

      for (let i = 0; i <= N; i++) {
        const r = await callPrepareReview(planArgs(featureId, repo));
        expect(r.success, `call ${i} (revision ${Math.max(0, i)}) should provision`).toBe(true);
      }
      expect(await revisionCount(featureId)).toBe(N);

      const refused = await callPrepareReview(planArgs(featureId, repo));
      expect(refused.success).toBe(false);
      expect(refused.error?.code).toBe('PLAN_REVISIONS_EXHAUSTED');
      expect(refused.error?.message).toContain(`${N}/${N}`);

      expect(await eventStore.query(featureId, { type: DISPATCH_EVENT })).toHaveLength(N + 1);
    } finally {
      await rmrfAsync(repo);
    }
  });

  /** A "survives" verdict leads to no second call, so the count stays 0. */
  it('PlanReview_SurvivesVerdict_ConsumesZero', async () => {
    const featureId = 'dr2-survives';
    const r = await callPrepareReview(planArgs(featureId));
    expect(r.success).toBe(true);

    const events = await eventStore.query(featureId, { type: DISPATCH_EVENT });
    expect(events).toHaveLength(1);
    expect((events[0].data as { ordinal: number }).ordinal).toBe(0);
    expect(await revisionCount(featureId)).toBe(0);
  });
});
