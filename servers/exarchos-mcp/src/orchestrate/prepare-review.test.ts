import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handlePrepareReview } from './prepare-review.js';
import { QUALITY_CHECK_CATALOG } from '../review/check-catalog.js';
import type { ToolResult } from '../format.js';

// ─── Typed assertion helpers ────────────────────────────────────────────────

interface PrepareReviewData {
  catalog: { version: string; dimensions: readonly { id: string }[] };
  findingFormat: string;
  pluginStatus: {
    axiom: { enabled: boolean };
    impeccable: { enabled: boolean };
  };
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

const stateDir = '/tmp/test-prepare-review';

describe('handlePrepareReview', () => {
  it('HandlePrepareReview_DefaultArgs_ReturnsCatalogWithAllDimensions', async () => {
    const data = expectSuccess(await handlePrepareReview({ featureId: 'test-default' }, stateDir));
    expect(data.catalog.dimensions.length).toBe(QUALITY_CHECK_CATALOG.dimensions.length);
  });

  it('HandlePrepareReview_DimensionFilter_ReturnsOnlyRequestedDimensions', async () => {
    const data = expectSuccess(await handlePrepareReview({
      featureId: 'test-filter',
      dimensions: ['error-handling', 'resilience'],
    }, stateDir));
    expect(data.catalog.dimensions.length).toBe(2);
    expect(data.catalog.dimensions.map(d => d.id)).toEqual(['error-handling', 'resilience']);
  });

  it('HandlePrepareReview_InvalidDimension_ReturnsError', async () => {
    const err = expectError(await handlePrepareReview({
      featureId: 'test-invalid',
      dimensions: ['nonexistent-dimension'],
    }, stateDir));
    expect(err.code).toBe('INVALID_INPUT');
  });

  it('HandlePrepareReview_PluginStatusNoConfig_DefaultsToEnabled', async () => {
    const data = expectSuccess(await handlePrepareReview({ featureId: 'test-plugin-default' }, stateDir));
    expect(data.pluginStatus.axiom.enabled).toBe(true);
    expect(data.pluginStatus.impeccable.enabled).toBe(true);
  });

  it('HandlePrepareReview_FindingFormatIncluded_IsNonEmptyString', async () => {
    const data = expectSuccess(await handlePrepareReview({ featureId: 'test-format' }, stateDir));
    expect(typeof data.findingFormat).toBe('string');
    expect(data.findingFormat.length).toBeGreaterThan(0);
  });

  it('HandlePrepareReview_CatalogVersion_MatchesCatalogConstant', async () => {
    const data = expectSuccess(await handlePrepareReview({ featureId: 'test-version' }, stateDir));
    expect(data.catalog.version).toBe(QUALITY_CHECK_CATALOG.version);
  });

  it('HandlePrepareReview_MissingFeatureId_ReturnsError', async () => {
    const err = expectError(await handlePrepareReview({ featureId: '' }, stateDir));
    expect(err.code).toBe('INVALID_INPUT');
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
      const data = expectSuccess(await handlePrepareReview({ featureId: 'test-config', repoRoot: tempDir }, stateDir));
      expect(data.pluginStatus.axiom.enabled).toBe(false);
      expect(data.pluginStatus.impeccable.enabled).toBe(true);
    });

    it('HandlePrepareReview_RepoRootNoConfig_DefaultsToEnabled', async () => {
      const data = expectSuccess(await handlePrepareReview({ featureId: 'test-no-config', repoRoot: tempDir }, stateDir));
      expect(data.pluginStatus.axiom.enabled).toBe(true);
      expect(data.pluginStatus.impeccable.enabled).toBe(true);
    });

    it('HandlePrepareReview_NoRepoRoot_DefaultsToEnabled', async () => {
      const data = expectSuccess(await handlePrepareReview({ featureId: 'test-no-root' }, stateDir));
      expect(data.pluginStatus.axiom.enabled).toBe(true);
      expect(data.pluginStatus.impeccable.enabled).toBe(true);
    });
  });
});
