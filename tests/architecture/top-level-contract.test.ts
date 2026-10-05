/**
 * The repository root is an allow-list. An entry at the root is either declared here with a
 * reason, or it is a defect.
 *
 * The directory checks read the filesystem, not `git ls-files`. A tracked-file census cannot see an
 * empty directory, which is the usual residue of a structural refactor. It also cannot see
 * `dist/` or `node_modules/`, and the contract must hold on a built tree and on a fresh clone.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * The directories that carry the structure of the repository. The first six are that
 * structure. `binding` and `hooks` are here because a consumer outside this repository
 * requires each path.
 */
const ALLOWED_DIRS: Record<string, string> = {
  src: 'The shipped product source.',
  content: 'Authored content: skills, commands and their references, by domain.',
  rendered: 'Generated per-runtime projections of content/. Never edited by hand.',
  tests: 'The single test tree (DR-5). Every tier lives here.',
  tools: 'Repo automation: gates, build/publish scripts, conformance suite, lint rules.',
  docs: 'The two documents that describe the system, the mount point for the relocated ones, and the published site skeleton.',
  binding: 'Harness binding descriptors.',
  hooks: 'Plugin-root hooks/, required at this path by the plugin contract.',
};

/** Classified dot-directories. Tooling homes, not repository structure. */
const ALLOWED_DOT_DIRS: Record<string, string> = {
  '.github': 'Workflows, CODEOWNERS, issue templates.',
  '.agents': 'Skills vendored for every agent that works on this repository. Codex reads `.agents/skills`.',
  '.claude': 'Claude Code harness config and worktrees.',
  '.claude-plugin': 'Plugin packaging manifest.',
  '.codex': 'Codex harness config.',
  '.cursor': 'Cursor harness config.',
  '.opencode': 'OpenCode harness config.',
  '.exarchos': 'Exarchos dev catalog: invariants, comment policy, topology.',
};

/**
 * The entries that exist on a working machine and are absent from a fresh clone. Without
 * this list, the contract fails on each machine that has a build, because `dist/` exists.
 */
const ALLOWED_UNTRACKED: Record<string, string> = {
  /**
   * `.git` is a directory in an ordinary clone and a file (`gitdir: …`) in a worktree. Thus
   * it is in this table and not in `ALLOWED_DOT_DIRS`, whose members must all be directories.
   */
  '.git': 'The repository itself, or the worktree pointer to it.',
  'node_modules': 'Installed dependencies.',
  dist: 'Build output.',
  coverage: 'Coverage output.',
  '.worktrees': 'Legacy worktree root.',
  '.serena': 'Serena MCP project cache.',
  '.lavish': 'Lavish Editor review sessions and their artifacts. Tool-created and gitignored, so it exists only on a machine that has run the tool.',
  '.vscode': 'Editor workspace settings. Untracked, so it appears on some machines and not others.',
  '.azurite': 'Azurite emulator state.',
  '.nyc_output': 'Legacy coverage output.',
  '.DS_Store': 'macOS directory metadata.',
};

const entries = fs.readdirSync(REPO_ROOT, { withFileTypes: true });
const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
const files = entries.filter((e) => e.isFile()).map((e) => e.name);

/**
 * The root files that git tracks. No table names the root files, because the set changes
 * with ordinary work. The rule is that each root file is tracked or declared.
 */
const trackedRootFiles = new Set(
  (
    await execFileAsync('git', ['ls-files', '-z', '--', ':(top)*'], {
      cwd: REPO_ROOT,
    })
  )
    .split('\0')
    .filter((rel) => rel.length > 0 && !rel.includes('/')),
);

describe('top-level contract', () => {
  /**
   * Both directions: no undeclared directory, and no declared directory that does not exist.
   * `ALLOWED_UNTRACKED` is exempt from the second check, because a fresh clone lacks those
   * entries.
   */
  it('TopLevel_ContainsExactlyTheAllowedEntries', () => {
    const declared = new Set([
      ...Object.keys(ALLOWED_DIRS),
      ...Object.keys(ALLOWED_DOT_DIRS),
      ...Object.keys(ALLOWED_UNTRACKED),
    ]);

    const undeclared = dirs.filter((d) => !declared.has(d)).sort();
    expect(
      undeclared,
      'undeclared top-level directories — add them to ALLOWED_DIRS with a reason, or remove them',
    ).toEqual([]);

    const present = new Set(dirs);
    const phantomStructural = Object.keys(ALLOWED_DIRS).filter((d) => !present.has(d));
    expect(phantomStructural, 'declared structural directories that do not exist').toEqual([]);

    const phantomDot = Object.keys(ALLOWED_DOT_DIRS).filter((d) => !present.has(d));
    expect(phantomDot, 'declared dot-directories that do not exist').toEqual([]);
  });

  /**
   * The kill probe: a seeded directory must appear by name, because the name is the finding.
   * The test repeats the filter of the check inline.
   */
  it('TopLevel_UnlistedEntryAppears_FailsWithItsName', () => {
    const declared = new Set([
      ...Object.keys(ALLOWED_DIRS),
      ...Object.keys(ALLOWED_DOT_DIRS),
      ...Object.keys(ALLOWED_UNTRACKED),
    ]);
    const seeded = [...dirs, 'a-directory-nobody-declared'];

    const undeclared = seeded.filter((d) => !declared.has(d));
    expect(undeclared).toEqual(['a-directory-nobody-declared']);
  });

  /**
   * A built, installed tree is the normal state of this repository. Each build artifact that
   * is present must be in `ALLOWED_UNTRACKED`. At least one must be present, or the loop
   * checks nothing.
   */
  it('TopLevel_OnABuiltTree_StillPasses', () => {
    for (const name of ['dist', 'node_modules', 'coverage']) {
      if (!fs.existsSync(path.join(REPO_ROOT, name))) continue;
      expect(
        Object.keys(ALLOWED_UNTRACKED),
        `${name} is present on a built tree but undeclared`,
      ).toContain(name);
    }

    const anyBuildArtifact = ['dist', 'node_modules', 'coverage'].some((n) =>
      fs.existsSync(path.join(REPO_ROOT, n)),
    );
    expect(anyBuildArtifact, 'no build artifact present — the built-tree arm checked nothing').toBe(true);
  });

  /**
   * An untracked file at the root is a stray artifact or a file that nobody committed. The
   * last assertion is the denominator: the filter means nothing when git reports no file.
   */
  it('TopLevel_EveryRootFile_IsTrackedOrDeclared', () => {
    const stray = files
      .filter((f) => !trackedRootFiles.has(f) && ALLOWED_UNTRACKED[f] === undefined)
      .sort();

    expect(stray, 'untracked files at the repository root').toEqual([]);

    expect(trackedRootFiles.size).toBeGreaterThan(10);
  });

  /** A reviewer cannot judge an allow-list entry that has no reason. */
  it('TopLevel_EveryAllowedEntry_CarriesAReason', () => {
    for (const table of [ALLOWED_DIRS, ALLOWED_DOT_DIRS, ALLOWED_UNTRACKED]) {
      for (const [name, reason] of Object.entries(table)) {
        expect(reason.length, `${name} has no stated reason`).toBeGreaterThan(10);
      }
    }
  });

  /**
   * git and each tracked-file census cannot see an empty directory, so it stays after a move.
   * The walk counts files recursively, so a directory that holds only empty directories is
   * also empty.
   */
  it('TopLevel_HoldsNoEmptyDirectory', () => {
    const structural = Object.keys(ALLOWED_DIRS).filter((d) =>
      fs.existsSync(path.join(REPO_ROOT, d)),
    );

    const empties: string[] = [];
    const walk = (rel: string): number => {
      let count = 0;
      for (const e of fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
        if (e.isDirectory()) count += walk(path.join(rel, e.name));
        else count += 1;
      }
      if (count === 0) empties.push(rel);
      return count;
    };
    for (const d of structural) walk(d);

    expect(empties.sort(), 'empty directories — residue no tracked-file census can see').toEqual([]);
  });
});
