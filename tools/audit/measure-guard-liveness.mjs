// @ts-check
/**
 * @fileoverview Records what every guard and governance surface currently
 * MATCHES, so one that stops matching after the move is detectable.
 *
 * Each of these is configured with literal paths, and the structure refactor
 * rewrites nearly all of them. The dangerous outcome is not a guard that fails
 * — it is a guard whose glob resolves to nothing and therefore passes forever.
 * A count captured before the move is what turns that silence into a diff.
 *
 * Governance surfaces are included alongside the guards because they share the
 * failure mode: a CODEOWNERS pattern matching nothing collapses ownership to
 * the `*` fallback without any error, and a `files[]` entry naming a missing
 * path ships a package quietly short of what it promised.
 *
 * Reports. Never fails — the assertions live in the accompanying test.
 *
 * Usage: `node tools/audit/measure-guard-liveness.mjs [--out FILE]`
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = process.cwd();

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

/**
 * CODEOWNERS patterns follow gitignore semantics, not glob semantics: a bare
 * `scripts/` owns the whole subtree, and `*` owns everything.
 *
 * @param {string} pattern
 * @returns {(rel: string) => boolean}
 */
function codeownersMatcher(pattern) {
  if (pattern === '*') return () => true;
  const bare = pattern.replace(/^\//, '');
  if (bare.endsWith('/')) return (rel) => rel.startsWith(bare);
  return (rel) => rel === bare || rel.startsWith(`${bare}/`);
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

function main() {
  const argv = process.argv.slice(2);
  const outFlag = argv.indexOf('--out');
  const outPath = outFlag >= 0 ? argv[outFlag + 1] : undefined;

  const tracked = trackedFiles();
  /** @type {Record<string, { kind: string, matched: number, detail?: unknown }>} */
  const surfaces = {};

  // ── dependency-cruiser: the live `error`-severity boundary rule ────────────
  // Both sides are measured. The rule can evaporate from either end: if the
  // constrained set empties it constrains nothing, and if the forbidden target
  // set empties there is nothing left to forbid.
  const depcruise = readIfPresent('.dependency-cruiser.cjs') ?? '';
  const fromMatch = depcruise.match(/path:\s*'(\^src\/\([^']+\)\/)'/);
  const toMatch = depcruise.match(/path:\s*'(\^src\/adapters\/)'/);
  if (fromMatch) {
    const re = new RegExp(fromMatch[1]);
    surfaces['depcruise:no-domain-core-to-io-adapters:from'] = {
      kind: 'module-set',
      matched: tracked.filter((rel) => re.test(rel) && !/\.test\.ts$/.test(rel)).length,
      detail: { pattern: fromMatch[1] },
    };
  }
  if (toMatch) {
    const re = new RegExp(toMatch[1]);
    surfaces['depcruise:no-domain-core-to-io-adapters:to'] = {
      kind: 'module-set',
      matched: tracked.filter((rel) => re.test(rel)).length,
      detail: { pattern: toMatch[1] },
    };
  }

  // ── CODEOWNERS — enumerated by name because it is extensionless ────────────
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

  // ── package.json files[] — a shipped entry naming nothing ships nothing ────
  const pkg = JSON.parse(readIfPresent('package.json') ?? '{}');
  for (const entry of pkg.files ?? []) {
    if (typeof entry !== 'string' || entry.startsWith('!')) continue;
    surfaces[`package.files:${entry}`] = {
      kind: 'packaging',
      matched: exists(entry) ? 1 : 0,
    };
  }

  // ── protected-suites — explicit test paths under a generated root ──────────
  const protectedSuites = JSON.parse(readIfPresent('tools/audit/protected-suites.json') ?? '{}');
  if (Array.isArray(protectedSuites.files)) {
    // The entries are already repository-relative despite `generatedFrom`
    // naming the root they were generated from. Joining the two double-prefixes
    // every path and reports a confident zero — which is the same false signal
    // this instrument exists to detect, produced by the instrument itself. So
    // resolve an entry as-is, and only fall back to the join when that fails.
    const root = protectedSuites.generatedFrom ?? '';
    const resolve = (rel) => (exists(rel) ? rel : path.posix.join(root, rel));
    const present = protectedSuites.files.filter((rel) => exists(resolve(rel)));
    surfaces['protected-suites:files'] = {
      kind: 'test-protection',
      matched: present.length,
      detail: { declared: protectedSuites.files.length, generatedFrom: root },
    };
  }

  // ── invariants catalog `references:` keys — they name source AND test ──────
  // Scoped to `references:` blocks specifically. Scraping every list item that
  // ends in a code extension also picks up `applies-to:` entries, which are
  // conceptual labels rather than paths — `format.ts` there names a concern,
  // not a file, and resolving it reports an evaporation that is not real.
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
  // A reference may carry an anchor (`docs/architecture/runtime.md#§4`). The
  // anchor is part of the citation, not part of the path, and resolving it
  // verbatim reports every deep link as broken.
  const uniqueRefs = [...new Set(refs.map((rel) => rel.split('#')[0]))];
  surfaces['invariants:references'] = {
    kind: 'catalog-reference',
    matched: uniqueRefs.filter((rel) => exists(rel)).length,
    detail: { declared: uniqueRefs.length },
  };

  // ── lint scopes — the CLI glob is what bounds the run, not the config ──────
  surfaces['lint:eslint-cli-glob'] = {
    kind: 'lint-scope',
    matched: tracked.filter((rel) => rel.startsWith('src/') && rel.endsWith('.ts'))
      .length,
    detail: { glob: 'src/**/*.ts' },
  };
  surfaces['lint:inv6'] = {
    kind: 'lint-scope',
    matched: tracked.filter((rel) => rel.startsWith('content/') && rel.endsWith('.md')).length,
  };
  surfaces['lint:test-first-drift'] = {
    kind: 'lint-scope',
    matched: tracked.filter(
      (rel) =>
        (rel.startsWith('commands/') || rel.startsWith('agents/') || rel.startsWith('content/')) &&
        rel.endsWith('.md'),
    ).length,
  };

  // ── knip workspaces ───────────────────────────────────────────────────────
  const knip = JSON.parse(readIfPresent('knip.json') ?? '{}');
  for (const ws of Object.keys(knip.workspaces ?? {})) {
    surfaces[`knip:workspace:${ws}`] = { kind: 'dead-code', matched: exists(ws) ? 1 : 0 };
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
