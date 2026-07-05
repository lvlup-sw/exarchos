/**
 * Task 018 — Post-migration structural invariants.
 *
 * The platform-agnostic skills migration is complete only when the
 * filesystem reflects the post-collapse layout:
 *
 *   - `skills-src/<name>/SKILL.md` — single source of truth per skill.
 *   - Procedural skills render ONCE to `skills/standard/<name>/SKILL.md`
 *     (runtime-neutral; the collapse dropped their redundant per-runtime
 *     copies). There are 16 procedural skills, including the
 *     `workflow-state` → `rehydrate` + `checkpoint` split.
 *   - Orchestration skills (`ideate`, `delegate`, `refactor`) still render
 *     per-runtime to `skills/<runtime>/<name>/SKILL.md`, one variant per
 *     runtime × 6 runtimes = 18 variants.
 *   - Total: 16 standard + 18 per-runtime = 34 rendered `SKILL.md` files.
 *   - No top-level `skills/<name>/SKILL.md` legacy sources — those have
 *     been moved into `skills-src/` and rendered under `skills/standard/`
 *     or `skills/<runtime>/`.
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

// The canonical post-collapse skill verbs (skill name == verb == directory).
// 16 procedural (rendered once to `skills/standard/<verb>/`) + 3
// orchestration (`ideate`, `delegate`, `refactor`, rendered per-runtime).
// A legacy top-level `skills/<verb>/` directory for ANY of these is a
// regression signal. The old names (`brainstorming`, `delegation`,
// `implementation-planning`, `synthesis`, `workflow-state`) collapsed into
// these verbs — `workflow-state` split into `rehydrate` + `checkpoint`.
const CANONICAL_SKILLS = [
  // procedural (skills/standard/)
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
  // orchestration (skills/<runtime>/)
  'delegate',
  'ideate',
  'refactor',
];

/**
 * Walk a directory tree and return every file path (absolute) whose
 * basename is `SKILL.md`, optionally excluding paths that contain any
 * of the given substrings. Used to enforce the 34-file structural
 * count after the collapse (16 standard + 18 per-runtime).
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
  it('PostMigration_SkillsTree_ContainsExpectedSkillMdFiles', () => {
    // Post-collapse count: 34 rendered SKILL.md files under `skills/`.
    //   - 16 procedural skills render ONCE to `skills/standard/<verb>/`
    //     (the collapse dropped their redundant per-runtime copies; the
    //     `workflow-state` skill split into `rehydrate` + `checkpoint`).
    //   - 3 orchestration skills (`ideate`, `delegate`, `refactor`) render
    //     per-runtime across 6 runtimes = 18 variants.
    // 16 + 18 = 34. The `skills/test-fixtures/` tree is validator
    // scaffolding, not a render, and is excluded.
    const files = findAllSkillMdFiles(SKILLS_DIR, ['/test-fixtures/']);
    expect(
      files.length,
      `expected 34 SKILL.md files under skills/ (16 standard + 18 per-runtime), found ${files.length}`,
    ).toBe(34);
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
    // For every canonical skill verb, no top-level `skills/<verb>/`
    // legacy directory may remain. The skill's home is now
    // `skills-src/<verb>/SKILL.md`, rendered to `skills/standard/<verb>/`
    // (procedural) or `skills/<runtime>/<verb>/` (orchestration). Any
    // leftover top-level directory (even if it only contains stale
    // `.test.sh` fixture files) is a signal that the cutover pass missed
    // one.
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
