import { describe, it, expect } from 'vitest';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Depcruise rule liveness (DR-3, DR-11, task 012a) ────────────────────────
//
// `no-domain-core-to-io-adapters` is `severity: 'error'` and is executed for
// real by `runBoundaryLint` (orchestrate/static-analysis.ts). Its `from` side is
// a path REGEX naming directories — which means a directory rename does not
// break it, it silently empties it. A rule matching zero modules passes forever
// and looks identical in CI to a rule that is being honoured.
//
// Phase 1 renames both sides of this rule at least three times (tasks 012, 013,
// 018, 019). This file is what makes each of those renames fail loudly instead
// of quietly disarming the guard, so it is re-run after every one of them.
//
// Deliberately NOT invoking the depcruise binary: it needs ~4GB and is already
// executed by the real gate. What can go wrong HERE is the regex ceasing to
// describe the tree, and that is checkable directly and cheaply.
//
// @oracle-sources: ../../.dependency-cruiser.cjs, live-src-directory-listing

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

/** Every tracked .ts module path under the MCP server, repo-relative, POSIX. */
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

  it('every directory the `from` alternation names actually exists', () => {
    // The alternation is where a rename hides: `(events|workflow)` stays
    // syntactically valid when one half is deleted, and the surviving half keeps
    // the rule non-empty — so the count check above cannot catch a HALF-dead
    // rule. This one can.
    const alternation = /\(([a-z0-9|_-]+)\)/.exec(rule?.from.path ?? '')?.[1];
    expect(alternation, 'from.path no longer contains a directory alternation').toBeDefined();
    for (const dir of (alternation ?? '').split('|')) {
      const abs = path.join(REPO_ROOT, 'src', dir);
      let exists = false;
      try { exists = statSync(abs).isDirectory(); } catch { exists = false; }
      expect(exists, `\`from\` names src/${dir}/, which does not exist`).toBe(true);
    }
  });

  it('DepcruiseRule_FromSet_HoldsNoTestFile', () => {
    // The rule used to carry `pathNot: '\.test\.ts$'` to exempt co-located
    // suites. Task 030 moved them all out, which made that exclusion match
    // nothing — dead config, and silent about it. The exclusion is gone; this
    // is the assertion that earns its removal, and it fails the moment a test
    // file reappears inside the governed set with no exemption to cover it.
    const fromRe = new RegExp(rule?.from.path ?? '(?!)');
    const governed = modules.filter((m) => fromRe.test(m));
    expect(governed.length, 'the `from` path governs no module at all').toBeGreaterThan(0);
    expect(
      governed.filter((m) => m.endsWith('.test.ts')),
      'a test file is back inside the domain core; either move it under tests/ or restore an exemption',
    ).toEqual([]);
  });
});

describe('DepcruiseRule_SeededViolation_StillFails', () => {
  /** The rule's own predicate: does this (from, to) pair violate it? */
  function violates(from: string, to: string): boolean {
    const fromRe = new RegExp(rule?.from.path ?? '(?!)');
    const notRe = rule?.from.pathNot ? new RegExp(rule.from.pathNot) : undefined;
    const toRe = new RegExp(rule?.to.path ?? '(?!)');
    return fromRe.test(from) && !(notRe?.test(from) ?? false) && toRe.test(to);
  }

  it('a seeded core → adapters edge is caught', () => {
    // Built from REAL live modules, not invented strings: a synthetic path
    // could satisfy a regex that no actual file would.
    const fromRe = new RegExp(rule?.from.path ?? '(?!)');
    const notRe = new RegExp(rule?.from.pathNot ?? '(?!)');
    const toRe = new RegExp(rule?.to.path ?? '(?!)');
    const coreModule = modules.find((m) => fromRe.test(m) && !notRe.test(m));
    const adapterModule = modules.find((m) => toRe.test(m));
    expect(coreModule, 'no live domain-core module to seed from').toBeDefined();
    expect(adapterModule, 'no live adapters module to seed to').toBeDefined();
    expect(violates(coreModule as string, adapterModule as string)).toBe(true);
  });

  it('a relocated core test is outside the governed set entirely', () => {
    // The exemption this replaces was `pathNot`. A co-located core test is now
    // exempt by ADDRESS rather than by exclusion, so the property to pin is
    // that its new home under tests/ falls outside `from` altogether.
    const relocated = 'tests/unit/workflow/tools.test.ts';
    const adapterModule = modules.find((m) => new RegExp(rule?.to.path ?? '(?!)').test(m));
    expect(adapterModule, 'no live adapters module to seed to').toBeDefined();
    expect(new RegExp(rule?.from.path ?? '(?!)').test(relocated)).toBe(false);
    expect(violates(relocated, adapterModule as string)).toBe(false);
  });

  it('an edge that leaves the governed set is NOT caught', () => {
    // The negative half: a rule that flags everything is as useless as one that
    // flags nothing, and both look green until someone reads the output.
    const ungoverned = modules.find((m) => !new RegExp(rule?.from.path ?? '(?!)').test(m));
    const adapterModule = modules.find((m) => new RegExp(rule?.to.path ?? '(?!)').test(m));
    expect(ungoverned).toBeDefined();
    expect(violates(ungoverned as string, adapterModule as string)).toBe(false);
  });

  it('the rule is the one static analysis actually runs', () => {
    // Liveness here is worthless if the gate stopped invoking the config.
    const staticAnalysis = readFileSync(
      path.join(REPO_ROOT, 'src/verbs/pure/static-analysis.ts'),
      'utf8',
    );
    expect(staticAnalysis).toMatch(/depcruise --validate/);
    // The gate SKIPs when no config is present, so the config existing where the
    // gate looks for it is part of the rule being live at all.
    expect(staticAnalysis).toMatch(/\.dependency-cruiser/);
  });
});
