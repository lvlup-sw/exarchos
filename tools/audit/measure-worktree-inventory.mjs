// @ts-check
/**
 * @fileoverview Inventories worktrees and branches WITHOUT removing anything.
 *
 * The design originally called for pruning. That is withdrawn: at least one of
 * these worktrees held the only copy of an unlanded implementation, discovered
 * while looking for something else, and there is no cheap way to know which
 * others do without reading them. An inventory costs nothing and keeps every
 * option open; a prune is irreversible and, on this evidence, would have
 * destroyed work.
 *
 * So this reports what exists and what carries commits absent from the default
 * branch. Deciding what to do with them is a separate, human step.
 *
 * Reports. Never removes, never writes to any worktree.
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
 * Commits on `ref` that are not reachable from the default branch.
 *
 * This is the question that matters: a worktree whose branch is fully merged
 * carries nothing, while one with unique commits may be the only copy.
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
