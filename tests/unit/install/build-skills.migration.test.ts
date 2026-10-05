/**
 * Regression test for the claude skill renders. It renders the real `content/` tree into a
 * temp directory with `buildAllSkills()`. Then it compares each new claude `SKILL.md` with the
 * committed copy under `rendered/skills/claude`. A different file set or a different byte is
 * a failure. To correct a failure, run `npm run build:skills` and commit the output.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAllSkills } from '../../../src/install/build-skills.js';
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '../../..');
const REPO_SKILLS_SRC = join(REPO_ROOT, 'content');
const REPO_RUNTIMES = join(REPO_ROOT, 'content/harness/runtimes');
const REPO_SKILLS_CLAUDE = join(REPO_ROOT, 'rendered', 'skills', 'claude');

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'build-skills-migration-'));
  tempDirs.push(dir);
  return dir;
}

/** Remove each temp directory. A removal error does not fail the test. */
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      rmrf(d);
    } catch {
    }
  }
});

/** Return the sorted absolute path of each `SKILL.md` file under `root`. */
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
 * Return the first line that differs between `expected` and `actual`, for the failure message.
 * Return `null` when the strings are equal. The last return is unreachable, because two
 * strings with equal lines are equal.
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
  return { line: 0, expected: '<unknown>', actual: '<unknown>' };
}

describe('ExistingClaudeCodeInstall_AfterMigration_RendersIdenticalOutput', () => {
  /**
   * The committed tree must exist and hold a `SKILL.md`, or the comparison is vacuous.
   * `buildAllSkills` writes to `<outDir>/<runtime>`, so the new claude tree is `<tempOut>/claude`.
   * The two file sets must be equal, and each file must be byte-identical.
   */
  it('re-rendering content produces byte-identical skills/claude output', () => {
    expect(existsSync(REPO_SKILLS_CLAUDE)).toBe(true);

    const committedPaths = collectSkillMdPaths(REPO_SKILLS_CLAUDE);
    expect(committedPaths.length).toBeGreaterThan(0);

    const committedByRel = new Map<string, string>();
    for (const p of committedPaths) {
      const rel = relative(REPO_SKILLS_CLAUDE, p);
      committedByRel.set(rel, readFileSync(p, 'utf8'));
    }

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

    const committedRels = [...committedByRel.keys()].sort();
    const freshRels = [...freshByRel.keys()].sort();
    expect(freshRels).toEqual(committedRels);

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
