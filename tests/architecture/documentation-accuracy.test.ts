// The documentation describes the system that exists.
//
// Each agent that works in this repository reads the instruction files. A
// stale file is worse than a missing file, because it sends the reader to a
// layout that does not exist.
//
// Thus this suite checks the claims mechanically. It does not check the prose.
// It checks the paths that a file names and the commands that a file tells a
// reader to run.
//
// @oracle-sources: live-repository-tree, ../../package.json

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The instruction files that a contributor or an agent reads. */
const DOC_FILES = [
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'ONBOARDING.md',
  'src/README.md',
  'content/README.md',
  'rendered/README.md',
  'tests/README.md',
  'tools/README.md',
  'docs/README.md',
] as const;

/**
 * Directory prefixes that this repository does not have. A document that names
 * one sends the reader to a tree that does not exist. A test first checks that
 * each prefix is absent, so the list cannot forbid a path that exists.
 */
const REMOVED_ROOTS = [
  'servers/exarchos-mcp',
  'skills-src/',
  'eslint-rules/',
] as const;

/** One linted file per lint root. A rule enforces a claim only if it is on for each of them. */
const RULE_SAMPLES = ['src/registry.ts', 'tools/audit/gates/lint-comments.mjs', 'tests/architecture/documentation-accuracy.test.ts'];

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('Documentation_NoFileRetainsARemovedPath', () => {
  /** Denominator check: each listed instruction file exists. */
  it('every documented file exists to be checked', () => {
    for (const rel of DOC_FILES) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} is missing`).toBe(true);
    }
  });

  /** Without this check, the test below can forbid a path that exists. */
  it('the removed roots really are removed', () => {
    for (const root of REMOVED_ROOTS) {
      expect(
        fs.existsSync(path.join(REPO_ROOT, root)),
        `${root} exists — remove it from REMOVED_ROOTS rather than forbidding a live path`,
      ).toBe(false);
    }
  });

  /**
   * A document can narrate history, so only a path in a live position counts.
   * Such a path follows a backtick or an opening parenthesis.
   */
  it('no instruction file points at a dissolved directory', () => {
    const offenders: string[] = [];
    for (const rel of DOC_FILES) {
      const text = read(rel);
      for (const root of REMOVED_ROOTS) {
        const live = new RegExp(`[\`(]${root.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`, 'g');
        if (live.test(text)) offenders.push(`${rel} → ${root}`);
      }
    }
    expect(
      offenders,
      'Instruction files naming a directory this repository no longer has. Every agent that ' +
        'reads one is sent to a tree that was dissolved.',
    ).toEqual([]);
  });
});

describe('Documentation_EveryStatedCommand_Executes', () => {
  /** The `named` count is the denominator. Documents that name no command pass the list assertion. */
  it('every `npm run <script>` a doc names is a real script', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    const scripts = new Set(Object.keys(pkg.scripts ?? {}));
    expect(scripts.size, 'package.json declares no scripts').toBeGreaterThan(10);

    const missing: string[] = [];
    let named = 0;
    for (const rel of DOC_FILES) {
      for (const m of read(rel).matchAll(/`npm run ([a-z0-9:_-]+)`?/gi)) {
        const script = m[1];
        if (script === undefined) continue;
        named += 1;
        if (!scripts.has(script)) missing.push(`${rel} → npm run ${script}`);
      }
    }

    expect(named, 'no `npm run` commands found in the documentation').toBeGreaterThan(5);

    expect(
      missing,
      'Documented commands that do not exist. A reader following the instructions gets an ' +
        '"npm ERR! Missing script" and no idea which half is wrong.',
    ).toEqual([]);
  });
});

/**
 * The documentation can state a rule only where an enforcer exists. Without
 * this condition, the documents collect aspirations that read like guarantees.
 * `ENFORCED` maps each claim to its test file or its ESLint rule.
 */
describe('Documentation_EveryStatedRule_IsOneThatIsEnforced', () => {
  const ENFORCED: ReadonlyArray<{ claim: RegExp; enforcer: string | { eslintRule: string }; where: string }> = [
    {
      claim: /never beside their subject|all tests live in `?tests\/`?/i,
      enforcer: 'tests/architecture/test-tree-contract.test.ts',
      where: 'CLAUDE.md',
    },
    {
      claim: /25 non-test files|locality/i,
      enforcer: 'tests/architecture/locality.test.ts',
      where: 'CLAUDE.md',
    },
    {
      claim: /render:guard/,
      enforcer: 'tests/architecture/render-guard.test.ts',
      where: 'CLAUDE.md',
    },
    {
      claim: /planning ordinal/i,
      enforcer: { eslintRule: 'comments/comment-content' },
      where: 'CLAUDE.md',
    },
    {
      claim: /Comments are a file header or a `\/\*\* \*\/` description/,
      enforcer: { eslintRule: 'comments/comment-placement' },
      where: 'CLAUDE.md',
    },
    {
      claim: /Simplified Technical English/,
      enforcer: { eslintRule: 'comments/comment-prose' },
      where: 'CLAUDE.md',
    },
    {
      claim: /mirrored in `\.claude\/skills\/`/,
      enforcer: 'tests/architecture/repo-local-skills.test.ts',
      where: 'CLAUDE.md',
    },
  ];

  /**
   * Skips a claim that the document does not make. A test-file enforcer must
   * exist. An ESLint rule must be on at error severity for each sample file.
   */
  it('every rule the instructions state has a live enforcer', async () => {
    const unenforced: string[] = [];
    const eslint = new ESLint({ cwd: REPO_ROOT });
    for (const { claim, enforcer, where } of ENFORCED) {
      const text = read(where);
      if (!claim.test(text)) continue;
      if (typeof enforcer === 'string') {
        if (!fs.existsSync(path.join(REPO_ROOT, enforcer))) {
          unenforced.push(`${where} states a rule enforced by ${enforcer}, which does not exist`);
        }
        continue;
      }
      for (const sample of RULE_SAMPLES) {
        expect(fs.existsSync(path.join(REPO_ROOT, sample)), `rule sample ${sample} is missing`).toBe(true);
        const config = (await eslint.calculateConfigForFile(path.join(REPO_ROOT, sample))) as { rules?: Record<string, unknown> };
        const setting = config.rules?.[enforcer.eslintRule];
        const severity = Array.isArray(setting) ? setting[0] : setting;
        if (severity !== 2 && severity !== 'error') {
          unenforced.push(`${where} states a rule enforced by ${enforcer.eslintRule}, which is not on at error for ${sample}`);
        }
      }
    }
    expect(unenforced, unenforced.join('\n')).toEqual([]);
  });

  /** A table that matches no claim passes the test above. */
  it('the enforcement table is not empty', () => {
    const text = read('CLAUDE.md');
    const matched = ENFORCED.filter(({ claim }) => claim.test(text));
    expect(matched.length, 'CLAUDE.md states none of the tabled rules').toBeGreaterThan(2);
  });
});
