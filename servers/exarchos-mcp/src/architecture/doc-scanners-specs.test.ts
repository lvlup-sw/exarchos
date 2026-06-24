import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { DATED_RECORD_TREES } from './vocabulary-lint.js';
import { handleVerifyDocLinks } from '../orchestrate/verify-doc-links.js';
import { getPlaybook } from '../workflow/playbooks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

// ─── DR-9 (#1581 task 019): doc scanners include docs/specs/ ─────────────────
//
// The collapsed flow's unified artifact lives under docs/specs/. Tooling that
// processes the former docs/designs/ + docs/plans/ must include docs/specs/, and
// no LIVE feature surface may instruct writing to a path the new flow won't
// produce.

describe('doc scanners include docs/specs/ (DR-9, task 019)', () => {
  it('DocScanners_IncludeSpecsDir', () => {
    // (1) vocabulary-lint classifies docs/specs/ as a dated record tree — the
    // same exclusion as the docs/designs/ + docs/plans/ it replaces, so a
    // point-in-time spec is never retroactively linted.
    expect(DATED_RECORD_TREES).toContain('docs/specs/');
    expect(DATED_RECORD_TREES).toContain('docs/designs/');
    expect(DATED_RECORD_TREES).toContain('docs/plans/');

    // (2) the doc-link verifier processes a docs/specs/ document — it resolves an
    // internal link inside a unified spec (path-agnostic; proves the verifier
    // includes the specs dir) and flags a broken one.
    const tmp = mkdtempSync(join(tmpdir(), 'doc-scanners-'));
    try {
      const specsDir = join(tmp, 'docs', 'specs');
      mkdirSync(specsDir, { recursive: true });
      writeFileSync(join(specsDir, 'sibling.md'), '# Sibling\n');
      writeFileSync(
        join(specsDir, '2026-06-22-feat.md'),
        '# Spec\n\nResolves: [sibling](./sibling.md). Broken: [missing](./nope.md).\n',
      );
      const result = handleVerifyDocLinks({ docsDir: specsDir });
      // The handler ran over the docs/specs/ tree (it did not reject the dir),
      // and surfaced the broken link — i.e. it scanned the spec.
      const data = result.data as { brokenLinks?: Array<{ target?: string }> } | undefined;
      const serialized = JSON.stringify(result);
      expect(serialized).toContain('nope.md');
      expect(data).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('LiveSurfaces_NoStalePlanPathRefs', () => {
    // The feature-flow commands are fully on the unified artifact: they reference
    // docs/specs/ and NEVER the docs/designs/ + docs/plans/ paths the collapsed
    // flow will not produce (legacy/refactor surfaces are out of scope — they keep
    // the two-artifact path until separately migrated).
    for (const file of ['commands/ideate.md', 'commands/plan.md']) {
      const body = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(body, `${file} must reference docs/specs/`).toContain('docs/specs/');
      expect(body, `${file} must not reference docs/designs/`).not.toContain('docs/designs/');
      expect(body, `${file} must not reference docs/plans/`).not.toContain('docs/plans/');
    }

    // The feature playbook guidance served to agents at runtime drives the
    // unified artifact — each feature authoring/review playbook cites docs/specs/.
    for (const phase of ['plan', 'plan-review']) {
      const playbook = getPlaybook('feature', phase);
      expect(playbook, `feature/${phase} playbook missing`).toBeTruthy();
      expect(
        playbook!.compactGuidance,
        `feature/${phase} guidance must cite docs/specs/`,
      ).toContain('docs/specs/');
    }
  });
});
