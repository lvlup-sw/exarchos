// Liveness of the depcruise rule `no-domain-core-to-io-adapters`.
//
// The rule has `severity: 'error'`, and `runBoundaryLint` in
// `src/verbs/pure/static-analysis.ts` runs it. Its `from` side is a path regex
// that names directories. A directory rename does not break the rule. The
// rename empties it. A rule that matches zero modules always passes, and in CI
// it looks the same as a rule that the code obeys.
//
// This file does not invoke the depcruise binary, which needs about 4 GB and
// already runs in the real gate. It checks directly that the regex still
// describes the tree.
//
// @oracle-sources: ../../.dependency-cruiser.cjs, live-src-directory-listing
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');
const CONFIG_PATH = path.join(REPO_ROOT, '.dependency-cruiser.cjs');

const require = createRequire(import.meta.url);
const config = require(CONFIG_PATH) as {
  forbidden: ReadonlyArray<{
    name: string;
    severity: string;
    from: { path?: string; pathNot?: string };
    to: { path?: string; circular?: boolean };
  }>;
};

const RULE_NAME = 'no-domain-core-to-io-adapters';
const rule = config.forbidden.find((r) => r.name === RULE_NAME);

/** Each `.ts` module path under `src/`, relative to the repository root, in POSIX form. */
function liveModules(): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  return out;
}

const modules = liveModules();

describe('DepcruiseRule_AfterRetarget_MatchesNonEmptyModuleSet', () => {
  it('the rule still exists and is error severity', () => {
    expect(rule, `${RULE_NAME} is gone from .dependency-cruiser.cjs`).toBeDefined();
    expect(rule?.severity).toBe('error');
  });

  it('the scan itself is not vacuous', () => {
    expect(modules.length).toBeGreaterThan(500);
  });

  it('the `from` side matches a NON-EMPTY set of live modules', () => {
    const re = new RegExp(rule?.from.path ?? '(?!)');
    const matched = modules.filter((m) => re.test(m));
    expect(
      matched.length,
      `${RULE_NAME}'s \`from\` path (${rule?.from.path}) matches no module on disk. A renamed ` +
        'directory does not break this rule — it empties it, and an empty rule passes forever. ' +
        'Retarget the regex in the same change as the move.',
    ).toBeGreaterThan(0);
  });

  it('the `to` side matches a NON-EMPTY set of live modules', () => {
    const re = new RegExp(rule?.to.path ?? '(?!)');
    const matched = modules.filter((m) => re.test(m));
    expect(
      matched.length,
      `${RULE_NAME}'s \`to\` path (${rule?.to.path}) matches no module on disk — the rule can ` +
        'never fire regardless of what the core imports.',
    ).toBeGreaterThan(0);
  });

  /**
   * A rename can hide in the alternation. `(events|workflow)` stays valid when
   * one directory is deleted, and the other directory keeps the rule
   * non-empty. The count tests above cannot find such a half-dead rule.
   */
  it('every directory the `from` alternation names actually exists', () => {
    const alternation = /\(([a-z0-9|_-]+)\)/.exec(rule?.from.path ?? '')?.[1];
    expect(alternation, 'from.path no longer contains a directory alternation').toBeDefined();
    for (const dir of (alternation ?? '').split('|')) {
      const abs = path.join(REPO_ROOT, 'src', dir);
      let exists = false;
      try { exists = statSync(abs).isDirectory(); } catch { exists = false; }
      expect(exists, `\`from\` names src/${dir}/, which does not exist`).toBe(true);
    }
  });

  /**
   * The rule has no `pathNot` exclusion for test files, because no test file
   * lives in the governed set. This test fails when a test file appears there
   * with no exemption.
   */
  it('DepcruiseRule_FromSet_HoldsNoTestFile', () => {
    const fromRe = new RegExp(rule?.from.path ?? '(?!)');
    const governed = modules.filter((m) => fromRe.test(m));
    expect(governed.length, 'the `from` path governs no module at all').toBeGreaterThan(0);
    expect(
      governed.filter((m) => m.endsWith('.test.ts')),
      'a test file is back inside the domain core; either move it under tests/ or restore an exemption',
    ).toEqual([]);
  });
});

/** `violates` applies the predicate of the rule to one `(from, to)` pair. */
describe('DepcruiseRule_SeededViolation_StillFails', () => {
  function violates(from: string, to: string): boolean {
    const fromRe = new RegExp(rule?.from.path ?? '(?!)');
    const notRe = rule?.from.pathNot ? new RegExp(rule.from.pathNot) : undefined;
    const toRe = new RegExp(rule?.to.path ?? '(?!)');
    return fromRe.test(from) && !(notRe?.test(from) ?? false) && toRe.test(to);
  }

  /** Seeds the edge from live modules. A synthetic path can match a regex that no real file matches. */
  it('a seeded core → adapters edge is caught', () => {
    const fromRe = new RegExp(rule?.from.path ?? '(?!)');
    const notRe = new RegExp(rule?.from.pathNot ?? '(?!)');
    const toRe = new RegExp(rule?.to.path ?? '(?!)');
    const coreModule = modules.find((m) => fromRe.test(m) && !notRe.test(m));
    const adapterModule = modules.find((m) => toRe.test(m));
    expect(coreModule, 'no live domain-core module to seed from').toBeDefined();
    expect(adapterModule, 'no live adapters module to seed to').toBeDefined();
    expect(violates(coreModule as string, adapterModule as string)).toBe(true);
  });

  /**
   * A core test is exempt by its address and not by an exclusion. Its path
   * under `tests/` must fall outside the `from` set.
   */
  it('a relocated core test is outside the governed set entirely', () => {
    const relocated = 'tests/unit/workflow/tools.test.ts';
    const adapterModule = modules.find((m) => new RegExp(rule?.to.path ?? '(?!)').test(m));
    expect(adapterModule, 'no live adapters module to seed to').toBeDefined();
    expect(new RegExp(rule?.from.path ?? '(?!)').test(relocated)).toBe(false);
    expect(violates(relocated, adapterModule as string)).toBe(false);
  });

  /** The negative half. A rule that flags each edge is as useless as a rule that flags none. */
  it('an edge that leaves the governed set is NOT caught', () => {
    const ungoverned = modules.find((m) => !new RegExp(rule?.from.path ?? '(?!)').test(m));
    const adapterModule = modules.find((m) => new RegExp(rule?.to.path ?? '(?!)').test(m));
    expect(ungoverned).toBeDefined();
    expect(violates(ungoverned as string, adapterModule as string)).toBe(false);
  });

  /**
   * If the gate does not invoke the config, liveness has no value. The gate
   * returns `SKIP` when it finds no config, so the gate source must name the
   * config file. The first pattern matches only the description of
   * `runBoundaryLint`, because the call passes its arguments as an array.
   */
  it('the rule is the one static analysis actually runs', () => {
    const staticAnalysis = readFileSync(
      path.join(REPO_ROOT, 'src/verbs/pure/static-analysis.ts'),
      'utf8',
    );
    expect(staticAnalysis).toMatch(/depcruise --validate/);
    expect(staticAnalysis).toMatch(/\.dependency-cruiser/);
  });
});
