// @ts-check
/**
 * @fileoverview Counts live references into every subtree the refactor plans
 * to delete or relocate.
 *
 * Deletion is the one step with no cheap undo, so nothing is removed on the
 * strength of a map someone drew. A referenced path is not a deletion
 * candidate, and this is the artifact that decides which is which.
 *
 * The scan surface is deliberately wider than source. Three classes of referrer
 * are easy to miss and each has bitten this kind of refactor before:
 *
 *   - markdown WHEREVER it currently lives, not under some post-move directory
 *     that does not exist yet — scoping the scan to the destination returns a
 *     confident zero;
 *   - `*.snap` snapshots, which embed paths as plain text and are regenerated
 *     rather than type-checked, so a stale path there fails at review time at
 *     the earliest;
 *   - extensionless governance files enumerated BY NAME, since CODEOWNERS
 *     cannot be seen by any extension-filtered glob.
 *
 * Reports. Never fails — the assertions live in the accompanying test.
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

/** Subtrees that are re-homed rather than deleted; counted separately. */
const REHOMED_SUBTREES = ['docs/evals', 'docs/schemas', 'docs/assets', 'docs/architecture'];

const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx',
  '.json', '.yml', '.yaml', '.sh', '.ps1', '.html', '.md', '.snap',
]);

/** Extensionless governance files no extension filter can see. */
const NAMED_FILES = ['.github/CODEOWNERS', '.gitattributes', '.npmignore', '.exarchos.yml'];

/**
 * This instrument's own output, excluded from its own scan.
 *
 * The report embeds referrer paths verbatim in `sampleReferrers`, so once it
 * has been written it holds subtree-qualified paths as plain text — and the
 * next run reads it back as a live `config` referrer of exactly the subtrees
 * it is measuring. That is a feedback loop, not a finding: a record OF
 * references is not itself a reference a reader would follow. Same reasoning
 * as the sibling-reference exclusion below.
 *
 * For the same reason this comment names no subtree path literally: prose in
 * THIS file is scanned too, and a worked example here would re-create the loop
 * one level up.
 */
const SELF_OUTPUT = 'tools/audit/reference-census.json';

/**
 * Records OF relocation, excluded for the same reason as this instrument's own
 * output: they enumerate paths in order to prove those paths were preserved,
 * not because anything reads them.
 *
 * Without this the exodus manifest lists every relocated path verbatim, the
 * next census reads it back as a live `config` referrer of every subtree that
 * has ALREADY left, and each departed subtree acquires a permanent live
 * referrer supplied by the record of its own departure.
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
      // A file inside the subtree referring to a sibling is not an external
      // reference — counting it would make every subtree look load-bearing.
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
      // Categorized because the remedy differs. Markdown splits by location
      // rather than by extension: an instruction file or a shipped skill is a
      // LIVE referrer a reader will follow, while a dated record under `docs/`
      // is history that is explicitly out of scope — it described the tree as
      // it stood, and rewriting it would falsify the record.
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
