/**
 * Drives the prose exodus with three separate subcommands:
 *
 *   generate  — writes `tools/audit/prose-manifest.json` for each tracked file
 *               under `docs/` that is not retained.
 *   transfer  — copies each manifest entry into a checkout of the destination
 *               repository.
 *   reconcile — recomputes each digest at the destination and reports.
 *
 * Deletion is not a subcommand. A person or a task runs `git rm` after a passing
 * reconciliation, because removal is a decision separate from preservation.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildManifest,
  formatReconcile,
  isRetained,
  reconcile,
  trackedUnder,
  type ProseManifest,
} from './prose-manifest.js';

const REPO_ROOT = process.cwd();
const MANIFEST_PATH = path.join(REPO_ROOT, 'tools/audit/prose-manifest.json');

/**
 * Each tracked path under `docs/` that is not retained. The list comes from git,
 * not from subtree names. Thus a new directory under `docs/` relocates by
 * default, and it stays only when `RETAINED` in `prose-manifest.ts` names it.
 */
function relocatablePaths(): string[] {
  const tracked = trackedUnder(REPO_ROOT, 'docs');

  const relocatable = tracked.filter((rel) => !isRetained(rel)).sort();
  if (tracked.length === 0) {
    throw new Error(
      'git reports no tracked file under docs/ — a manifest over nothing reconciles clean ' +
        'against a destination that received nothing',
    );
  }
  return relocatable;
}

function loadManifest(): ProseManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ProseManifest;
}

/**
 * Writes the manifest. New entries merge into the prior manifest, because a file
 * relocated in an earlier pass is no longer in the tree. A smaller manifest is
 * refused without `--allow-shrink`, because a run after the deletion produces an
 * empty record that reconciles clean. The date is an argument, so a regeneration
 * that changes nothing else produces no diff.
 */
function generate(capturedAt: string): void {
  const paths = relocatablePaths();
  const fresh = buildManifest(REPO_ROOT, paths, capturedAt);

  const prior: ProseManifest | undefined = existsSync(MANIFEST_PATH) ? loadManifest() : undefined;
  const byDestination = new Map((prior?.entries ?? []).map((e) => [e.destination, e]));
  for (const entry of fresh.entries) byDestination.set(entry.destination, entry);

  const entries = [...byDestination.values()].sort((a, b) => a.source.localeCompare(b.source));
  const manifest: ProseManifest = {
    ...fresh,
    subtrees: [...new Set(entries.map((e) => e.source.split('/').slice(0, 2).join('/')))].sort(),
    counts: { files: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0) },
    entries,
  };

  if (existsSync(MANIFEST_PATH)) {
    const prior = loadManifest();
    if (manifest.entries.length < prior.entries.length && !process.argv.includes('--allow-shrink')) {
      throw new Error(
        `refusing to shrink the manifest from ${prior.entries.length} to ${manifest.entries.length} ` +
          'entries. Regeneration enumerates TRACKED files, so running this after the deletion ' +
          'produces an empty record that reconciles clean against nothing. Generate before ' +
          'deleting, or pass --allow-shrink if the reduction is intended.',
      );
    }
  }

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(
    `[prose-exodus] manifest: ${manifest.counts.files} file(s), ` +
      `${manifest.counts.bytes} bytes, across ${manifest.subtrees.length} subtree(s)`,
  );
  for (const subtree of manifest.subtrees) console.log(`  ${subtree}`);
}

/**
 * Copies each manifest entry whose source still exists. An entry whose source an
 * earlier pass removed is skipped, and `reconcile` proves that it is at the
 * destination.
 */
function transfer(destinationRoot: string): void {
  const manifest = loadManifest();
  let copied = 0;
  let alreadyGone = 0;

  for (const entry of manifest.entries) {
    const source = path.join(REPO_ROOT, entry.source);
    if (!existsSync(source)) {
      alreadyGone += 1;
      continue;
    }
    const dest = path.join(destinationRoot, entry.destination);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    copied += 1;
  }

  console.log(
    `[prose-exodus] copied ${copied} file(s) to ${destinationRoot}` +
      (alreadyGone > 0 ? `; ${alreadyGone} already relocated in an earlier pass` : ''),
  );
}

function runReconcile(destinationRoot: string): void {
  const result = reconcile(loadManifest(), destinationRoot);
  console.log(`[prose-exodus] ${formatReconcile(result)}`);
  if (!result.ok) process.exit(1);
}

const [command, arg] = process.argv.slice(2);
switch (command) {
  case 'generate':
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
