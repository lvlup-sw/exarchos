// @oracle-sources: ../../../src/events/event-annotations.ts, ../../../tools/evals/evals/harness.ts
// The two sources are independent: the annotation table holds the claim of the `harness` row, and
// the harness module shows what the tree does. The catalog does not import developer tooling, and
// the harness does not read the catalog. `registration-validate.ts` is the audit under test and
// reaches the annotation table, so it is a derived authority and is not in the list.
//
// The weld of the `harness` tier, checked against the tree.
// `WELD_RESOLUTION_POLICY.harness` is `resolvedAt: 'never'`: no registry of developer harnesses
// exists, and filesystem IO at each process start is a cost for each entry point.
// This file is where the check runs. Without it, the tier is an escape hatch from the other tiers.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EVENT_ANNOTATIONS } from '../../../src/events/event-annotations.js';
import { auditHarnessWelds } from '../../../src/events/registration-validate.js';
import type { EventRegistration } from '../../../src/events/event-registration.js';

const REPO_ROOT = process.cwd();

/** The real reader — repo-relative in, source out, `undefined` when the file is not there. */
const readFromDisk = (relativePath: string): string | undefined => {
  try {
    return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
  } catch {
    return undefined;
  }
};

const harnessRow = (module: string): EventRegistration => ({
  lifecycle: 'active',
  tier: 'harness',
  module,
  consumedBy: ['eval-results'],
});

describe('harness welds', () => {
  /**
   * The denominator comes first: an audit that assessed nothing returns no diagnostics, which
   * looks like a clean tree.
   */
  it('HarnessWelds_LiveCatalog_EveryRowHoldsAgainstTheTree', () => {
    const audit = auditHarnessWelds(EVENT_ANNOTATIONS, readFromDisk);

    expect(audit.assessedCount, 'no harness registration was assessed').toBeGreaterThan(0);
    expect(audit.diagnostics).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  /**
   * An emitter under `src/` has a real weld available. If one registers as `harness`, the tier
   * becomes an escape hatch for each emitter.
   * Containment causes the rejection, and not absence: the audit accepts a readable module
   * outside the governed root that appends its event.
   */
  it('HarnessWelds_ModuleInsideGovernedRoot_IsRejected', () => {
    const audit = auditHarnessWelds(
      { 'seeded.event': harnessRow('src/events/store.ts') },
      readFromDisk,
    );

    expect(audit.ok).toBe(false);
    expect(audit.assessedCount).toBe(1);
    expect(audit.diagnostics).toHaveLength(1);
    expect(audit.diagnostics[0]?.code).toBe('HARNESS_MODULE_INSIDE_GOVERNED_ROOT');

    const outside = auditHarnessWelds(
      { 'eval.judge.calibrated': harnessRow('tools/evals/evals/harness.ts') },
      readFromDisk,
    );
    expect(outside.ok).toBe(true);
  });

  it('HarnessWelds_MissingModule_IsRejected', () => {
    const audit = auditHarnessWelds(
      { 'seeded.event': harnessRow('tools/__not-here__/harness.ts') },
      readFromDisk,
    );

    expect(audit.ok).toBe(false);
    expect(audit.diagnostics[0]?.code).toBe('HARNESS_MODULE_MISSING');
  });

  /**
   * Stale cover: a row whose module does not append the event reads as coverage and covers
   * nothing.
   */
  it('HarnessWelds_ModuleThatNeverAppends_IsRejected', () => {
    const audit = auditHarnessWelds(
      { 'seeded.event': harnessRow('tools/evals/evals/harness.ts') },
      readFromDisk,
    );

    expect(audit.ok).toBe(false);
    expect(audit.diagnostics[0]?.code).toBe('HARNESS_MODULE_DOES_NOT_APPEND');
  });

  /**
   * The tier is the filter. A capability row has no `module`, so an audit that reads one fails
   * each other registration for the wrong reason.
   */
  it('HarnessWelds_NonHarnessRows_AreNotAssessed', () => {
    const audit = auditHarnessWelds(
      {
        'seeded.capability': {
          lifecycle: 'active',
          tier: 'capability',
          provider: 'exarchos_orchestrate',
          consumedBy: ['workflow-state@v1'],
        },
      },
      readFromDisk,
    );

    expect(audit.assessedCount).toBe(0);
    expect(audit.ok).toBe(true);
  });
});
