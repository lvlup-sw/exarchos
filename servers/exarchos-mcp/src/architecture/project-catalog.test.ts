import { describe, it, expect } from 'vitest';
import { projectCatalog } from './project-catalog.js';
import type { InvariantEntry } from './invariants-loader.js';

/**
 * Minimal `InvariantEntry` factory for tests. Only the fields the
 * projection reads (`axis`, `appliesTo`, `phaseAffinity`, `workflowAffinity`)
 * are meaningful; the rest are filled with benign defaults so the shape
 * type-checks.
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
  it('ProjectCatalog_PhaseReview_ExcludesIdeateOnlyEntries', () => {
    const ideateOnly = entry('INV-ideate', { phaseAffinity: ['ideate'] });
    const reviewScoped = entry('INV-review', { phaseAffinity: ['review'] });
    const noAffinity = entry('INV-any');

    const result = projectCatalog([ideateOnly, reviewScoped, noAffinity], {
      phase: 'review',
      workflowType: 'feature',
    });

    const ids = result.map((e) => e.id);
    // Entry scoped to `ideate` only is excluded for a `review` projection.
    expect(ids).not.toContain('INV-ideate');
    // Entry that lists `review` is included.
    expect(ids).toContain('INV-review');
    // Absent phase-affinity ⇒ applies to all phases.
    expect(ids).toContain('INV-any');
  });

  it('ProjectCatalog_DiscoverWorkflow_ExcludesCodeAxisInvariants', () => {
    // A substrate (code-axis) invariant whose appliesTo are source modules.
    const codeAxis = entry('INV-code', {
      axis: 'substrate',
      appliesTo: ['src/**'],
    });
    // An authoring-axis invariant — survives a `discover` projection.
    const authoringAxis = entry('DIM-8', {
      axis: 'authoring',
      appliesTo: ['docs/**'],
    });

    const result = projectCatalog([codeAxis, authoringAxis], {
      phase: 'review',
      workflowType: 'discover',
    });

    const ids = result.map((e) => e.id);
    // For `discover`, substrate code-axis invariants are excluded so the
    // review gate does not fire on code dimensions.
    expect(ids).not.toContain('INV-code');
    expect(ids).toContain('DIM-8');
  });

  it('ProjectCatalog_DelegateDocsOnlyTask_NoCodeInvariantInjection', () => {
    // Code invariant whose appliesTo are source modules.
    const codeInvariant = entry('INV-src', {
      axis: 'substrate',
      appliesTo: ['src/**', 'servers/**'],
    });
    // Docs invariant whose appliesTo cover docs.
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
    // A docs-only task injects no code invariant.
    expect(ids).not.toContain('INV-src');
    // The docs invariant matches the touched files and is injected.
    expect(ids).toContain('DIM-docs');
  });
});
