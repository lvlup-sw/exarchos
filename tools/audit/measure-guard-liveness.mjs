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
import { codeownersMatcher } from './lib/codeowners-match.mjs';

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
  //
  // Source-tree entries are counted from `git ls-files`. Build outputs
  // (`dist/…`) are not tracked and are legitimately absent before
  // `npm run build`; they are recorded as `build-output` so a pre-build
  // suite can skip the emptiness check without treating a missing source
  // path the same way.
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
    // Membership is tracked files, the same predicate the governance census
    // uses. Disk `exists()` would count an untracked local copy as live while
    // the census reported the path dead — two greens that mean different
    // things. `resolve` still consults the working tree only to recover the
    // `generatedFrom` prefix when the declared path is written relative to it.
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
  // A `<owner>/<repo>:<path>` reference names a document in ANOTHER repository
  // and is never expected to resolve here. Counting those as declared-but-
  // unresolved reports the catalog as partially evaporated every time a
  // document relocates — a false finding that would train a reader to ignore
  // the real one, which is a LOCAL path that stopped existing.
  const localRefs = uniqueRefs.filter((rel) => !/^[\w.-]+\/[\w.-]+:/.test(rel));
  surfaces['invariants:references'] = {
    kind: 'catalog-reference',
    matched: localRefs.filter((rel) => exists(rel)).length,
    detail: { declared: localRefs.length, relocated: uniqueRefs.length - localRefs.length },
  };

  // ── lint scopes — the CLI glob is what bounds the run, not the config ──────
  //
  // These are READ from the configs they describe, never restated. A measurer
  // that carries its own copy of a path measures its own copy: task 042 found
  // this surface hard-coded to `src/**/*.ts` while the lint script had already
  // been widened, so it reported a number no run would ever produce — a
  // liveness instrument that had itself gone stale.
  const lintScript = String(JSON.parse(readIfPresent('package.json') ?? '{}').scripts?.lint ?? '');
  const lintGlobs = [...lintScript.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (lintGlobs.length === 0) {
    throw new Error('cannot read the `lint` script\'s CLI globs from package.json — refusing to guess');
  }
  const lintPrefixes = lintGlobs.map((g) => g.replace(/\*.*$/, ''));
  surfaces['lint:eslint-cli-glob'] = {
    kind: 'lint-scope',
    matched: tracked.filter(
      (rel) => rel.endsWith('.ts') && lintPrefixes.some((p) => rel.startsWith(p)),
    ).length,
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
  // Read from the gate's own DEFAULT_DIRS for the same reason. This surface
  // restated `commands/ agents/ content/` — the pre-DR-4 roots — and so counted
  // two directories that no longer exist while missing rendered/agents/, which
  // the npm script actually scans. It stayed comfortably non-zero on content/
  // alone, which is how a surface reports health while measuring the wrong set.
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

  // ── knip workspaces ───────────────────────────────────────────────────────
  // Count tracked files under the workspace's `project` globs. `exists(ws)`
  // for workspace `.` is always 1 and proves the key exists, not that knip
  // scans anything.
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
