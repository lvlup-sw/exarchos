/**
 * Drive the prose exodus: generate the manifest, copy to the destination,
 * reconcile.
 *
 * Three subcommands, deliberately separate so the destructive one is never a
 * side effect of the safe ones:
 *
 *   generate  — read the reference census, take every subtree with ZERO live
 *               referrers, and write `tools/audit/prose-manifest.json`.
 *   transfer  — copy every manifest entry into a checkout of the destination
 *               repository. Idempotent; writes nothing outside the key.
 *   reconcile — recompute every digest at the destination and report.
 *
 * Deletion is NOT a subcommand here. It is `git rm` performed by a human or a
 * task that has read a passing reconciliation, because the whole design intent
 * is that removal is a separate decision from preservation.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildManifest,
  formatReconcile,
  reconcile,
  type ProseManifest,
} from './prose-manifest.js';

const REPO_ROOT = process.cwd();
const MANIFEST_PATH = path.join(REPO_ROOT, 'tools/audit/prose-manifest.json');

interface CensusSubtree {
  readonly disposition?: string;
  readonly ownFiles?: number;
  readonly liveReferrers?: number;
}

/** Subtrees with zero live referrers, read from the live census. */
function eligibleSubtrees(): string[] {
  const raw = execFileSync('node', ['tools/audit/measure-reference-census.mjs'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const census = JSON.parse(raw.slice(raw.indexOf('{'))) as {
    subtrees: Record<string, CensusSubtree>;
  };
  const eligible = Object.entries(census.subtrees)
    .filter(([, s]) => (s.liveReferrers ?? 1) === 0 && (s.ownFiles ?? 0) > 0)
    .map(([name]) => name)
    .sort();
  if (eligible.length === 0) {
    throw new Error(
      'the census reports no subtree with zero live referrers — nothing is eligible to move, ' +
        'and a manifest over nothing would reconcile clean against an empty destination',
    );
  }
  return eligible;
}

function loadManifest(): ProseManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ProseManifest;
}

function generate(capturedAt: string): void {
  const subtrees = eligibleSubtrees();
  const manifest = buildManifest(REPO_ROOT, subtrees, capturedAt);
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(
    `[prose-exodus] manifest: ${manifest.counts.files} file(s), ` +
      `${manifest.counts.bytes} bytes, across ${subtrees.length} subtree(s): ${subtrees.join(', ')}`,
  );
}

function transfer(destinationRoot: string): void {
  const manifest = loadManifest();
  for (const entry of manifest.entries) {
    const dest = path.join(destinationRoot, entry.destination);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(REPO_ROOT, entry.source), dest);
  }
  console.log(`[prose-exodus] copied ${manifest.entries.length} file(s) to ${destinationRoot}`);
}

function runReconcile(destinationRoot: string): void {
  const result = reconcile(loadManifest(), destinationRoot);
  console.log(`[prose-exodus] ${formatReconcile(result)}`);
  if (!result.ok) process.exit(1);
}

const [command, arg] = process.argv.slice(2);
switch (command) {
  case 'generate':
    // The timestamp is an argument rather than `new Date()` so a regeneration
    // that changes nothing else produces no diff.
    generate(arg ?? new Date().toISOString().slice(0, 10));
    break;
  case 'transfer':
    if (arg === undefined) throw new Error('transfer requires a destination checkout path');
    transfer(arg);
    break;
  case 'reconcile':
    if (arg === undefined) throw new Error('reconcile requires a destination checkout path');
    runReconcile(arg);
    break;
  default:
    console.error('usage: prose-exodus-cli <generate [date] | transfer <dest> | reconcile <dest>>');
    process.exit(2);
}
