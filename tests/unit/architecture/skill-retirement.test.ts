// Retirement guard for the `design-invariants` skill.
//
// The `check_invariant_conformance` gate owns the audit behavior of the skill.
// The vocabulary is in `.exarchos/invariants.md`, and the grounding prose is in the documents repository.
// This guard fails if the skill returns or if a `references:` pointer of the catalog dangles.

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { loadInvariants } from '../../../src/architecture/invariants-loader.js';

/** The directory of this file. The repository root is three levels up. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const INVARIANTS_DOC = path.join(REPO_ROOT, '.exarchos/invariants.md');
const DESIGN_INVARIANTS_SKILL = path.join(
  REPO_ROOT,
  '.claude/skills/design-invariants/SKILL.md',
);

/** Registers the catalog as a dev source, so the loader does not depend on the `.exarchos.yml` of the repo. */
const ENABLED_CONFIG = {
  invariants: { catalogs: [{ path: INVARIANTS_DOC, tier: 'dev' as const }] },
};

describe('design-invariants skill retirement', () => {
  /**
   * The skill entry point and its directory must not exist.
   * No catalog reference points into the retired skill path.
   * The grounding prose is in the documents repository, so a reference to it is a cross-repository citation.
   * Such a citation has the form `<owner>/<repo>:<path>` and does not resolve locally.
   * It must still name a `.md` document. A local reference to the reference tree must resolve to a file.
   */
  it('DesignInvariantsSkill_Removed_NoVocabularyInSkillBodies', () => {
    expect(
      fs.existsSync(DESIGN_INVARIANTS_SKILL),
      'design-invariants SKILL.md must be removed — audit behavior now lives in the check_invariant_conformance gate',
    ).toBe(false);

    const skillDir = path.dirname(DESIGN_INVARIANTS_SKILL);
    expect(
      fs.existsSync(skillDir),
      'the .claude/skills/design-invariants/ directory must be removed in full',
    ).toBe(false);

    const entries = loadInvariants(INVARIANTS_DOC, { scope: 'all' }, ENABLED_CONFIG);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      for (const ref of entry.references) {
        expect(
          ref.includes('.claude/skills/design-invariants'),
          `${entry.id} references retired skill path: ${ref}`,
        ).toBe(false);
      }
    }

    const CROSS_REPO = /^[\w.-]+\/[\w.-]+:/;
    const dangling: string[] = [];
    for (const entry of entries) {
      for (const ref of entry.references) {
        if (!ref.includes('docs/architecture/invariants/references/')) continue;
        const withoutAnchor = ref.split('#')[0]!;
        if (CROSS_REPO.test(withoutAnchor)) {
          if (!/\.md$/.test(withoutAnchor)) dangling.push(`${entry.id} → ${ref}`);
          continue;
        }
        const resolved = path.join(REPO_ROOT, withoutAnchor);
        if (!fs.existsSync(resolved)) {
          dangling.push(`${entry.id} → ${ref}`);
        }
      }
    }
    expect(
      dangling,
      `dangling relocated references: ${dangling.join('; ')}`,
    ).toEqual([]);
  });
});
