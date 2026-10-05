import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { datedRecordTrees } from '../../../src/architecture/vocabulary-lint.js';
import { ARTIFACT_DIRS } from '../../../tools/conformance/src/bindings/index.js';
import { handleVerifyDocLinks } from '../../../src/verbs/gates/verify-doc-links.js';
import { getPlaybook } from '../../../src/workflow/playbooks.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

/**
 * The feature flow writes one unified spec to the specs tree under `docs`.
 * The doc scanners must include that tree.
 * A live feature surface must not tell an agent to write to the designs tree or the plans tree.
 */
describe('doc scanners include docs/specs/ (DR-9, task 019)', () => {
  /**
   * The vocabulary lint must list the specs tree as a dated record tree, so the lint skips a point-in-time spec.
   * The doc-link verifier must scan a document in a specs directory and report its broken link.
   */
  it('DocScanners_IncludeSpecsDir', () => {
    const dated = datedRecordTrees(ARTIFACT_DIRS);
    expect(dated).toContain('docs/specs/');
    expect(dated).toContain('docs/designs/');
    expect(dated).toContain('docs/plans/');

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
      const data = result.data as { brokenLinks?: Array<{ target?: string }> } | undefined;
      const serialized = JSON.stringify(result);
      expect(serialized).toContain('nope.md');
      expect(data).toBeDefined();
    } finally {
      rmrf(tmp);
    }
  });

  /**
   * A feature command is a thin shim that delegates to `@skills/<verb>/SKILL.md`.
   * Thus the live surface is the shim and its skill.
   * The shim must name no designs or plans path, and the skill must cite the specs tree.
   * The stale-path assertion reads only the shim, because a skill can name those trees in legacy-migration prose.
   * The `plan` and `plan-review` playbooks of the feature workflow must also cite the specs tree.
   */
  it('LiveSurfaces_NoStalePlanPathRefs', () => {
    const liveSurfaces: ReadonlyArray<{ command: string; skill: string }> = [
      { command: 'rendered/commands/ideate.md', skill: 'content/design/skills/ideate/SKILL.md' },
      { command: 'rendered/commands/plan.md', skill: 'content/design/skills/plan/SKILL.md' },
    ];
    for (const { command, skill } of liveSurfaces) {
      const cmdBody = readFileSync(join(REPO_ROOT, command), 'utf8');
      const skillBody = readFileSync(join(REPO_ROOT, skill), 'utf8');

      expect(cmdBody, `${command} must delegate to a skill`).toContain('@skills/');
      expect(cmdBody, `${command} must not reference docs/designs/`).not.toContain('docs/designs/');
      expect(cmdBody, `${command} must not reference docs/plans/`).not.toContain('docs/plans/');

      expect(skillBody, `${skill} must reference docs/specs/`).toContain('docs/specs/');
    }

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
