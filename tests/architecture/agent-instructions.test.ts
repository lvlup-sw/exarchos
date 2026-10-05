/**
 * The agent instructions must describe the tree that exists.
 *
 * `CLAUDE.md` and `AGENTS.md` must not tell an agent to put a test beside its
 * subject. An agent that obeys such prose puts a test back under `src/`.
 *
 * A check that the prose omits the co-located rule also passes on empty prose.
 * Thus the suite also reads the tier list out of each document and requires it
 * to name each tier directory on disk.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const TESTS_ROOT = join(REPO_ROOT, 'tests');

const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

/** The tier directories on disk. The prose must match this layout. */
function tierDirs(): string[] {
  return readdirSync(TESTS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * The on-disk tiers that a document names in backticks. The scan reads only
 * the 900 characters that start at the test convention. A mention of `unit`
 * in another part of the file does not count.
 */
function tiersNamedIn(text: string, tiers: readonly string[]): string[] {
  const start = text.search(/never beside their subject/i);
  if (start === -1) return [];
  const window = text.slice(start, start + 900);
  return tiers.filter((t) => window.includes(`\`${t}\``)).sort();
}

describe('AgentInstructions', () => {
  /**
   * Asserts the tier count first, because with no tier directories the list
   * comparison passes on empty prose. The `beside` pattern finds the
   * co-located rule when the prose states it without the hyphenated term. The
   * list comparison fails when a document omits a tier that exists on disk.
   */
  it('AgentInstructions_StatedTestConvention_MatchesTheEnforcedLayout', () => {
    const tiers = tierDirs();
    expect(tiers.length, 'no tier directories under tests/').toBeGreaterThan(5);

    for (const file of INSTRUCTION_FILES) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');

      expect(/co-located/i.test(text), `${file} still mandates co-located tests (DR-5)`).toBe(false);
      expect(
        /\.test\.ts`? beside/i.test(text),
        `${file} still states the beside-its-subject layout (DR-5)`,
      ).toBe(false);

      expect(
        /never beside their subject/i.test(text),
        `${file} does not state the centralized test convention`,
      ).toBe(true);

      expect(tiersNamedIn(text, tiers), `${file}'s tier list has drifted from tests/`).toEqual(
        tiers,
      );
    }
  });

  /** Each document names the `tests/` root and must not name a `test/` root. */
  it('AgentInstructions_TestRoot_IsTheOneTheContractEnforces', () => {
    for (const file of INSTRUCTION_FILES) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(text.includes('`tests/`'), `${file} does not name the tests/ root`).toBe(true);
      expect(
        /`test\/`/.test(text),
        `${file} names the dissolved test/ root (task 032)`,
      ).toBe(false);
    }
  });
});
