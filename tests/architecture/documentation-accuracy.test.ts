// ─── The documentation describes the system that exists ──────────────────────
//
// Instruction files are read by every agent that touches this repository, and a
// stale one is worse than a missing one: it is confidently wrong, and it is
// wrong in the direction of the layout that used to be there. Three root files
// described a retired tree for the whole of a structural refactor, telling every
// future reader to look in directories that had been dissolved.
//
// So the claims are checked mechanically. Not the prose — the PATHS it names and
// the COMMANDS it tells a reader to run, both of which are verifiable.
//
// @oracle-sources: live-repository-tree, ../../package.json

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The instruction files a contributor or agent is expected to read. */
const DOC_FILES = [
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'ONBOARDING.md',
  // `docs/ARCHITECTURE.md` is gone. It restated the directory contract and the
  // layer map that `layer-map.json` and its test already assert from the live
  // tree, so it was a second copy of a machine-checked fact — the kind that
  // goes stale silently because nothing compares it to anything.
  'src/README.md',
  'content/README.md',
  'rendered/README.md',
  'tests/README.md',
  'tools/README.md',
  'docs/README.md',
] as const;

/**
 * Directory prefixes this repository no longer has. A doc naming one is
 * pointing a reader at a tree that was dissolved, which is the specific failure
 * this file exists to prevent recurring.
 *
 * Each is checked to be genuinely absent first, so the list cannot rot into
 * forbidding something that came back.
 */
const REMOVED_ROOTS = [
  'servers/exarchos-mcp',
  'skills-src/',
  'eslint-rules/',
] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('Documentation_NoFileRetainsARemovedPath', () => {
  it('every documented file exists to be checked', () => {
    // Denominator: a missing doc would otherwise pass every scan below by
    // contributing no text to scan.
    for (const rel of DOC_FILES) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} is missing`).toBe(true);
    }
  });

  it('the removed roots really are removed', () => {
    // Without this the check below could forbid a path that exists, which would
    // make the guard wrong in the opposite direction.
    for (const root of REMOVED_ROOTS) {
      expect(
        fs.existsSync(path.join(REPO_ROOT, root)),
        `${root} exists — remove it from REMOVED_ROOTS rather than forbidding a live path`,
      ).toBe(false);
    }
  });

  it('no instruction file points at a dissolved directory', () => {
    const offenders: string[] = [];
    for (const rel of DOC_FILES) {
      const text = read(rel);
      for (const root of REMOVED_ROOTS) {
        // A doc may narrate history ("was folded into"), so only a path used as
        // a live location counts — one inside backticks or a link target.
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

    // Denominator: docs that name no command would pass by silence.
    expect(named, 'no `npm run` commands found in the documentation').toBeGreaterThan(5);

    expect(
      missing,
      'Documented commands that do not exist. A reader following the instructions gets an ' +
        '"npm ERR! Missing script" and no idea which half is wrong.',
    ).toEqual([]);
  });
});

describe('Documentation_EveryStatedRule_IsOneThatIsEnforced', () => {
  // The anti-drift condition. Documentation may state a rule only where
  // something actually enforces it — otherwise the docs accumulate aspirations
  // that read exactly like guarantees.
  const ENFORCED: ReadonlyArray<{ claim: RegExp; enforcer: string; where: string }> = [
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
      enforcer: '.exarchos/comment-policy.json',
      where: 'CLAUDE.md',
    },
  ];

  it('every rule the instructions state has a live enforcer', () => {
    const unenforced: string[] = [];
    for (const { claim, enforcer, where } of ENFORCED) {
      const text = read(where);
      if (!claim.test(text)) continue; // the doc does not make the claim — nothing to enforce
      if (!fs.existsSync(path.join(REPO_ROOT, enforcer))) {
        unenforced.push(`${where} states a rule enforced by ${enforcer}, which does not exist`);
      }
    }
    expect(unenforced, unenforced.join('\n')).toEqual([]);
  });

  it('the enforcement table is not empty', () => {
    // A table that matched nothing would satisfy the check above trivially.
    const text = read('CLAUDE.md');
    const matched = ENFORCED.filter(({ claim }) => claim.test(text));
    expect(matched.length, 'CLAUDE.md states none of the tabled rules').toBeGreaterThan(2);
  });
});
