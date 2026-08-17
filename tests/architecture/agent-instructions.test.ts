/**
 * The agent instructions have to describe the tree that exists.
 *
 * `CLAUDE.md` and `AGENTS.md` mandated co-located tests — `foo.test.ts` beside
 * `foo.ts` — which is exactly the convention DR-5 retires. Left stale they would
 * misdirect every future agent, including the ones this repository dispatches on
 * itself, and the misdirection is self-reinforcing: an agent that follows the
 * prose puts a test back under `src/`, which is the state DR-5 exists to prevent.
 *
 * Asserting the prose no longer says the old thing is half a test — it passes on
 * prose that says nothing at all. So the tier list in each document is parsed
 * back out and required to equal the tiers on disk, in both directions.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const TESTS_ROOT = join(REPO_ROOT, 'tests');

const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

/** Tier directories that exist on disk — the layout the prose must match. */
function tierDirs(): string[] {
  return readdirSync(TESTS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * The tiers a document names, read out of its backticked identifiers.
 *
 * Scoped to the paragraph that states the testing convention rather than the
 * whole file, so an unrelated mention of `unit` elsewhere cannot stand in for
 * the list actually being asserted.
 */
function tiersNamedIn(text: string, tiers: readonly string[]): string[] {
  const start = text.search(/never beside their subject/i);
  if (start === -1) return [];
  const window = text.slice(start, start + 900);
  return tiers.filter((t) => window.includes(`\`${t}\``)).sort();
}

describe('AgentInstructions', () => {
  it('AgentInstructions_StatedTestConvention_MatchesTheEnforcedLayout', () => {
    const tiers = tierDirs();
    // Denominator. With no tier directories the equality below holds trivially
    // and this test would pass against prose describing nothing.
    expect(tiers.length, 'no tier directories under tests/').toBeGreaterThan(5);

    for (const file of INSTRUCTION_FILES) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');

      // 1. The retired convention is gone. `beside` is deliberately included:
      //    the rule can be restated without the hyphenated term.
      expect(/co-located/i.test(text), `${file} still mandates co-located tests (DR-5)`).toBe(false);
      expect(
        /\.test\.ts`? beside/i.test(text),
        `${file} still states the beside-its-subject layout (DR-5)`,
      ).toBe(false);

      // 2. It states the replacement.
      expect(
        /never beside their subject/i.test(text),
        `${file} does not state the centralized test convention`,
      ).toBe(true);

      // 3. The tier list it states equals the tier list on disk, both ways. A
      //    tier added to the tree without being documented fails here, and so
      //    does a documented tier that no longer exists.
      expect(tiersNamedIn(text, tiers), `${file}'s tier list has drifted from tests/`).toEqual(
        tiers,
      );
    }
  });

  it('AgentInstructions_TestRoot_IsTheOneTheContractEnforces', () => {
    // The directory contract in one line, tied to the same source the tree
    // contract reads. `tests/` is named by both documents and is the only root
    // any of them may name — `test/` singular was dissolved in task 032.
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
