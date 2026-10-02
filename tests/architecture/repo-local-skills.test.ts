/**
 * @fileoverview Skills vendored for the agents that work on this repository.
 *
 * The canonical copy of each skill is in `.agents/skills/`, which Codex reads. Claude Code reads
 * only `.claude/skills/`, so that directory holds a byte-identical mirror. A symlink is not used,
 * because a checkout without symlink support turns it into a plain file. The upstream `skills`
 * installer scans these directories first, so each skill is marked `metadata.internal: true`.
 * The installer skips an internal skill. When it finds no other skill there, it scans the whole
 * repository, and the Exarchos install fallback depends on that scan to find `rendered/` skills.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const CANONICAL_DIR = '.agents/skills';
const MIRROR_DIR = '.claude/skills';
const SCANNED_DIRS = [CANONICAL_DIR, MIRROR_DIR, '.github/skills', 'skills'];

/** The tracked files under a directory, relative to it. Untracked output from other tools is out of scope. */
async function trackedUnder(dir: string): Promise<string[]> {
  const out = await execFileAsync('git', ['ls-files', '-z', '--', dir], { cwd: REPO_ROOT });
  return out
    .split('\0')
    .filter((file) => file.length > 0)
    .map((file) => path.posix.relative(dir, file))
    .sort();
}

/** The frontmatter of a SKILL.md file. */
function frontmatter(file: string): Record<string, unknown> {
  const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) throw new Error(`${file} has no frontmatter`);
  return parseYaml(match[1]!) as Record<string, unknown>;
}

const skillFiles = (await Promise.all(SCANNED_DIRS.map(async (dir) => ({ dir, files: await trackedUnder(dir) })))).flatMap(
  ({ dir, files }) =>
    files.filter((file) => path.posix.basename(file) === 'SKILL.md').map((file) => path.posix.join(dir, file)),
);

describe('repo-local skills', () => {
  /** An empty scan passes every check below, so the scan must find the vendored skill. */
  it('RepoLocalSkills_Scan_FindsTheVendoredSkill', () => {
    expect(skillFiles).toContain(`${CANONICAL_DIR}/simple-english/SKILL.md`);
    expect(skillFiles).toContain(`${MIRROR_DIR}/simple-english/SKILL.md`);
  });

  /** An installer that finds one skill that is not internal stops its search, and the Exarchos install fallback gets only that skill. */
  it('RepoLocalSkills_EverySkill_IsMarkedInternal', () => {
    for (const file of skillFiles) {
      const metadata = frontmatter(file).metadata as Record<string, unknown> | undefined;
      expect(metadata?.internal, `${file} must set metadata.internal: true`).toBe(true);
    }
  });

  /** Claude Code loads the mirror and Codex loads the canonical copy, so a drift gives the two agents different rules. */
  it('RepoLocalSkills_Mirror_IsByteIdenticalToTheCanonicalCopy', async () => {
    const canonical = await trackedUnder(CANONICAL_DIR);
    const mirror = await trackedUnder(MIRROR_DIR);

    expect(canonical.length).toBeGreaterThan(0);
    expect(mirror).toEqual(canonical);
    for (const file of canonical) {
      const a = fs.readFileSync(path.join(REPO_ROOT, CANONICAL_DIR, file));
      const b = fs.readFileSync(path.join(REPO_ROOT, MIRROR_DIR, file));
      expect(b.equals(a), `${MIRROR_DIR}/${file} differs from ${CANONICAL_DIR}/${file}`).toBe(true);
    }
  });
});
