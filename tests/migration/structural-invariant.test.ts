/**
 * Structural invariants of the rendered skills tree.
 *
 * - Skill sources are under `content/`. No `content/<runtime>/` directory exists, because render
 *   output goes only to `rendered/skills`.
 * - A procedural skill renders one time, to `rendered/skills/standard/<name>/SKILL.md`. There are
 *   16 procedural skills.
 * - An orchestration skill (`ideate`, `delegate`, `refactor`) renders for each of 6 runtimes, to
 *   `rendered/skills/<runtime>/<name>/SKILL.md`. That gives 18 files.
 * - The total is 34 rendered `SKILL.md` files.
 * - No skill directory is directly under `rendered/skills`.
 */

import { describe, it, expect } from 'vitest';
import {
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SKILLS_DIR = join(REPO_ROOT, 'rendered/skills');
const SKILLS_SRC_DIR = join(REPO_ROOT, 'content');

const RUNTIME_NAMES = [
  'generic',
  'claude',
  'codex',
  'opencode',
  'copilot',
  'cursor',
];

/**
 * The skill names. A skill name is also its directory name. The first 16 are procedural skills, and
 * the last 3 are orchestration skills. No directory with one of these names can be directly under
 * `rendered/skills`.
 */
const CANONICAL_SKILLS = [
  'checkpoint',
  'cleanup',
  'debug',
  'discover',
  'dogfood',
  'git-worktrees',
  'invariants',
  'merge-orchestrator',
  'mutation-adequacy',
  'oneshot',
  'plan',
  'prune',
  'rehydrate',
  'review',
  'shepherd',
  'synthesize',
  'delegate',
  'ideate',
  'refactor',
];

/**
 * Returns the absolute path of each `SKILL.md` file under `root`. It skips a path that holds one of
 * `excludeFragments`, compared with forward slashes.
 */
function findAllSkillMdFiles(root: string, excludeFragments: string[] = []): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && entry === 'SKILL.md') {
        const posixFull = full.split(/[\\/]/).join('/');
        if (!excludeFragments.some((frag) => posixFull.includes(frag))) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

describe('task 018 — post-migration structural invariants', () => {
  /**
   * 16 procedural skills render one time, and 3 orchestration skills render for each of 6 runtimes:
   * 16 + 18 = 34. The count leaves out each path under a `test-fixtures` directory.
   */
  it('PostMigration_SkillsTree_ContainsExpectedSkillMdFiles', () => {
    const files = findAllSkillMdFiles(SKILLS_DIR, ['/test-fixtures/']);
    expect(
      files.length,
      `expected 34 SKILL.md files under skills/ (16 standard + 18 per-runtime), found ${files.length}`,
    ).toBe(34);
  });

  /**
   * `content/` must hold no directory with a runtime name, because render output goes only to
   * `rendered/skills`.
   */
  it('PostMigration_SkillsSrcTree_ContainsNoCommittedGeneratedFiles', () => {
    expect(existsSync(SKILLS_SRC_DIR)).toBe(true);
    for (const rt of RUNTIME_NAMES) {
      const runtimeDir = join(SKILLS_SRC_DIR, rt);
      expect(
        existsSync(runtimeDir),
        `content/${rt}/ must not exist (generated tree leaked into sources)`,
      ).toBe(false);
    }
  });

  /**
   * No directory with a skill name can be directly under `rendered/skills`. A skill renders to
   * `standard/<name>` or to `<runtime>/<name>`, so a directory at that level is a leftover of an
   * older layout.
   */
  it('PostMigration_LegacyTopLevelSkillsGone_NotPresent', () => {
    const leftovers: string[] = [];
    for (const skill of CANONICAL_SKILLS) {
      const legacyDir = join(SKILLS_DIR, skill);
      if (existsSync(legacyDir)) {
        leftovers.push(legacyDir);
      }
    }
    expect(
      leftovers,
      `legacy top-level skill directories still present: ${leftovers.join(', ')}`,
    ).toEqual([]);
  });
});
