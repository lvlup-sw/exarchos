/**
 * Task 018 — Post-migration structural invariants.
 *
 * The platform-agnostic skills migration is complete only when the
 * filesystem reflects the new layout:
 *
 *   - `skills-src/<name>/SKILL.md` — single source of truth per skill.
 *   - `skills/<runtime>/<name>/SKILL.md` — one rendered variant per
 *     runtime, 6 runtimes × 13 skills = 78 variants total.
 *   - No top-level `skills/<name>/SKILL.md` legacy sources — those have
 *     been moved into `skills-src/` by tasks 015/016/017.
 *   - No stray `skills-src/<runtime>/` subdirectories — the generated
 *     tree lives only under `skills/`, and `skills-src/` is source-only.
 *
 * This test enforces those invariants so a future refactor cannot
 * accidentally reintroduce the legacy layout. The test-fixtures tree
 * (`skills/test-fixtures/`) contains deliberately-malformed SKILL.md
 * files used by validator tests and is excluded from the count.
 *
 * Implements: DR-1, DR-8 (structural invariant).
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
const SKILLS_DIR = join(REPO_ROOT, 'skills');
const SKILLS_SRC_DIR = join(REPO_ROOT, 'skills-src');

const RUNTIME_NAMES = [
  'generic',
  'claude',
  'codex',
  'opencode',
  'copilot',
  'cursor',
];

// The 13 migrated skills — brainstorming + 11 batch + delegation.
// `rehydrate` and `tdd` from the original plan are commands, not skills.
const MIGRATED_SKILLS = [
  'brainstorming',
  'cleanup',
  'debug',
  'delegation',
  'dogfood',
  'git-worktrees',
  'implementation-planning',
  'quality-review',
  'refactor',
  'shepherd',
  'spec-review',
  'synthesis',
  'workflow-state',
];

/**
 * Walk a directory tree and return every file path (absolute) whose
 * basename is `SKILL.md`, optionally excluding paths that contain any
 * of the given substrings. Used to enforce the 78-file structural
 * count after migration.
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
        if (!excludeFragments.some((frag) => full.includes(frag))) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

describe('task 018 — post-migration structural invariants', () => {
  it('PostMigration_SkillsTree_Contains78SkillMdFiles', () => {
    // 13 skills × 6 runtimes = 78 SKILL.md files under `skills/`.
    // `test-fixtures/` is excluded because those are validator test
    // fixtures, not deployable skills.
    const files = findAllSkillMdFiles(SKILLS_DIR, ['/test-fixtures/']);
    expect(
      files.length,
      `expected 78 SKILL.md files under skills/ (13 skills × 6 runtimes), found ${files.length}`,
    ).toBe(78);
  });

  it('PostMigration_SkillsSrcTree_ContainsNoCommittedGeneratedFiles', () => {
    // `skills-src/` must NOT contain any subdirectory named after a
    // runtime (generic, claude, codex, opencode, copilot, cursor). The
    // generated tree lives only under `skills/`, not `skills-src/`.
    expect(existsSync(SKILLS_SRC_DIR)).toBe(true);
    for (const rt of RUNTIME_NAMES) {
      const runtimeDir = join(SKILLS_SRC_DIR, rt);
      expect(
        existsSync(runtimeDir),
        `skills-src/${rt}/ must not exist (generated tree leaked into sources)`,
      ).toBe(false);
    }
  });

  it('PostMigration_LegacyTopLevelSkillsGone_NotPresent', () => {
    // For every migrated skill, neither `skills/<name>/SKILL.md` nor
    // the entire `skills/<name>/` legacy directory may remain. The
    // skill's home is now `skills-src/<name>/SKILL.md` with runtime
    // variants under `skills/<runtime>/<name>/SKILL.md`. Any leftover
    // top-level directory (even if it only contains stale `.test.sh`
    // fixture files) is a signal that the cutover pass missed one.
    const leftovers: string[] = [];
    for (const skill of MIGRATED_SKILLS) {
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
