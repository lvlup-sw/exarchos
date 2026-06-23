import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handlePrepareReview, type PrepareReviewArgs } from './prepare-review.js';
import { QUALITY_CHECK_CATALOG } from '../review/check-catalog.js';
import { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';

// ─── Typed assertion helpers ────────────────────────────────────────────────

interface PrepareReviewData {
  catalog: { version: string; dimensions: readonly { id: string }[] };
  findingFormat: string;
  pluginStatus: {
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

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
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

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
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
});
