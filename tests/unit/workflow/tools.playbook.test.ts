import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleGet,
  handleInit,
  handleSet,
  } from '../../../src/workflow/tools.js';
import { getRequiredReviews } from '../../../src/workflow/review-contract.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('handleGet playbook field', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'playbook-test-'));
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  it('handleGet_PlaybookField_ReturnsPhasePlaybook', async () => {
    const initResult = await handleInit({ featureId: 'test-feature', workflowType: 'feature' }, tmpDir, null);
    expect(initResult.success).toBe(true);
    const toPlan = await handleSet(
      { featureId: 'test-feature', updates: { 'artifacts.design': 'docs/design.md' }, phase: 'plan' },
      tmpDir,
      null,
    );
    expect(toPlan.success).toBe(true);
    const toPlanReview = await handleSet(
      { featureId: 'test-feature', updates: { 'artifacts.plan': 'docs/plan.md' }, phase: 'plan-review' },
      tmpDir,
      null,
    );
    expect(toPlanReview.success).toBe(true);
    const toDelegate = await handleSet(
      { featureId: 'test-feature', updates: { 'planReview.approved': true }, phase: 'delegate' },
      tmpDir,
      null,
    );
    expect(toDelegate.success).toBe(true);

    const result = await handleGet(
      { featureId: 'test-feature', fields: ['playbook'] },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('playbook');
    const playbook = (result.data as Record<string, unknown>).playbook;
    expect(playbook).not.toBeNull();
    expect((playbook as Record<string, unknown>).phase).toBe('delegate');
    expect((playbook as Record<string, unknown>).skill).toBe('delegate');
  });

  it('handleGet_PlaybookField_ReturnsPlaybookForInitialPhase', async () => {
    const initResult = await handleInit({ featureId: 'test-ideate', workflowType: 'feature' }, tmpDir, null);
    expect(initResult.success).toBe(true);

    const result = await handleGet(
      { featureId: 'test-ideate', fields: ['playbook'] },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const playbook = (result.data as Record<string, unknown>).playbook;
    expect(playbook).not.toBeNull();
    expect((playbook as Record<string, unknown>).phase).toBe('plan');
    expect((playbook as Record<string, unknown>).skill).toBe('plan');
    expect((playbook as Record<string, unknown>).workflowType).toBe('feature');
  });

  it('handleGet_PlaybookWithOtherFields_ReturnsBoth', async () => {
    const initResult = await handleInit({ featureId: 'test-both', workflowType: 'feature' }, tmpDir, null);
    expect(initResult.success).toBe(true);

    const result = await handleGet(
      { featureId: 'test-both', fields: ['playbook', 'phase'] },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('playbook');
    expect(data).toHaveProperty('phase');
    expect(data.phase).toBe('plan');
    const playbook = data.playbook as Record<string, unknown>;
    expect(playbook.phase).toBe('plan');
  });

  it('handleGet_PlaybookField_WorksForDebugWorkflow', async () => {
    const initResult = await handleInit({ featureId: 'test-debug', workflowType: 'debug' }, tmpDir, null);
    expect(initResult.success).toBe(true);

    const result = await handleGet(
      { featureId: 'test-debug', fields: ['playbook'] },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const playbook = (result.data as Record<string, unknown>).playbook;
    expect(playbook).not.toBeNull();
    expect((playbook as Record<string, unknown>).phase).toBe('triage');
    expect((playbook as Record<string, unknown>).skill).toBe('debug');
  });
});

/**
 * These tests run the full `handleSet` guard path. `handleSet` deletes the transient `_requiredReviews` field
 * after the guard runs, so the guard verdict on review to synthesize is the only visible effect.
 * `seedFeatureAtReview` writes the `review` phase and the reviews map to the state file directly.
 */
describe('review-contract wiring through handleSet', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-contract-wiring-'));
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  async function seedFeatureAtReview(
    featureId: string,
    reviews: Record<string, unknown>,
  ): Promise<void> {
    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, null);

    const stateFile = path.join(tmpDir, `${featureId}.state.json`);
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Record<string, unknown>;
    raw.phase = 'review';
    raw.reviews = reviews;
    raw.updatedAt = new Date().toISOString();
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2));
  }

  /** The last assertion pins the contract dimension names, so a rename in the contract breaks this test. */
  it('HandleSet_FeatureReviewToSynthesize_CanonicalDimensions_AdvancesPastGuard', async () => {
    await seedFeatureAtReview('contract-wiring-canonical', {
      review: { status: 'pass' },
    });

    const result = await handleSet(
      { featureId: 'contract-wiring-canonical', phase: 'synthesize' },
      tmpDir, null,
    );

    expect(result.success).toBe(true);
    expect(getRequiredReviews('feature')).toEqual(['review']);
  });

  /**
   * An explicit empty `requiredReviews` option requires no dimension. The seeded reviews hold no contract
   * dimension.
   */
  it('HandleSet_FeatureReviewToSynthesize_ExplicitEmptyRequiredReviews_OverridesDefaults', async () => {
    await seedFeatureAtReview('contract-wiring-empty-override', {
      arbitrary: { status: 'pass' },
    });

    const result = await handleSet(
      { featureId: 'contract-wiring-empty-override', phase: 'synthesize' },
      tmpDir, null,
      { requiredReviews: [] },
    );

    expect(result.success).toBe(true);
  });

  /**
   * `handleSet` reads the risk tier from the state after the updates apply. So a `riskTier` set in the same
   * call adds `mutation-adequacy` to the required reviews, and the guard rejects the transition.
   */
  it('HandleSet_HighTierStampedInSameTransition_RequiresMutationAdequacy', async () => {
    await seedFeatureAtReview('contract-wiring-hightier-samecall', {
      review: { status: 'pass' },
    });

    const result = await handleSet(
      {
        featureId: 'contract-wiring-hightier-samecall',
        phase: 'synthesize',
        updates: { riskTier: 'high' },
      },
      tmpDir, null,
    );

    expect(result.success).toBe(false);
    expect(getRequiredReviews('feature', 'high')).toContain('mutation-adequacy');
  });

  it('HandleSet_HighTierWithMutationAdequacyPassing_AdvancesPastGuard', async () => {
    await seedFeatureAtReview('contract-wiring-hightier-pass', {
      review: { status: 'pass' },
      'mutation-adequacy': { status: 'pass' },
    });

    const result = await handleSet(
      {
        featureId: 'contract-wiring-hightier-pass',
        phase: 'synthesize',
        updates: { riskTier: 'high' },
      },
      tmpDir, null,
    );

    expect(result.success).toBe(true);
  });
});
