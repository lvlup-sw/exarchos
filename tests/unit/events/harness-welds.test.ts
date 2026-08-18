// @oracle-sources: ../../../src/events/event-annotations.ts, ../../../tools/evals/evals/harness.ts
// Two INDEPENDENT authorities, and they are the two sides of the comparison itself: the annotation
// table supplies what the `harness` row CLAIMS, and the harness module supplies what the tree
// actually does. Neither is reachable from the other — the catalog does not import developer
// tooling, and the harness does not read the catalog — which is exactly what makes agreement
// between them evidence. `registration-validate.ts` is deliberately NOT listed: it is the audit
// under test, and the annotation table is reachable from it, so naming it would add a derived
// authority rather than a second opinion.

/**
 * The `harness` tier's weld, checked against the tree.
 *
 * `WELD_RESOLUTION_POLICY.harness` is `resolvedAt: 'never'` — there is no registry of developer
 * harnesses to resolve a path against, and doing filesystem IO on every process start for one
 * developer-tooling concern would be a cost every entry point pays. That `never` records where
 * the check is NOT. This file is where it is, and without it the tier would be exactly the
 * escape hatch the other five arms are closed to prevent.
 */

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
  it('HarnessWelds_LiveCatalog_EveryRowHoldsAgainstTheTree', () => {
    const audit = auditHarnessWelds(EVENT_ANNOTATIONS, readFromDisk);

    // DENOMINATOR FIRST. An audit that assessed nothing returns no diagnostics, which is
    // indistinguishable from a clean tree — the vacuity this repo keeps re-learning.
    expect(audit.assessedCount, 'no harness registration was assessed').toBeGreaterThan(0);
    expect(audit.diagnostics).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('HarnessWelds_ModuleInsideGovernedRoot_IsRejected', () => {
    // THE HALF THAT KEEPS THE TIER HONEST. An emitter under `src/` has a real weld available, so
    // letting one register as `harness` would turn this tier into the universal escape hatch.
    const audit = auditHarnessWelds(
      { 'seeded.event': harnessRow('src/events/store.ts') },
      readFromDisk,
    );

    expect(audit.ok).toBe(false);
    expect(audit.assessedCount).toBe(1);
    expect(audit.diagnostics).toHaveLength(1);
    expect(audit.diagnostics[0]?.code).toBe('HARNESS_MODULE_INSIDE_GOVERNED_ROOT');

    // ...and containment is what rejected it, not absence: the same path OUTSIDE the governed
    // root, with the event present, is accepted. Without this arm the assertion above would also
    // pass for a file that simply could not be read.
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

  it('HarnessWelds_ModuleThatNeverAppends_IsRejected', () => {
    // The stale-cover shape, on the newest surface. A row whose append has gone reads as
    // coverage while covering nothing, and the tier being new is no reason to grandfather it.
    const audit = auditHarnessWelds(
      { 'seeded.event': harnessRow('tools/evals/evals/harness.ts') },
      readFromDisk,
    );

    expect(audit.ok).toBe(false);
    expect(audit.diagnostics[0]?.code).toBe('HARNESS_MODULE_DOES_NOT_APPEND');
  });

  it('HarnessWelds_NonHarnessRows_AreNotAssessed', () => {
    // The tier axis is the filter. A capability row carries no `module`, and an audit that
    // reached for one would fail every other registration for the wrong reason.
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
