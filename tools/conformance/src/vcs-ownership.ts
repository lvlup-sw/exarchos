/**
 * The VCS-mutation ownership census. Git worktree, branch and merge mutation must go through one
 * typed owner. This module scans the shipped source for direct mutation sites and fails closed on a
 * site outside {@link VCS_MUTATION_OWNERS}. It is a two-way ratchet:
 *
 * - `DIRECT_VCS_BYPASS`: a mutation site in a module that no owner rule claims.
 * - `STALE_VCS_OWNER`: a declared owner with no live mutation site.
 *
 * The census governs {@link GOVERNED_SOURCE_ROOT}, not the whole repository.
 * `vcs-ownership.test.ts` scans the other first-party trees for the same primitives. The detected
 * primitives are `worktree add`, `worktree remove`, `branch -d`/`-D`, `merge` and branch creation.
 * `commit` and `push` are out of scope for this scan.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** A single detected git worktree/branch mutation site in shipped source. */
export interface VcsMutationSite {
  /** Repo-relative to the scan root, forward-slashed. */
  readonly module: string;
  /** Which mutation primitive was detected. */
  readonly mutation:
    | 'worktree.add'
    | 'worktree.remove'
    | 'branch.delete'
    | 'branch.create'
    | 'merge';
  /** The source token evidencing the mutation. */
  readonly evidence: string;
}

/** A completed walk: the sites it found, and the population it found them in. */
export interface VcsMutationScan {
  readonly sites: readonly VcsMutationSite[];
  /** Modules the walk visited — the denominator the site list is read against. */
  readonly moduleCount: number;
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
    }
  | {
      readonly code: 'EMPTY_MODULE_POPULATION';
      readonly moduleCount: number;
      readonly message: string;
    };

export interface VcsOwnershipResult {
  readonly ok: boolean;
  readonly siteCount: number;
  /**
   * How many modules the walk visited, so a reader can tell "no bypass exists" from "nothing was
   * examined". `undefined` for a verdict over a caller-supplied site list.
   */
  readonly moduleCount?: number;
  readonly diagnostics: readonly VcsOwnershipDiagnostic[];
}

/**
 * The modules that can mutate git worktrees, branches and merges directly. `vcs/mutation-owner.ts`
 * is the canonical owner, with idempotency, fencing and compensation. The launcher worktree create
 * and the saga compensation teardown are older owners.
 *
 * `verbs/merge/local-git-merge.ts` owns the `git merge` argv and the `checkout -b` of the rebase
 * strategy. Its merge has no ledger fence, because the merge serializer suppresses duplicates.
 * `verbs/pure/execute-merge.ts` runs `git merge --abort`, which reverses a merge, so it cannot use
 * the create-shaped idempotency of the owner. A new mutating module fails the census until it is
 * declared here or routed through the owner.
 */
export const VCS_MUTATION_OWNERS: readonly string[] = Object.freeze([
  'runtime/launcher/create-worktree.ts',
  'verbs/merge/local-git-merge.ts',
  'verbs/pure/execute-merge.ts',
  'vcs/mutation-owner.ts',
  'workflow/compensation.ts',
]);

/**
 * The tree that this census governs, repo-relative. The entries of {@link VCS_MUTATION_OWNERS} are
 * relative to it, so a change of root strands every owner rule.
 */
export const GOVERNED_SOURCE_ROOT = 'src';

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
 * One module's source with comments removed and literals kept. `LexedModule.maskedSource` does not
 * give this form. The lexer is a caller-supplied port, so the TypeScript compiler decides the
 * grammar. The implementation is `test-helpers/module-lexer.ts`.
 */
export interface LexedComments {
  /**
   * `source` with every comment blanked to spaces, with newlines and offsets kept. String, template
   * and regex literals stay verbatim, because the matched tokens are string literals. Comments go,
   * so a `git worktree add` in a JSDoc line does not count as a call.
   */
  readonly commentMaskedSource: string;
}

/**
 * The lexer port. It is required wherever it appears, as `ModuleLexer` is in `effect-ledger.ts`.
 * With an optional lexer, a caller can silently get the answers of the retired heuristic.
 */
export type CommentLexer = (source: string, fileName?: string) => LexedComments;

/**
 * The comment-stripped source that `lex` resolved. This is an accessor, not a lexer: it holds no
 * knowledge of TypeScript grammar. The tests bind to this name.
 *
 * The retired hand-written walk scored the head of a real regex literal as division. A backtick in
 * the regex then opened a phantom template that ran to EOF, so comment prose survived the strip.
 * `test-helpers/superseded-site-lexers.ts` keeps that walk, and the kill fixture asserts both
 * answers.
 */
export function stripComments(source: string, lex: CommentLexer): string {
  return lex(source).commentMaskedSource;
}

/**
 * A git argv `['worktree', 'add', …]`: two adjacent string literals with a comma between them. The
 * back-reference on the quote style rejects a mismatched pair.
 */
const WORKTREE_ADD_RE = /(['"`])worktree\1\s*,\s*(['"`])add\2/;
const WORKTREE_REMOVE_RE = /(['"`])worktree\1\s*,\s*(['"`])remove\2/;
/** `['branch', '-d']` or `['branch', '-D']`: branch deletion. */
const BRANCH_DELETE_RE = /(['"`])branch\1\s*,\s*(['"`])-[dD]\2/;

/**
 * `['merge', <option|ref>]`. The bare tokens `'merge'` and `'branch'` also occur in enum members,
 * union members, `case` labels and data arrays, so the rule matches argv shape. The subcommand must
 * be the first element of an array literal. The next element must be a quoted option or a bare
 * identifier, because a quoted non-option string marks a data array. Every `git merge` mutates,
 * `merge --abort` included.
 */
const MERGE_RE = /\[\s*(['"`])merge\1\s*,\s*(?:(['"`])--?[A-Za-z][-A-Za-z0-9]*\2|[A-Za-z_$])/;
/**
 * `['branch', <identifier>]`: `git branch <name>` creates a branch. A quoted operand is an option
 * (`'-D'` deletes, `'--show-current'` reads) or a data-array neighbor.
 */
const BRANCH_CREATE_RE = /\[\s*(['"`])branch\1\s*,\s*[A-Za-z_$]/;
/**
 * `['checkout', '-b']` and `['switch', '-c']`, in either case: the other two branch-creation
 * vectors. A checkout without the create flag switches or restores, so it does not count.
 */
const CHECKOUT_CREATE_RE = /\[\s*(['"`])checkout\1\s*,\s*(['"`])-[bB]\2/;
const SWITCH_CREATE_RE = /\[\s*(['"`])switch\1\s*,\s*(['"`])-[cC]\2/;

/**
 * Enumerates the git worktree, branch and merge mutation sites in one module's source. Comments are
 * stripped first, so doc examples do not count. Each mutation kind occurs at most once per module,
 * because ownership is per module.
 */
export function detectVcsMutationSites(
  module: string,
  source: string,
  lex: CommentLexer,
): VcsMutationSite[] {
  const stripped = stripComments(source, lex);
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
  if (MERGE_RE.test(stripped)) {
    sites.push({ module, mutation: 'merge', evidence: 'git merge' });
  }
  if (
    BRANCH_CREATE_RE.test(stripped) ||
    CHECKOUT_CREATE_RE.test(stripped) ||
    SWITCH_CREATE_RE.test(stripped)
  ) {
    sites.push({
      module,
      mutation: 'branch.create',
      evidence: 'git branch <name> / checkout -b / switch -c',
    });
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

/**
 * Scans the shipped source under `sourceRoot` and returns each mutation site with the count of
 * visited modules. Only this walk sees the population. Downstream, an empty site list looks the
 * same as a walk that reached nothing.
 */
export async function scanVcsTree(
  sourceRoot: string,
  lex: CommentLexer,
): Promise<VcsMutationScan> {
  const files = await collectScannableFiles(sourceRoot);
  const perFile = await Promise.all(
    files.map(async (file) => {
      const module = relative(sourceRoot, file).replaceAll('\\', '/');
      return detectVcsMutationSites(module, await readFile(file, 'utf8'), lex);
    }),
  );
  return Object.freeze({
    sites: Object.freeze(
      perFile.flat().sort((a, b) =>
        a.module === b.module
          ? a.mutation < b.mutation
            ? -1
            : 1
          : a.module < b.module
            ? -1
            : 1,
      ),
    ),
    moduleCount: files.length,
  });
}

/** Scan the shipped source under `sourceRoot` and enumerate every mutation site. */
export async function scanVcsMutationSites(
  sourceRoot: string,
  lex: CommentLexer,
): Promise<readonly VcsMutationSite[]> {
  return (await scanVcsTree(sourceRoot, lex)).sites;
}

/**
 * The ownership verdict over a collected site set and an owner allowlist. `DIRECT_VCS_BYPASS`
 * reports a site that no owner claims. `STALE_VCS_OWNER` reports an owner that claims no site.
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

/**
 * Collects the live mutation sites and returns the census verdict with the module count of the
 * walk. A walk that visits no module gives `EMPTY_MODULE_POPULATION`, because its verdict otherwise
 * looks the same as a clean tree.
 */
export async function auditVcsOwnership(
  sourceRoot: string,
  lex: CommentLexer,
  owners: readonly string[] = VCS_MUTATION_OWNERS,
): Promise<VcsOwnershipResult> {
  const scan = await scanVcsTree(sourceRoot, lex);
  const verdict = runVcsOwnershipCensus(scan.sites, owners);
  if (scan.moduleCount > 0) {
    return Object.freeze({ ...verdict, moduleCount: scan.moduleCount });
  }
  return Object.freeze({
    ok: false,
    siteCount: verdict.siteCount,
    moduleCount: 0,
    diagnostics: Object.freeze([
      {
        code: 'EMPTY_MODULE_POPULATION',
        moduleCount: 0,
        message:
          `The VCS-ownership walk visited ZERO modules under "${sourceRoot}". A census ` +
          'over an empty population reports no bypass for the same reason a clean tree ' +
          'does, so this fails closed. The scan root moved, an exclusion widened, or the ' +
          `tree is not where ${GOVERNED_SOURCE_ROOT} says it is.`,
      } as const,
      ...verdict.diagnostics,
    ]),
  });
}
