import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * P04-05 — VCS-mutation ownership census (structural conformance).
 *
 * The unified remediation plan (PROGRAM-04) requires that git/worktree mutation
 * route through one typed owner and that **architecture checks reject direct
 * bypasses**. This module is that check: a string-aware static scan of the
 * shipped source that enumerates every *direct git worktree/branch mutation
 * site* and fails closed when one appears OUTSIDE the declared VCS-owner surface
 * ({@link VCS_MUTATION_OWNERS}).
 *
 * It follows the established `orchestrate/gate-ownership-census.ts` /
 * `architecture/effect-ledger.ts` pattern — a comment-aware source scan yielding
 * a typed verdict over the *real* tree, so a regression (a new module that shells
 * `git worktree add` / `git worktree remove` / `git branch -D` directly instead
 * of going through the owner) trips it, rather than a hand-maintained mirror.
 * Like the effect ledger it is a two-way ratchet:
 *
 *   - DIRECT_VCS_BYPASS — a mutation site in a module no owner rule claims;
 *   - STALE_VCS_OWNER   — a declared owner that no longer contains a live
 *                         mutation site (phantom cover), so the allowlist can
 *                         never rot into a rubber stamp.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * The detector targets the three git argument-vector mutation primitives that
 * are unambiguously identifiable from source text with ZERO false positives on
 * the live tree — `worktree add`, `worktree remove`, and `branch -d`/`-D`. These
 * are exactly the "duplicate worktrees / branches" and repair surfaces the exit
 * proof is about. Broader mutations whose git tokens are too ambiguous for a
 * false-positive-free static scan (`branch <create>`, `merge`, `commit`, `push`)
 * are enforced BEHAVIOURALLY by `vcs/mutation-owner.ts`'s idempotency + fencing,
 * not by this scan — a deliberate, documented scoping choice.
 */

/** A single detected git worktree/branch mutation site in shipped source. */
export interface VcsMutationSite {
  /** Repo-relative to the scan root, forward-slashed. */
  readonly module: string;
  /** Which mutation primitive was detected. */
  readonly mutation: 'worktree.add' | 'worktree.remove' | 'branch.delete';
  /** The source token evidencing the mutation. */
  readonly evidence: string;
}

export type VcsOwnershipDiagnostic =
  | {
      readonly code: 'DIRECT_VCS_BYPASS';
      readonly module: string;
      readonly mutation: VcsMutationSite['mutation'];
      readonly evidence: string;
      readonly message: string;
    }
  | {
      readonly code: 'STALE_VCS_OWNER';
      readonly module: string;
      readonly message: string;
    };

export interface VcsOwnershipResult {
  readonly ok: boolean;
  readonly siteCount: number;
  readonly diagnostics: readonly VcsOwnershipDiagnostic[];
}

/**
 * The declared VCS-owner surface — the modules permitted to perform git
 * worktree/branch mutation directly. `vcs/mutation-owner.ts` is the canonical
 * owner (P04-05); the remaining entries are the pre-existing legitimate mutation
 * owners the remediation inherits and must not silently break:
 *
 *   - `vcs/mutation-owner.ts`       — the single typed VCS mutation owner: the
 *                                     canonical home of `worktree add/remove` and
 *                                     `branch -D` argument vectors, wrapping them
 *                                     in idempotency + fencing + compensation.
 *   - `launcher/create-worktree.ts` — harness-launcher worktree create (DR-2).
 *   - `workflow/compensation.ts`    — the saga compensation teardown (P04-02).
 *
 * The formerly-listed `orchestrate/setup-worktree.ts`, `orchestrate/worktree/
 * manager.ts`, and `orchestrate/local-git-merge.ts` NO LONGER appear here: their
 * git worktree/branch mutation now routes through `vcs/mutation-owner.ts` (either
 * the full `VcsMutationOwner` via the worktree provisioner, or its shared
 * mutation primitives `removeWorktreeForce`/`deleteBranchForce`), so they contain
 * no direct mutation token and the STALE_VCS_OWNER ratchet would (correctly) trip
 * were they still declared. That shrink is the real proof the exit criterion's
 * second half ("duplicate requests cannot create duplicate worktrees/branches")
 * is now enforced in the shipped call path, not just demonstrable in isolation.
 *
 * Adding a NEW module that mutates worktrees/branches fails the census until it
 * is consciously declared here (or, better, routed through the owner).
 */
export const VCS_MUTATION_OWNERS: readonly string[] = Object.freeze([
  'launcher/create-worktree.ts',
  'vcs/mutation-owner.ts',
  'workflow/compensation.ts',
]);

// ─── Detection ──────────────────────────────────────────────────────────────

/** Directories that are not shipped source (test/bench/eval harnesses). */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '__tests__',
  '__fixtures__',
  '__mocks__',
  'test-helpers',
  'bench',
  'benchmarks',
  'evals',
]);

/** True for a shipped-source TypeScript module (not a test/decl/bench file). */
export function isScannableFile(name: string): boolean {
  return (
    name.endsWith('.ts') &&
    !name.endsWith('.test.ts') &&
    !name.endsWith('.d.ts') &&
    !name.endsWith('.bench.ts')
  );
}

/**
 * Strip `//` and block comments while PRESERVING string/template-literal
 * content. The mutation tokens are themselves string literals (`'worktree'`,
 * `'add'`, …), so — unlike `delivery-safety.maskLiteralsAndComments`, which
 * masks string bodies too — this keeps literals visible and only removes
 * comment prose (so a `git worktree add` mentioned in a JSDoc line is not
 * mistaken for a call).
 */
export function stripComments(source: string): string {
  let out = '';
  const n = source.length;
  let i = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;

  while (i < n) {
    const ch = source[i] ?? '';
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') {
        lineComment = false;
        out += ch;
      }
      i += 1;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 2;
        continue;
      }
      if (ch === '\n') out += ch;
      i += 1;
      continue;
    }
    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < n) out += source[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// A git argument vector `['worktree', 'add', …]` — the two subcommand tokens are
// adjacent string literals separated by a comma. The quote style is captured and
// back-referenced so `'worktree'` and `"worktree"` both match but a mismatched
// pair does not.
const WORKTREE_ADD_RE = /(['"`])worktree\1\s*,\s*(['"`])add\2/;
const WORKTREE_REMOVE_RE = /(['"`])worktree\1\s*,\s*(['"`])remove\2/;
// `['branch', '-d'|'-D']` — branch deletion. (Branch *creation*, `['branch',
// <name>]`, is intentionally out of scope: the bare `branch` token followed by
// an identifier is not statically separable from unrelated string arrays.)
const BRANCH_DELETE_RE = /(['"`])branch\1\s*,\s*(['"`])-[dD]\2/;

/**
 * Enumerate the git worktree/branch mutation sites in one module's source. Pure;
 * comment-stripped so doc examples do not count. At most one occurrence per
 * (module, mutation-kind) — ownership is per module.
 */
export function detectVcsMutationSites(module: string, source: string): VcsMutationSite[] {
  const stripped = stripComments(source);
  const sites: VcsMutationSite[] = [];
  if (WORKTREE_ADD_RE.test(stripped)) {
    sites.push({ module, mutation: 'worktree.add', evidence: 'git worktree add' });
  }
  if (WORKTREE_REMOVE_RE.test(stripped)) {
    sites.push({ module, mutation: 'worktree.remove', evidence: 'git worktree remove' });
  }
  if (BRANCH_DELETE_RE.test(stripped)) {
    sites.push({ module, mutation: 'branch.delete', evidence: 'git branch -d/-D' });
  }
  return sites;
}

async function collectScannableFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && isScannableFile(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
  };
  await walk(root);
  return files.sort();
}

/** Scan the shipped source under `sourceRoot` and enumerate every mutation site. */
export async function scanVcsMutationSites(
  sourceRoot: string,
): Promise<readonly VcsMutationSite[]> {
  const files = await collectScannableFiles(sourceRoot);
  const perFile = await Promise.all(
    files.map(async (file) => {
      const module = relative(sourceRoot, file).replaceAll('\\', '/');
      return detectVcsMutationSites(module, await readFile(file, 'utf8'));
    }),
  );
  return Object.freeze(
    perFile.flat().sort((a, b) =>
      a.module === b.module
        ? a.mutation < b.mutation
          ? -1
          : 1
        : a.module < b.module
          ? -1
          : 1,
    ),
  );
}

// ─── Census ─────────────────────────────────────────────────────────────────

/**
 * Pure ownership verdict over an already-collected site set and owner allowlist.
 * Two independent, complementary checks, each with its own diagnostic:
 *   - DIRECT_VCS_BYPASS — a site no owner claims;
 *   - STALE_VCS_OWNER   — an owner that claims no site (phantom cover).
 */
export function runVcsOwnershipCensus(
  sites: readonly VcsMutationSite[],
  owners: readonly string[] = VCS_MUTATION_OWNERS,
): VcsOwnershipResult {
  const ownerSet = new Set(owners);
  const diagnostics: VcsOwnershipDiagnostic[] = [];

  for (const site of sites) {
    if (!ownerSet.has(site.module)) {
      diagnostics.push({
        code: 'DIRECT_VCS_BYPASS',
        module: site.module,
        mutation: site.mutation,
        evidence: site.evidence,
        message:
          `Module "${site.module}" performs a direct git ${site.mutation} ` +
          `(via ${site.evidence}) outside the VCS-owner surface. Route git/worktree ` +
          `mutation through the typed owner (vcs/mutation-owner.ts) or declare the ` +
          `module in VCS_MUTATION_OWNERS.`,
      });
    }
  }

  for (const owner of owners) {
    const claimsSomething = sites.some((site) => site.module === owner);
    if (!claimsSomething) {
      diagnostics.push({
        code: 'STALE_VCS_OWNER',
        module: owner,
        message:
          `VCS-owner rule for "${owner}" claims no live mutation site — stale cover. ` +
          `Remove it from VCS_MUTATION_OWNERS or restore the mutation.`,
      });
    }
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    siteCount: sites.length,
    diagnostics,
  });
}

/** Collect the live mutation sites and return the census verdict over the real tree. */
export async function auditVcsOwnership(
  sourceRoot: string,
  owners: readonly string[] = VCS_MUTATION_OWNERS,
): Promise<VcsOwnershipResult> {
  const sites = await scanVcsMutationSites(sourceRoot);
  return runVcsOwnershipCensus(sites, owners);
}
