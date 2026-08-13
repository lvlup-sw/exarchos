import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { datedRecordTrees } from './vocabulary-lint.js';
import { ARTIFACT_DIRS } from '../../../../tools/conformance/src/bindings/index.js';
import { handleVerifyDocLinks } from '../verbs/gates/verify-doc-links.js';
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
    const dated = datedRecordTrees(ARTIFACT_DIRS);
    expect(dated).toContain('docs/specs/');
    expect(dated).toContain('docs/designs/');
    expect(dated).toContain('docs/plans/');

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
    // The feature-flow surfaces are fully on the unified artifact: they reference
    // docs/specs/ and NEVER instruct the docs/designs/ + docs/plans/ paths the
    // collapsed flow will not produce (legacy/refactor surfaces are out of scope
    // — they keep the two-artifact path until separately migrated).
    //
    // DR-3 (harness conform-and-shrink, Task 007): the feature-flow commands
    // collapsed into thin shims that delegate to `@skills/<verb>/SKILL.md`. The
    // unified-artifact authoring guidance migrated into the skills, so the live
    // surface is the shim + its skill: the shim must route to the skill and must
    // never instruct a stale legacy path, and the skill — the folded home of the
    // guidance — is where the docs/specs/ reference lives. The stale-path
    // negative assertion is scoped to the shim body: the skills legitimately
    // NAME docs/designs/ + docs/plans/ in "don't do this" / legacy-migration
    // prose, which a blunt `not.toContain` would false-flag.
    const liveSurfaces: ReadonlyArray<{ command: string; skill: string }> = [
      { command: 'commands/ideate.md', skill: 'skills-src/ideate/SKILL.md' },
      { command: 'commands/plan.md', skill: 'skills-src/plan/SKILL.md' },
    ];
    for (const { command, skill } of liveSurfaces) {
      const cmdBody = readFileSync(join(REPO_ROOT, command), 'utf8');
      const skillBody = readFileSync(join(REPO_ROOT, skill), 'utf8');

      // The thin-shim command routes to its skill and instructs no stale path.
      expect(cmdBody, `${command} must delegate to a skill`).toContain('@skills/');
      expect(cmdBody, `${command} must not reference docs/designs/`).not.toContain('docs/designs/');
      expect(cmdBody, `${command} must not reference docs/plans/`).not.toContain('docs/plans/');

      // The skill — where the authoring guidance now lives — is on docs/specs/.
      expect(skillBody, `${skill} must reference docs/specs/`).toContain('docs/specs/');
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
