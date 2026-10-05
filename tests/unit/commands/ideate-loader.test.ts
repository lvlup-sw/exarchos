import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInvariants } from '../../../src/architecture/invariants-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const IDEATE_COMMAND = path.join(REPO_ROOT, 'rendered/commands/ideate.md');
const IDEATE_SKILL = path.join(
  REPO_ROOT,
  'content/design/skills/ideate/SKILL.md',
);
const INVARIANTS_DOC = path.join(REPO_ROOT, '.exarchos/invariants.md');

describe('ideate first-turn invariant surfacing (#1260)', () => {
  /**
   * The `ideate` command is a shim that points to the ideate skill. The skill holds the
   * reference to `.exarchos/invariants.md`.
   */
  it('Ideate_FirstTurn_LoadsInvariantsDoc', () => {
    const ideate = fs.readFileSync(IDEATE_COMMAND, 'utf8');
    const skill = fs.readFileSync(IDEATE_SKILL, 'utf8');

    expect(ideate).toContain('@skills/ideate/SKILL.md');

    expect(skill).toContain('.exarchos/invariants.md');
    expect(skill.toLowerCase()).toContain('constraint anchoring');
  });

  /**
   * The catalog and the ideate skill must both name the two CLI-design invariant ids, and
   * the catalog must hold no `DIM-` id. The test registers the catalog in an explicit
   * config, so the result does not depend on the root `.exarchos.yml`.
   */
  it('Ideate_FirstTurn_SurfacesRelevantInvariants', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, {
      invariants: { catalogs: [{ path: INVARIANTS_DOC, tier: 'dev' as const }] },
    });
    const ids = new Set(entries.map((e) => e.id));
    expect(ids.has('INV-5a')).toBe(true);
    expect(ids.has('INV-5c')).toBe(true);
    expect([...ids].some((id) => id.startsWith('DIM-'))).toBe(false);

    const skill = fs.readFileSync(IDEATE_SKILL, 'utf8');
    expect(skill).toMatch(/INV-5a/);
    expect(skill).toMatch(/INV-5c/);
  });
});
