// Retirement guard for the `design-invariants` skill (T-23 / DR-4).
//
// The skill's audit behavior is now owned by the `check_invariant_conformance`
// gate; its vocabulary lives in `.exarchos/invariants.md` and its
// grounding prose was relocated to `docs/architecture/invariants/references/`.
// This guard pins the retirement so the skill cannot quietly return and so the
// catalog's `references:` pointers never dangle.

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { loadInvariants } from '../../../src/architecture/invariants-loader.js';

// skill-retirement.test.ts lives at
//   src/architecture/skill-retirement.test.ts
// Repo root is four directories up.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const INVARIANTS_DOC = path.join(REPO_ROOT, '.exarchos/invariants.md');
const DESIGN_INVARIANTS_SKILL = path.join(
  REPO_ROOT,
  '.claude/skills/design-invariants/SKILL.md',
);

// Decouple the loader from the repo's actual `.exarchos.yml`; the catalog
// gates behind `invariants.devCatalog: enabled`.
const ENABLED_CONFIG = {
  invariants: { catalogs: [{ path: INVARIANTS_DOC, tier: 'dev' as const }] },
};

describe('design-invariants skill retirement', () => {
  it('DesignInvariantsSkill_Removed_NoVocabularyInSkillBodies', () => {
    // The retired skill's entry point must no longer exist on disk.
    expect(
      fs.existsSync(DESIGN_INVARIANTS_SKILL),
      'design-invariants SKILL.md must be removed — audit behavior now lives in the check_invariant_conformance gate',
    ).toBe(false);

    // The skill directory must be gone entirely (no stray references/ dir).
    const skillDir = path.dirname(DESIGN_INVARIANTS_SKILL);
    expect(
      fs.existsSync(skillDir),
      'the .claude/skills/design-invariants/ directory must be removed in full',
    ).toBe(false);

    const entries = loadInvariants(INVARIANTS_DOC, { scope: 'all' }, ENABLED_CONFIG);
    expect(entries.length).toBeGreaterThan(0);

    // No catalog reference may still point into the retired skill — neither
    // the deleted SKILL.md nor the relocated references/ subtree.
    for (const entry of entries) {
      for (const ref of entry.references) {
        expect(
          ref.includes('.claude/skills/design-invariants'),
          `${entry.id} references retired skill path: ${ref}`,
        ).toBe(false);
      }
    }

    // The grounding prose that this skill's retirement relocated has since left
    // the repository entirely, for the documents repository. A reference to it
    // is now a CROSS-REPOSITORY citation (`<owner>/<repo>:<path>`) and cannot
    // resolve locally — which is the point: the citation survives the document
    // leaving and says where it went.
    //
    // What still has to hold is that the reference names the reference tree at
    // all. A reference that silently lost its path, or that points at a local
    // file which is not there, is still a dangling one.
    const CROSS_REPO = /^[\w.-]+\/[\w.-]+:/;
    const dangling: string[] = [];
    for (const entry of entries) {
      for (const ref of entry.references) {
        if (!ref.includes('docs/architecture/invariants/references/')) continue;
        const withoutAnchor = ref.split('#')[0]!;
        if (CROSS_REPO.test(withoutAnchor)) {
          // Relocated: assert it still names a document rather than trailing off.
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
