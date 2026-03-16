import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handlePrepareReview } from './prepare-review.js';
import { QUALITY_CHECK_CATALOG } from '../review/check-catalog.js';

const stateDir = '/tmp/test-prepare-review';

describe('handlePrepareReview', () => {
  it('HandlePrepareReview_DefaultArgs_ReturnsCatalogWithAllDimensions', async () => {
    const result = await handlePrepareReview({ featureId: 'test-default' }, stateDir);
    expect(result.success).toBe(true);
    const data = (result as any).data;
    expect(data.catalog.dimensions.length).toBe(QUALITY_CHECK_CATALOG.dimensions.length);
  });

  it('HandlePrepareReview_DimensionFilter_ReturnsOnlyRequestedDimensions', async () => {
    const result = await handlePrepareReview({
      featureId: 'test-filter',
      dimensions: ['error-handling', 'resilience'],
    }, stateDir);
    expect(result.success).toBe(true);
    const data = (result as any).data;
    expect(data.catalog.dimensions.length).toBe(2);
    expect(data.catalog.dimensions.map((d: any) => d.id)).toEqual(['error-handling', 'resilience']);
  });

  it('HandlePrepareReview_InvalidDimension_ReturnsError', async () => {
    const result = await handlePrepareReview({
      featureId: 'test-invalid',
      dimensions: ['nonexistent-dimension'],
    }, stateDir);
    expect(result.success).toBe(false);
    expect((result as any).error.code).toBe('INVALID_INPUT');
  });

  it('HandlePrepareReview_PluginStatusNoConfig_DefaultsToEnabled', async () => {
    const result = await handlePrepareReview({ featureId: 'test-plugin-default' }, stateDir);
    expect(result.success).toBe(true);
    const data = (result as any).data;
    expect(data.pluginStatus.axiom.enabled).toBe(true);
    expect(data.pluginStatus.impeccable.enabled).toBe(true);
  });

  it('HandlePrepareReview_FindingFormatIncluded_IsNonEmptyString', async () => {
    const result = await handlePrepareReview({ featureId: 'test-format' }, stateDir);
    expect(result.success).toBe(true);
    const data = (result as any).data;
    expect(typeof data.findingFormat).toBe('string');
    expect(data.findingFormat.length).toBeGreaterThan(0);
  });

  it('HandlePrepareReview_CatalogVersion_MatchesCatalogConstant', async () => {
    const result = await handlePrepareReview({ featureId: 'test-version' }, stateDir);
    expect(result.success).toBe(true);
    const data = (result as any).data;
    expect(data.catalog.version).toBe(QUALITY_CHECK_CATALOG.version);
  });

  it('HandlePrepareReview_MissingFeatureId_ReturnsError', async () => {
    const result = await handlePrepareReview({ featureId: '' }, stateDir);
    expect(result.success).toBe(false);
  });

  // ─── Config-driven plugin status ──────────────────────────────────────

  describe('config-driven plugin status', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'prepare-review-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('HandlePrepareReview_RepoRootWithConfig_ReadsPluginStatus', async () => {
      writeFileSync(join(tempDir, '.exarchos.yml'), `plugins:\n  axiom:\n    enabled: false\n  impeccable:\n    enabled: true\n`);
      const result = await handlePrepareReview({ featureId: 'test-config', repoRoot: tempDir }, stateDir);
      expect(result.success).toBe(true);
      const data = (result as any).data;
      expect(data.pluginStatus.axiom.enabled).toBe(false);
      expect(data.pluginStatus.impeccable.enabled).toBe(true);
    });

    it('HandlePrepareReview_RepoRootNoConfig_DefaultsToEnabled', async () => {
      // tempDir exists but has no .exarchos.yml
      const result = await handlePrepareReview({ featureId: 'test-no-config', repoRoot: tempDir }, stateDir);
      expect(result.success).toBe(true);
      const data = (result as any).data;
      expect(data.pluginStatus.axiom.enabled).toBe(true);
      expect(data.pluginStatus.impeccable.enabled).toBe(true);
    });

    it('HandlePrepareReview_NoRepoRoot_DefaultsToEnabled', async () => {
      const result = await handlePrepareReview({ featureId: 'test-no-root' }, stateDir);
      expect(result.success).toBe(true);
      const data = (result as any).data;
      expect(data.pluginStatus.axiom.enabled).toBe(true);
      expect(data.pluginStatus.impeccable.enabled).toBe(true);
    });
  });
});
