/**
 * The repository root is an allow-list, not a habit (task 043, DR-1).
 *
 * DR-1's whole claim is that the top level is small and legible. Nothing
 * enforced that, so every wave of work could leave one more directory behind
 * and the only cost was that the root got a little harder to read. Two of those
 * leftovers were sitting here when this test was written — `caller-identity-test/`
 * and `src/__tests__/`, both EMPTY directory skeletons that git cannot track and
 * therefore no tracked-file census could ever see.
 *
 * The rule this test exists to state: an entry at the root is either declared
 * here with a reason, or it is a defect. Adding a directory is allowed; adding
 * one silently is not.
 *
 * ── Why this reads the FILESYSTEM and not `git ls-files` ────────────────────
 * A tracked-file census cannot see an empty directory, and empty directories are
 * the exact residue a structural refactor leaves. It also cannot see `dist/` or
 * `node_modules/`, which is what makes the third test necessary: a root contract
 * that only holds on a pristine clone is not an enforcement mechanism, it is a
 * trap that fires on every developer machine and every built tree.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Directories that carry the repository's structure. Six, as DR-1 states —
 * plus the two Phase 1 has not yet dissolved, each named with the task that
 * removes it so this list shrinks on a schedule rather than by attrition.
 */
const ALLOWED_DIRS: Record<string, string> = {
  src: 'The shipped product source.',
  content: 'Authored content: skills, commands and their references, by domain.',
  rendered: 'Generated per-runtime projections of content/. Never edited by hand.',
  tests: 'The single test tree (DR-5). Every tier lives here.',
  tools: 'Repo automation: gates, build/publish scripts, conformance suite, lint rules.',
  docs: 'Specs, guides, architecture notes and RCAs.',
  binding: 'Harness binding descriptors.',
  hooks: 'Plugin-root hooks/, required at this path by the plugin contract.',
  documentation:
    'The VitePress site. Task 039 reduces this to a skeleton under docs/; it is listed ' +
    'because it EXISTS today, not because it belongs here.',
};

/** Classified dot-directories. Tooling homes, not repository structure. */
const ALLOWED_DOT_DIRS: Record<string, string> = {
  '.github': 'Workflows, CODEOWNERS, issue templates.',
  '.claude': 'Claude Code harness config and worktrees.',
  '.claude-plugin': 'Plugin packaging manifest.',
  '.codex': 'Codex harness config.',
  '.cursor': 'Cursor harness config.',
  '.opencode': 'OpenCode harness config.',
  '.exarchos': 'Exarchos dev catalog: invariants, comment policy, topology.',
};

/**
 * Present on a working machine, absent from a fresh clone. Listing these is
 * what makes the contract enforceable rather than aspirational — revision 1 of
 * this task specified an assertion that omitted `dist/`, so it would have failed
 * for everyone who had ever run a build.
 */
const ALLOWED_UNTRACKED: Record<string, string> = {
  // A DIRECTORY in an ordinary clone and a FILE (`gitdir: …`) in a worktree,
  // which is where this suite usually runs — so it is declared here rather than
  // among the dot-directories, whose members must all exist as directories.
  '.git': 'The repository itself, or the worktree pointer to it.',
  'node_modules': 'Installed dependencies.',
  dist: 'Build output.',
  coverage: 'Coverage output.',
  '.worktrees': 'Legacy worktree root.',
  '.serena': 'Serena MCP project cache.',
  '.azurite': 'Azurite emulator state.',
  '.nyc_output': 'Legacy coverage output.',
  '.DS_Store': 'macOS directory metadata.',
};

const entries = fs.readdirSync(REPO_ROOT, { withFileTypes: true });
const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
const files = entries.filter((e) => e.isFile()).map((e) => e.name);

/**
 * Root FILES are governed by tracking rather than by an enumerated list: the
 * set turns over with ordinary work (a new config, a renamed doc), so pinning
 * it by name would make this test a chore rather than a contract. What must
 * never happen is an UNTRACKED file appearing at the root and being mistaken
 * for part of the repository.
 */
const trackedRootFiles = new Set(
  execFileSync('git', ['ls-files', '-z', '--', ':(top)*'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
    .split('\0')
    .filter((rel) => rel.length > 0 && !rel.includes('/')),
);

describe('top-level contract', () => {
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

    // The other direction, so the list cannot rot into cover for things that
    // are gone. `ALLOWED_UNTRACKED` is exempt: those are legitimately absent on
    // a clean clone, which is the whole point of the third test.
    const present = new Set(dirs);
    const phantomStructural = Object.keys(ALLOWED_DIRS).filter((d) => !present.has(d));
    expect(phantomStructural, 'declared structural directories that do not exist').toEqual([]);

    const phantomDot = Object.keys(ALLOWED_DOT_DIRS).filter((d) => !present.has(d));
    expect(phantomDot, 'declared dot-directories that do not exist').toEqual([]);
  });

  it('TopLevel_UnlistedEntryAppears_FailsWithItsName', () => {
    // The kill probe. An assertion that reports "the root is wrong" without
    // saying WHAT is wrong cannot be acted on, and the failure mode here is
    // specifically a directory nobody noticed — so the name is the finding.
    const declared = new Set([
      ...Object.keys(ALLOWED_DIRS),
      ...Object.keys(ALLOWED_DOT_DIRS),
      ...Object.keys(ALLOWED_UNTRACKED),
    ]);
    const seeded = [...dirs, 'a-directory-nobody-declared'];

    const undeclared = seeded.filter((d) => !declared.has(d));
    expect(undeclared).toEqual(['a-directory-nobody-declared']);
  });

  it('TopLevel_OnABuiltTree_StillPasses', () => {
    // A built, installed tree is the NORMAL state of this repository, so the
    // contract has to hold there. If `dist/` or `node_modules/` is present it
    // must already be declared — asserted only when present, so the test is
    // equally valid on a pristine clone.
    for (const name of ['dist', 'node_modules', 'coverage']) {
      if (!fs.existsSync(path.join(REPO_ROOT, name))) continue;
      expect(
        Object.keys(ALLOWED_UNTRACKED),
        `${name} is present on a built tree but undeclared`,
      ).toContain(name);
    }

    // And the converse: this suite is running from a checkout, so at least one
    // of them IS present. Without this the loop above passes vacuously on a
    // tree where none of them exists.
    const anyBuildArtifact = ['dist', 'node_modules', 'coverage'].some((n) =>
      fs.existsSync(path.join(REPO_ROOT, n)),
    );
    expect(anyBuildArtifact, 'no build artifact present — the built-tree arm checked nothing').toBe(true);
  });

  it('TopLevel_EveryRootFile_IsTrackedOrDeclared', () => {
    // The file half of the contract. Directories are enumerated because they
    // are structure; files turn over with ordinary work, so the rule is that
    // they must be TRACKED — an untracked file at the root is either a stray
    // artifact or something someone forgot to commit, and both are worth a red
    // test rather than a quiet accumulation.
    const stray = files
      .filter((f) => !trackedRootFiles.has(f) && ALLOWED_UNTRACKED[f] === undefined)
      .sort();

    expect(stray, 'untracked files at the repository root').toEqual([]);

    // Denominator: the filter above is meaningless if git reported nothing.
    expect(trackedRootFiles.size).toBeGreaterThan(10);
  });

  it('TopLevel_EveryAllowedEntry_CarriesAReason', () => {
    // An allow-list whose entries carry no justification becomes a list of
    // things someone once saw, which is how it stops being reviewable.
    for (const table of [ALLOWED_DIRS, ALLOWED_DOT_DIRS, ALLOWED_UNTRACKED]) {
      for (const [name, reason] of Object.entries(table)) {
        expect(reason.length, `${name} has no stated reason`).toBeGreaterThan(10);
      }
    }
  });

  it('TopLevel_HoldsNoEmptyDirectory', () => {
    // The residue class this test was written for. An empty directory is
    // invisible to git and to every tracked-file census, so it survives every
    // move task and accumulates. `rendered/agents/` legitimately carries only a
    // `.gitkeep`, so "holds no FILES" is checked recursively rather than by
    // reading one level.
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
