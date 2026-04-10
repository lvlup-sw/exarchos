import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleGet,
  handleInit,
  handleSet,
  configureWorkflowMaterializer,
} from './tools.js';
import { getRequiredReviews } from './review-contract.js';

describe('handleGet playbook field', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'playbook-test-'));
  });

  afterEach(async () => {
    configureWorkflowMaterializer(null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('handleGet_PlaybookField_ReturnsPhasePlaybook', async () => {
    // Arrange: create feature workflow (starts in 'ideate' phase)
    const initResult = await handleInit({ featureId: 'test-feature', workflowType: 'feature' }, tmpDir, null);
    expect(initResult.success).toBe(true);
    // Transition to delegate (ideate -> plan -> plan-review -> delegate)
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

    // Act
    const result = await handleGet(
      { featureId: 'test-feature', fields: ['playbook'] },
      tmpDir,
      null,
    );

    // Assert
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('playbook');
    const playbook = (result.data as Record<string, unknown>).playbook;
    expect(playbook).not.toBeNull();
    expect((playbook as Record<string, unknown>).phase).toBe('delegate');
    expect((playbook as Record<string, unknown>).skill).toBe('delegation');
  });

  it('handleGet_PlaybookField_ReturnsPlaybookForInitialPhase', async () => {
    // Arrange: create feature workflow (starts in 'ideate' phase)
    const initResult = await handleInit({ featureId: 'test-ideate', workflowType: 'feature' }, tmpDir, null);
    expect(initResult.success).toBe(true);

    // Act
    const result = await handleGet(
      { featureId: 'test-ideate', fields: ['playbook'] },
      tmpDir,
      null,
    );

    // Assert
    expect(result.success).toBe(true);
    const playbook = (result.data as Record<string, unknown>).playbook;
    expect(playbook).not.toBeNull();
    expect((playbook as Record<string, unknown>).phase).toBe('ideate');
    expect((playbook as Record<string, unknown>).skill).toBe('brainstorming');
    expect((playbook as Record<string, unknown>).workflowType).toBe('feature');
  });

  it('handleGet_PlaybookWithOtherFields_ReturnsBoth', async () => {
    // Arrange
    const initResult = await handleInit({ featureId: 'test-both', workflowType: 'feature' }, tmpDir, null);
    expect(initResult.success).toBe(true);

    // Act
    const result = await handleGet(
      { featureId: 'test-both', fields: ['playbook', 'phase'] },
      tmpDir,
      null,
    );

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('playbook');
    expect(data).toHaveProperty('phase');
    expect(data.phase).toBe('ideate');
    const playbook = data.playbook as Record<string, unknown>;
    expect(playbook.phase).toBe('ideate');
  });

  it('handleGet_PlaybookField_WorksForDebugWorkflow', async () => {
    // Arrange: create debug workflow (starts in 'triage' phase)
    const initResult = await handleInit({ featureId: 'test-debug', workflowType: 'debug' }, tmpDir, null);
    expect(initResult.success).toBe(true);

    // Act
    const result = await handleGet(
      { featureId: 'test-debug', fields: ['playbook'] },
      tmpDir,
      null,
    );

    // Assert
    expect(result.success).toBe(true);
    const playbook = (result.data as Record<string, unknown>).playbook;
    expect(playbook).not.toBeNull();
    expect((playbook as Record<string, unknown>).phase).toBe('triage');
    expect((playbook as Record<string, unknown>).skill).toBe('debug');
  });
});

// ─── Review contract wiring (behavioral — exercises tools.ts path) ─────────
//
// These tests exercise the full handleSet → guard path rather than reading
// the review-contract module directly. `_requiredReviews` is a transient
// guard-evaluation field and is deleted from state after the guard runs
// (tools.ts, `delete mutableState._requiredReviews`), so the only
// observable effect of the contract wiring is whether the guard accepts or
// rejects the review → synthesize transition.
//
// If a future regression replaces the `getRequiredReviews(workflowType)`
// call in tools.ts with an inline hardcoded list — say, the old
// `spec-compliance`/`code-quality` — these tests fail because the guard
// will reject a state that contains `spec-review`/`quality-review`.
// Addresses CodeRabbit nitpick on PR #1076.

describe('review-contract wiring through handleSet', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-contract-wiring-'));
  });

  afterEach(async () => {
    configureWorkflowMaterializer(null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Seed a feature workflow directly at the `review` phase with the
   * given reviews map. Bypasses the full state machine walk (ideate →
   * plan → … → review) which isn't what these tests care about — we're
   * testing the `review → synthesize` injection of `_requiredReviews`
   * from `review-contract.ts`. Keeps `tasks: []` so `all-tasks-complete`
   * (if ever composed into this transition) is trivially satisfied.
   */
  async function seedFeatureAtReview(
    featureId: string,
    reviews: Record<string, unknown>,
  ): Promise<void> {
    // Init through handleInit so schema bootstrap (version, timestamps,
    // _events arrays, etc.) is handled correctly.
    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, null);

    // Patch phase + reviews directly on disk. Preserves the init-written
    // schema-compliant shape for every other field.
    const stateFile = path.join(tmpDir, `${featureId}.state.json`);
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Record<string, unknown>;
    raw.phase = 'review';
    raw.reviews = reviews;
    raw.updatedAt = new Date().toISOString();
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2));
  }

  it('HandleSet_FeatureReviewToSynthesize_CanonicalDimensions_AdvancesPastGuard', async () => {
    // Arrange: seed review phase with canonical contract dimension names.
    await seedFeatureAtReview('contract-wiring-canonical', {
      'spec-review': { status: 'pass' },
      'quality-review': { status: 'pass' },
    });

    // Act: attempt review → synthesize. tools.ts MUST inject
    // _requiredReviews from getRequiredReviews('feature') for the guard
    // to pass. If a future regression hardcodes a different list the
    // guard will reject with "Missing required review dimensions".
    const result = await handleSet(
      { featureId: 'contract-wiring-canonical', phase: 'synthesize' },
      tmpDir, null,
    );

    expect(result.success).toBe(true);
    // Sanity check that the contract still returns the names this test
    // wrote — any rename forces a rename here too.
    expect(getRequiredReviews('feature')).toEqual(['spec-review', 'quality-review']);
  });

  it('HandleSet_FeatureReviewToSynthesize_ExplicitEmptyRequiredReviews_OverridesDefaults', async () => {
    // Arrange: seed review phase with ONLY an arbitrary review entry —
    // no canonical contract dimensions. Under default config the guard
    // rejects (spec-review + quality-review missing), but with the
    // explicit empty override no dimensions are required.
    await seedFeatureAtReview('contract-wiring-empty-override', {
      arbitrary: { status: 'pass' },
    });

    // Act: transition with explicit empty override. Prior to the fix,
    // `options.requiredReviews?.length` treated `[]` as "not provided"
    // and fell back to workflow defaults, silently ignoring the caller.
    const result = await handleSet(
      { featureId: 'contract-wiring-empty-override', phase: 'synthesize' },
      tmpDir, null,
      { requiredReviews: [] },
    );

    expect(result.success).toBe(true);
  });
});
