// @ts-check
/**
 * @fileoverview Counts live references into each subtree that the refactor plans
 * to delete or re-home. A referenced path is not a deletion candidate.
 *
 * The scan covers more than source, because three kinds of referrer are easy to miss:
 *
 *   - Markdown at its current location. A scan of the post-move directory returns a false zero.
 *   - `*.snap` snapshots. They hold paths as plain text, and no type check reads them.
 *   - Extensionless governance files in `NAMED_FILES`. No extension filter sees CODEOWNERS.
 *
 * The script only reports. The accompanying test holds the assertions.
 *
 * Usage: `node tools/audit/measure-reference-census.mjs [--out FILE]`
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = process.cwd();

/** Subtrees the design marks for removal from this repository. */
const PROSE_SUBTREES = [
  'docs/designs',
  'docs/plans',
  'docs/research',
  'docs/audits',
  'docs/adrs',
  'docs/rca',
  'docs/guides',
  'docs/references',
  'docs/proposals',
  'docs/bugs',
  'docs/followups',
  'docs/refactors',
  'docs/runbooks',
  'docs/contexts',
  'docs/market',
  'docs/migrations',
];

/** Subtrees that move to a new home instead of deletion. The report gives them the `re-home` disposition. */
const REHOMED_SUBTREES = ['docs/evals', 'docs/schemas', 'docs/assets', 'docs/architecture'];

const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx',
  '.json', '.yml', '.yaml', '.sh', '.ps1', '.html', '.md', '.snap',
]);

/** Extensionless governance files no extension filter can see. */
const NAMED_FILES = ['.github/CODEOWNERS', '.gitattributes', '.npmignore', '.exarchos.yml'];

/**
 * The output file of this script, which the scan skips.
 * The report holds referrer paths as plain text in `sampleReferrers`.
 * Thus a later run reads it as a live `config` referrer of the subtrees that it measures.
 * A record of references is not a reference that a reader follows.
 * The scan reads this file too, so the comments in this file must name no subtree path.
 */
const SELF_OUTPUT = 'tools/audit/reference-census.json';

/**
 * Records of relocation, which the scan skips for the same reason as `SELF_OUTPUT`.
 * The exodus manifest lists each relocated path. Without this skip, each subtree
 * that left keeps a permanent live referrer, which is the record of its own move.
 */
const RELOCATION_RECORDS = ['tools/audit/prose-manifest.json'];

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
 * Writes the census as JSON to the `--out` file or to stdout.
 * A file inside a subtree that refers to the same subtree is not an external referrer.
 * A Markdown file outside `docs/` is a live referrer that a reader follows.
 * A Markdown file under `docs/` is a dated record, so it counts as `markdownArchival` and not as a
 * live referrer. A rewrite of a dated record falsifies it.
 */
function main() {
  const argv = process.argv.slice(2);
  const outFlag = argv.indexOf('--out');
  const outPath = outFlag >= 0 ? argv[outFlag + 1] : undefined;

  const tracked = trackedFiles();
  const scanned = tracked.filter(
    (rel) =>
      rel !== SELF_OUTPUT &&
      !RELOCATION_RECORDS.includes(rel) &&
      (SCAN_EXTENSIONS.has(path.extname(rel)) || NAMED_FILES.includes(rel)),
  );

  const subtrees = [...PROSE_SUBTREES, ...REHOMED_SUBTREES];
  /** @type {Record<string, { ownFiles: number, referrers: Set<string> }>} */
  const acc = {};
  for (const subtree of subtrees) {
    acc[subtree] = {
      ownFiles: tracked.filter((rel) => rel.startsWith(`${subtree}/`)).length,
      referrers: new Set(),
    };
  }

  for (const rel of scanned) {
    let text;
    try {
      text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    for (const subtree of subtrees) {
      if (rel.startsWith(`${subtree}/`)) continue;
      if (text.includes(`${subtree}/`)) acc[subtree].referrers.add(rel);
    }
  }

  /** @type {Record<string, unknown>} */
  const report = {};
  for (const subtree of subtrees) {
    const referrers = [...acc[subtree].referrers].sort();
    report[subtree] = {
      disposition: PROSE_SUBTREES.includes(subtree) ? 'delete' : 're-home',
      ownFiles: acc[subtree].ownFiles,
      externalReferrers: referrers.length,
      referrersByKind: {
        code: referrers.filter((r) => /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(r)).length,
        config: referrers.filter((r) => /\.(json|ya?ml)$/.test(r) || NAMED_FILES.includes(r)).length,
        snapshot: referrers.filter((r) => r.endsWith('.snap')).length,
        markdownLive: referrers.filter((r) => r.endsWith('.md') && !r.startsWith('docs/')).length,
        markdownArchival: referrers.filter((r) => r.endsWith('.md') && r.startsWith('docs/')).length,
        other: referrers.filter((r) => /\.(sh|ps1|html)$/.test(r)).length,
      },
      liveReferrers: referrers.filter(
        (r) =>
          /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|ya?ml|sh|ps1|html|snap)$/.test(r) ||
          NAMED_FILES.includes(r) ||
          (r.endsWith('.md') && !r.startsWith('docs/')),
      ).length,
      sampleReferrers: referrers.slice(0, 12),
      sampleLiveCodeReferrers: referrers
        .filter((r) => /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(r))
        .slice(0, 8),
    };
  }

  const payload = {
    capturedAt: new Date().toISOString().slice(0, 10),
    trackedFiles: tracked.length,
    scannedFiles: scanned.length,
    namedFilesIncluded: NAMED_FILES.filter((rel) => tracked.includes(rel)),
    subtrees: report,
  };
  const json = JSON.stringify(payload, null, 2);
  if (outPath) fs.writeFileSync(outPath, `${json}\n`, 'utf8');
  else process.stdout.write(`${json}\n`);
}

main();
