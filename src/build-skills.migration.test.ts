/**
 * Migration no-regression test for the dual-facade skill rendering epic.
 *
 * Purpose: verify that existing Claude Code skill renders remain byte-
 * identical after the dual-facade changes, so users on the Claude Code
 * runtime need take no action to stay functional.
 *
 * Strategy:
 *   1. Snapshot the committed `skills/claude/**\/SKILL.md` tree in-memory.
 *   2. Run `buildAllSkills()` into a fresh temp output directory using the
 *      real `skills-src/` and `runtimes/` trees at the repo root.
 *   3. Compare each freshly-rendered `SKILL.md` under `<tempdir>/skills/claude/`
 *      against the committed version. Any difference is a regression.
 *
 * This is a pure byte-comparison regression check. Today's skill sources
 * still use raw `mcp__...` tool references (no `{{CALL}}` macros), so the
 * CALL-macro expansion branch is effectively a no-op for the Claude
 * variant and the re-render must reproduce the committed bytes exactly.
 *
 * If the sources ever adopt `{{CALL}}` macros, this test will catch any
 * drift introduced by that migration — and the fix is to re-run
 * `npm run build:skills` and commit the regenerated output, not to relax
 * this test.
 *
 * Implements: Task 028 (migration no-regression integration test).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAllSkills } from './build-skills.js';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Repo root — `src/` is one directory below the project root.
const REPO_ROOT = resolve(__dirname, '..');
const REPO_SKILLS_SRC = join(REPO_ROOT, 'skills-src');
const REPO_RUNTIMES = join(REPO_ROOT, 'runtimes');
const REPO_SKILLS_CLAUDE = join(REPO_ROOT, 'skills', 'claude');

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'build-skills-migration-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/**
 * Recursively walk `root` collecting every path that ends in `SKILL.md`.
 * Returns absolute paths sorted for deterministic iteration.
 */
function collectSkillMdPaths(root: string): string[] {
  const results: string[] = [];
  if (!existsSync(root)) return results;

  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && entry === 'SKILL.md') {
        results.push(full);
      }
    }
  }
  return results.sort();
}

/**
 * Diff-context helper: produce a short human-readable hint at the first
 * byte (and line) that differs between `expected` and `actual`. Used in
 * assertion messages so that on failure the developer gets a specific
 * pointer instead of a wall of bytes.
 */
function firstDiffContext(
  expected: string,
  actual: string,
): { line: number; expected: string; actual: string } | null {
  if (expected === actual) return null;

  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const maxLen = Math.max(expectedLines.length, actualLines.length);

  for (let i = 0; i < maxLen; i++) {
    const e = expectedLines[i] ?? '<EOF>';
    const a = actualLines[i] ?? '<EOF>';
    if (e !== a) {
      return { line: i + 1, expected: e, actual: a };
    }
  }
  // Lines all equal but strings differ (shouldn't happen); fall through.
  return { line: 0, expected: '<unknown>', actual: '<unknown>' };
}

describe('ExistingClaudeCodeInstall_AfterMigration_RendersIdenticalOutput', () => {
  it('re-rendering skills-src produces byte-identical skills/claude output', () => {
    // Sanity: committed skills/claude tree must exist — otherwise the
    // snapshot has nothing to compare against and the test is vacuous.
    expect(existsSync(REPO_SKILLS_CLAUDE)).toBe(true);

    const committedPaths = collectSkillMdPaths(REPO_SKILLS_CLAUDE);
    expect(committedPaths.length).toBeGreaterThan(0);

    // Snapshot the committed content in-memory keyed by relative path.
    const committedByRel = new Map<string, string>();
    for (const p of committedPaths) {
      const rel = relative(REPO_SKILLS_CLAUDE, p);
      committedByRel.set(rel, readFileSync(p, 'utf8'));
    }

    // Re-render into a fresh temp directory. buildAllSkills writes to
    // `<outDir>/<runtime>/**`, so our claude variant lands at
    // `<tempDir>/claude/**`.
    const tempOut = makeTempDir();
    buildAllSkills({
      srcDir: REPO_SKILLS_SRC,
      outDir: tempOut,
      runtimesDir: REPO_RUNTIMES,
    });

    const freshClaude = join(tempOut, 'claude');
    expect(existsSync(freshClaude)).toBe(true);

    const freshPaths = collectSkillMdPaths(freshClaude);
    const freshByRel = new Map<string, string>();
    for (const p of freshPaths) {
      const rel = relative(freshClaude, p);
      freshByRel.set(rel, readFileSync(p, 'utf8'));
    }

    // 1. Set of skills must match — no added or dropped skill files.
    const committedRels = [...committedByRel.keys()].sort();
    const freshRels = [...freshByRel.keys()].sort();
    expect(freshRels).toEqual(committedRels);

    // 2. Content must be byte-identical for every skill. If drift exists,
    //    include the file name and first differing line in the failure
    //    message so the developer knows exactly where to look.
    const mismatches: Array<{ rel: string; line: number; expected: string; actual: string }> = [];
    for (const rel of committedRels) {
      const expected = committedByRel.get(rel)!;
      const actual = freshByRel.get(rel)!;
      const diff = firstDiffContext(expected, actual);
      if (diff !== null) {
        mismatches.push({ rel, ...diff });
      }
    }

    if (mismatches.length > 0) {
      const lines = mismatches.map(
        (m) =>
          `  ${m.rel} @ line ${m.line}:\n` +
          `    expected: ${JSON.stringify(m.expected)}\n` +
          `    actual:   ${JSON.stringify(m.actual)}`,
      );
      throw new Error(
        `Migration regression: ${mismatches.length} claude skill(s) drifted after re-render.\n` +
          `Run 'npm run build:skills' locally and commit the regenerated tree.\n` +
          lines.join('\n'),
      );
    }
  });
});
