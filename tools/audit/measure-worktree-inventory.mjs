// @ts-check
/**
 * @fileoverview Inventories worktrees and branches. It removes no worktree and no branch.
 *
 * A worktree can hold the only copy of unlanded work, and a prune is irreversible.
 * Thus the script reports each worktree and its count of commits absent from the base branch.
 * A human decides what to do with them.
 *
 * Usage: `node tools/audit/measure-worktree-inventory.mjs [--out FILE]`
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = process.cwd();

/** @param {string[]} args */
function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Parse `git worktree list --porcelain` into records. */
function worktrees() {
  /** @type {{ path: string, branch: string | null, detached: boolean }[]} */
  const out = [];
  /** @type {{ path?: string, branch?: string | null, detached?: boolean }} */
  let current = {};
  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path !== undefined) out.push(/** @type {any} */ (current));
      current = { path: line.slice('worktree '.length), branch: null, detached: false };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    } else if (line === 'detached') {
      current.detached = true;
    }
  }
  if (current.path !== undefined) out.push(/** @type {any} */ (current));
  return out;
}

/**
 * Counts the commits on `ref` that `base` cannot reach, or returns `unknown` when git fails.
 * A merged branch carries nothing. A branch with unique commits can hold the only copy of work.
 *
 * @param {string} ref
 * @param {string} base
 */
function unmergedCount(ref, base) {
  try {
    return git(['rev-list', '--count', `${base}..${ref}`]).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Writes the inventory as JSON to the `--out` file or to stdout.
 * `capturedIn` names the worktree of the run. Thus the artifact alone shows that the
 * run is in its own records, and that a prune here is self-destructive.
 */
function main() {
  const argv = process.argv.slice(2);
  const outFlag = argv.indexOf('--out');
  const outPath = outFlag >= 0 ? argv[outFlag + 1] : undefined;

  const base = 'origin/main';
  const trees = worktrees();

  const records = trees.map((tree) => {
    const exists = fs.existsSync(tree.path);
    const ahead = tree.branch === null ? 'detached' : unmergedCount(tree.branch, base);
    return {
      path: tree.path.replace(`${REPO_ROOT}/`, ''),
      branch: tree.branch,
      directoryPresent: exists,
      commitsNotOnBase: ahead,
      carriesUniqueWork: ahead !== '0' && ahead !== 'detached' && ahead !== 'unknown',
    };
  });

  const branches = git(['branch', '--format=%(refname:short)'])
    .split('\n')
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const merged = new Set(
    git(['branch', '--merged', base, '--format=%(refname:short)'])
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b.length > 0),
  );

  const payload = {
    capturedAt: new Date().toISOString().slice(0, 10),
    capturedIn: REPO_ROOT,
    base,
    disposition: 'inventory-only',
    dispositionRationale:
      'Pruning is withdrawn. One of these worktrees held the only copy of an unlanded comment-prose implementation, found incidentally; there is no cheap way to know which others do. An inventory is reversible and a prune is not.',
    worktrees: {
      total: records.length,
      carryingUniqueWork: records.filter((r) => r.carriesUniqueWork).length,
      missingDirectory: records.filter((r) => !r.directoryPresent).length,
      countingCaveat:
        'This repository merges by squash, which rewrites history: the original commits never appear on the base branch, so a fully-shipped branch still reports commits ahead. The count therefore OVERSTATES how much unique work exists. That is the safe direction for an inventory — it can only make a branch look more valuable than it is, never less — but it means the number cannot be used to justify deletion. Telling shipped from unshipped needs a patch-level comparison, which is deliberately not attempted here.',
      records,
    },
    branches: {
      total: branches.length,
      mergedIntoBase: branches.filter((b) => merged.has(b)).length,
      unmerged: branches.filter((b) => !merged.has(b)).length,
      note: 'Counted only. Deletion of merged branches is a separate decision and is not taken here.',
    },
  };

  const json = JSON.stringify(payload, null, 2);
  if (outPath) fs.writeFileSync(outPath, `${json}\n`, 'utf8');
  else process.stdout.write(`${json}\n`);
}

main();
