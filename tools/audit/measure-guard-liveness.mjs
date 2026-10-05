// @ts-check
/**
 * @fileoverview Records what each guard and governance surface matches, so a
 * surface that stops matching after a move shows up as a diff.
 *
 * A guard whose glob resolves to nothing passes forever. A CODEOWNERS pattern
 * that matches nothing falls back to `*` without an error. A `files[]` entry
 * that names a missing path ships a short package. A count captured before a
 * move turns this silence into a diff.
 *
 * The script reports counts. It throws when it cannot read a surface scope from
 * its config. The accompanying test holds the other assertions.
 *
 * Usage: `node tools/audit/measure-guard-liveness.mjs [--out FILE]`
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { codeownersMatcher } from './lib/codeowners-match.mjs';
import { globsMatch } from './lib/lint-scope.mjs';

const requireConfig = createRequire(import.meta.url);
const REPO_ROOT = process.cwd();

/**
 * Loads the live error-severity boundary rule `no-domain-core-to-io-adapters`.
 * A missing or malformed rule throws. A regex scrape keeps reporting counts
 * after a rename or a removal of the rule.
 *
 * @returns {{ from: string, to: string }}
 */
function liveBoundaryRule() {
  const configPath = path.join(REPO_ROOT, '.dependency-cruiser.cjs');
  /** @type {{ forbidden?: ReadonlyArray<{ name?: string, severity?: string, from?: { path?: string }, to?: { path?: string } }> }} */
  const config = requireConfig(configPath);
  const rule = (config.forbidden ?? []).find((r) => r.name === 'no-domain-core-to-io-adapters');
  if (
    rule === undefined ||
    rule.severity !== 'error' ||
    typeof rule.from?.path !== 'string' ||
    typeof rule.to?.path !== 'string'
  ) {
    throw new Error(
      'no-domain-core-to-io-adapters is missing or is not an error-severity from/to rule',
    );
  }
  return { from: rule.from.path, to: rule.to.path };
}

/** @returns {string[]} every tracked path, POSIX-separated */
function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
    .split('\0')
    .filter((rel) => rel.length > 0);
}

/** @param {string} rel */
function exists(rel) {
  return fs.existsSync(path.join(REPO_ROOT, rel));
}

/** @param {string} file */
function readIfPresent(file) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Measures each surface and writes the JSON report to `--out` or stdout.
 *
 * The scopes are read from their configs, not restated, so the report cannot
 * measure a stale copy. Both sides of the boundary rule are counted, because
 * the rule stops working when either set is empty. Protected-suite entries
 * resolve as written first, and count only when tracked. Catalog references
 * come from `references:` blocks only. Their anchors are stripped. A
 * `<owner>/<repo>:<path>` reference to another repository counts as `relocated`,
 * not as declared.
 */
function main() {
  const argv = process.argv.slice(2);
  const outFlag = argv.indexOf('--out');
  const outPath = outFlag >= 0 ? argv[outFlag + 1] : undefined;

  const tracked = trackedFiles();
  /** @type {Record<string, { kind: string, matched: number, detail?: unknown }>} */
  const surfaces = {};

  const boundary = liveBoundaryRule();
  const fromRe = new RegExp(boundary.from);
  const toRe = new RegExp(boundary.to);
  surfaces['depcruise:no-domain-core-to-io-adapters:from'] = {
    kind: 'module-set',
    matched: tracked.filter((rel) => fromRe.test(rel) && !/\.test\.ts$/.test(rel)).length,
    detail: { pattern: boundary.from },
  };
  surfaces['depcruise:no-domain-core-to-io-adapters:to'] = {
    kind: 'module-set',
    matched: tracked.filter((rel) => toRe.test(rel)).length,
    detail: { pattern: boundary.to },
  };

  const codeowners = readIfPresent('.github/CODEOWNERS');
  if (codeowners !== undefined) {
    for (const line of codeowners.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const pattern = trimmed.split(/\s+/)[0];
      if (pattern === undefined) continue;
      const match = codeownersMatcher(pattern);
      surfaces[`codeowners:${pattern}`] = {
        kind: 'ownership',
        matched: tracked.filter(match).length,
      };
    }
  }

  const pkg = JSON.parse(readIfPresent('package.json') ?? '{}');
  for (const entry of pkg.files ?? []) {
    if (typeof entry !== 'string' || entry.startsWith('!')) continue;
    const buildOutput = entry.startsWith('dist/');
    surfaces[`package.files:${entry}`] = {
      kind: buildOutput ? 'build-output' : 'packaging',
      matched: buildOutput
        ? exists(entry)
          ? 1
          : 0
        : tracked.filter((rel) => rel === entry || rel.startsWith(`${entry}/`)).length,
      detail: { buildOutput },
    };
  }

  const protectedSuites = JSON.parse(readIfPresent('tools/audit/protected-suites.json') ?? '{}');
  if (Array.isArray(protectedSuites.files)) {
    const root = protectedSuites.generatedFrom ?? '';
    const resolve = (rel) => (exists(rel) ? rel : path.posix.join(root, rel));
    const present = protectedSuites.files.filter((rel) => {
      const resolved = resolve(rel);
      return tracked.includes(rel) || tracked.includes(resolved);
    });
    surfaces['protected-suites:files'] = {
      kind: 'test-protection',
      matched: present.length,
      detail: { declared: protectedSuites.files.length, generatedFrom: root },
    };
  }

  const catalog = readIfPresent('.exarchos/invariants.md') ?? '';
  /** @type {string[]} */
  const refs = [];
  let inReferences = false;
  let blockIndent = 0;
  for (const line of catalog.split('\n')) {
    const keyMatch = line.match(/^(\s*)([\w-]+):\s*$/);
    if (keyMatch) {
      inReferences = keyMatch[2] === 'references';
      blockIndent = keyMatch[1].length;
      continue;
    }
    if (!inReferences) continue;
    const item = line.match(/^(\s*)-\s+(\S+)\s*$/);
    if (item === null || item[1].length <= blockIndent) {
      if (line.trim().length > 0) inReferences = false;
      continue;
    }
    refs.push(item[2]);
  }
  const uniqueRefs = [...new Set(refs.map((rel) => rel.split('#')[0]))];
  const localRefs = uniqueRefs.filter((rel) => !/^[\w.-]+\/[\w.-]+:/.test(rel));
  surfaces['invariants:references'] = {
    kind: 'catalog-reference',
    matched: localRefs.filter((rel) => exists(rel)).length,
    detail: { declared: localRefs.length, relocated: uniqueRefs.length - localRefs.length },
  };

  const lintScript = String(JSON.parse(readIfPresent('package.json') ?? '{}').scripts?.lint ?? '');
  const lintGlobs = [...lintScript.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (lintGlobs.length === 0) {
    throw new Error('cannot read the `lint` script\'s CLI globs from package.json — refusing to guess');
  }
  surfaces['lint:eslint-cli-glob'] = {
    kind: 'lint-scope',
    matched: tracked.filter((rel) => globsMatch(lintGlobs, rel)).length,
    detail: { glob: lintGlobs.join(' ') },
  };
  const inv6Script = String(pkg.scripts?.['lint:inv6'] ?? '');
  const inv6Roots = inv6Script
    .split(/\s+/)
    .filter((tok) => tok.endsWith('/') && !tok.includes('lint-inv6') && !tok.startsWith('-'));
  if (inv6Roots.length === 0) {
    throw new Error('cannot read lint:inv6 directory operands from package.json — refusing to guess');
  }
  surfaces['lint:inv6'] = {
    kind: 'lint-scope',
    matched: tracked.filter(
      (rel) => rel.endsWith('.md') && inv6Roots.some((root) => rel.startsWith(root)),
    ).length,
    detail: { glob: inv6Roots.join(' ') },
  };
  const driftGate = readIfPresent('tools/audit/gates/lint-test-first-drift.mjs') ?? '';
  const driftDirs = [...(/const DEFAULT_DIRS = \[([^\]]*)\]/.exec(driftGate)?.[1] ?? '')
    .matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (driftDirs.length === 0) {
    throw new Error('cannot read DEFAULT_DIRS from lint-test-first-drift.mjs — refusing to guess');
  }
  surfaces['lint:test-first-drift'] = {
    kind: 'lint-scope',
    matched: tracked.filter(
      (rel) => rel.endsWith('.md') && driftDirs.some((d) => rel.startsWith(`${d}/`)),
    ).length,
    detail: { glob: driftDirs.join(' ') },
  };

  const knip = JSON.parse(readIfPresent('knip.json') ?? '{}');
  for (const [ws, cfg] of Object.entries(knip.workspaces ?? {})) {
    const project = Array.isArray(cfg?.project) ? cfg.project : [];
    const prefixes = project
      .filter((g) => typeof g === 'string' && !g.startsWith('!'))
      .map((g) => g.replace(/\*.*$/, ''))
      .filter((p) => p.length > 0);
    if (prefixes.length === 0) {
      throw new Error(`knip workspace "${ws}" declares no positive project globs — refusing to guess`);
    }
    surfaces[`knip:workspace:${ws}`] = {
      kind: 'dead-code',
      matched: tracked.filter((rel) => prefixes.some((p) => rel.startsWith(p))).length,
      detail: { glob: project.join(' ') },
    };
  }

  const payload = {
    capturedAt: new Date().toISOString().slice(0, 10),
    trackedFiles: tracked.length,
    surfaces,
  };
  const json = JSON.stringify(payload, null, 2);
  if (outPath) fs.writeFileSync(outPath, `${json}\n`, 'utf8');
  else process.stdout.write(`${json}\n`);
}

main();
