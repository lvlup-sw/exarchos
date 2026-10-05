import { describe, it, expect } from 'vitest';
import { projectCatalog } from '../../../src/architecture/project-catalog.js';
import type { InvariantEntry } from '../../../src/architecture/invariants-loader.js';

/**
 * Builds a minimal `InvariantEntry`. The projection reads only `axis`, `appliesTo`, `phaseAffinity`
 * and `workflowAffinity`. The other fields hold defaults that satisfy the type.
 */
function entry(id: string, overrides: Partial<InvariantEntry> = {}): InvariantEntry {
  return {
    id,
    dimension: 'test',
    axis: 'substrate',
    costOfLoad: 'always-load',
    appliesTo: [],
    summary: 'summary',
    references: [],
    raw: {},
    ...overrides,
  };
}

describe('projectCatalog', () => {
  /** An entry with no phase affinity applies to every phase. */
  it('ProjectCatalog_PhaseReview_ExcludesIdeateOnlyEntries', () => {
    const ideateOnly = entry('INV-ideate', { phaseAffinity: ['ideate'] });
    const reviewScoped = entry('INV-review', { phaseAffinity: ['review'] });
    const noAffinity = entry('INV-any');

    const result = projectCatalog([ideateOnly, reviewScoped, noAffinity], {
      phase: 'review',
      workflowType: 'feature',
    });

    const ids = result.map((e) => e.id);
    expect(ids).not.toContain('INV-ideate');
    expect(ids).toContain('INV-review');
    expect(ids).toContain('INV-any');
  });

  /**
   * A `discovery` projection excludes each substrate invariant, so the review gate does not fire on code dimensions.
   * The substrate fixture has no workflow affinity, so only the axis check can exclude it.
   * An authoring invariant stays.
   */
  it('ProjectCatalog_DiscoverySubstrateInvariant_Excluded', () => {
    const codeAxis = entry('INV-code', {
      axis: 'substrate',
      appliesTo: ['src/**'],
    });
    const authoringAxis = entry('DIM-8', {
      axis: 'authoring',
      appliesTo: ['docs/**'],
    });

    const result = projectCatalog([codeAxis, authoringAxis], {
      phase: 'review',
      workflowType: 'discovery',
    });

    const ids = result.map((e) => e.id);
    expect(ids).not.toContain('INV-code');
    expect(ids).toContain('DIM-8');
  });

  /** The touched file matches only the `appliesTo` patterns of the docs invariant. */
  it('ProjectCatalog_DelegateDocsOnlyTask_NoCodeInvariantInjection', () => {
    const codeInvariant = entry('INV-src', {
      axis: 'substrate',
      appliesTo: ['src/**', 'servers/**'],
    });
    const docsInvariant = entry('DIM-docs', {
      axis: 'authoring',
      appliesTo: ['docs/**'],
    });

    const result = projectCatalog([codeInvariant, docsInvariant], {
      phase: 'delegate',
      workflowType: 'feature',
      touchedFiles: ['docs/architecture/invariants.md'],
    });

    const ids = result.map((e) => e.id);
    expect(ids).not.toContain('INV-src');
    expect(ids).toContain('DIM-docs');
  });
});
