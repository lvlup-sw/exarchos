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
 * It follows the established `verbs/gates/gate-ownership-census.ts` /
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
 * ── Scope (DR-12) ───────────────────────────────────────────────────────────
 * The detector targets the git argument-vector mutation primitives that are
 * identifiable from source text with ZERO false positives on the live tree:
 * `worktree add`, `worktree remove`, `branch -d`/`-D`, **`merge`**, and
 * **branch creation** (`branch <name>`, `checkout -b/-B`, `switch -c/-C`).
 *
 * `merge` and `branch <create>` were previously scoped OUT on the grounds that
 * their git tokens are "too ambiguous for a false-positive-free static scan".
 * That scope-out is RETRACTED: it made `verbs/merge/local-git-merge.ts` — the
 * production module that actually runs `git merge` — invisible to the census
 * that claims to own VCS mutation. The ambiguity was real but is resolved by a
 * *shape* discriminator rather than a bare token match; see
 * {@link detectVcsMutationSites} for the rule and its false-positive analysis.
 *
 * Still out of scope, and still enforced BEHAVIOURALLY by
 * `vcs/mutation-owner.ts`'s idempotency + fencing rather than by this scan:
 * `commit` and `push`. Those remain a documented scoping choice, not an
 * oversight — narrowing the retraction to what DR-12 actually requires.
 */

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
 * worktree/branch/merge mutation directly. `vcs/mutation-owner.ts` is the
 * canonical owner (P04-05); the remaining entries are the pre-existing
 * legitimate mutation owners the remediation inherits and must not silently
 * break:
 *
 *   - `vcs/mutation-owner.ts`       — the single typed VCS mutation owner: the
 *                                     canonical home of `worktree add/remove`,
 *                                     `branch <name>` and `branch -D` argument
 *                                     vectors, wrapping them in idempotency +
 *                                     fencing + compensation.
 *   - `launcher/create-worktree.ts` — harness-launcher worktree create (DR-2).
 *   - `workflow/compensation.ts`    — the saga compensation teardown (P04-02).
 *
 * DR-12 additions — the two modules the pre-widening scan could not see. Both
 * are declared rather than rewritten: routing them through `VcsMutationOwner`
 * would change merge *semantics* (see the tension noted on each), which is a
 * behavioural change DR-12 does not ask for. Declaring them makes the census
 * honest TODAY and puts them under the STALE_VCS_OWNER half of the ratchet, so
 * a later refactor that does route them through the owner is forced to update
 * this list rather than leaving phantom cover behind:
 *
 *   - `verbs/merge/local-git-merge.ts`  — the production `vcsMerge` adapter
 *                                         (#1194, DR-MO-2). Owns the `git merge
 *                                         --no-ff/--squash/--ff-only` argv and
 *                                         the ephemeral `checkout -b` used by
 *                                         the rebase strategy. It ALREADY defers
 *                                         its forced branch delete to
 *                                         `vcs/mutation-owner.ts`
 *                                         (`deleteBranchForce`); the merge argv
 *                                         itself is the primitive this module
 *                                         exists to be. TENSION: its merge is
 *                                         not ledger-fenced the way worktree
 *                                         mutation is — duplicate-merge
 *                                         suppression lives one layer up in the
 *                                         merge serializer, not here.
 *   - `verbs/pure/execute-merge.ts` — the INV-14 recovery ladder's
 *                                         `git merge --abort`, the operation's
 *                                         own native recovery primitive. It
 *                                         reverses a merge rather than creating
 *                                         one, so it cannot route through the
 *                                         owner's create-shaped idempotency
 *                                         without inverting its meaning.
 *
 * The formerly-listed `verbs/team/setup-worktree.ts` and `verbs/worktree/
 * manager.ts` do NOT appear here: their git worktree/branch mutation now routes
 * through `vcs/mutation-owner.ts` (either the full `VcsMutationOwner` via the
 * worktree provisioner, or its shared mutation primitives
 * `removeWorktreeForce`/`deleteBranchForce`), so they contain no direct mutation
 * token and the STALE_VCS_OWNER ratchet would (correctly) trip were they still
 * declared. That shrink is the real proof the exit criterion's second half
 * ("duplicate requests cannot create duplicate worktrees/branches") is now
 * enforced in the shipped call path, not just demonstrable in isolation.
 *
 * Adding a NEW module that mutates worktrees/branches/merges fails the census
 * until it is consciously declared here (or, better, routed through the owner).
 */
export const VCS_MUTATION_OWNERS: readonly string[] = Object.freeze([
  'launcher/create-worktree.ts',
  'verbs/merge/local-git-merge.ts',
  'verbs/pure/execute-merge.ts',
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
 *
 * Two lexer details matter for false-positive freedom, both learned the hard
 * way while widening the detector (DR-12):
 *
 *   - REGEX LITERALS. A regex such as `/(['"`])merge\1/` contains quote
 *     characters that are NOT string delimiters. Without regex awareness the
 *     scanner enters a phantom string at the `'`, and every `//` for the rest of
 *     the file is then treated as string content rather than a comment — so
 *     comment prose leaks into the scan and matches as if it were code. The
 *     `/`-in-operand-position heuristic below is deliberately CONSERVATIVE: when
 *     in doubt it treats `/` as division, which merely falls back to the old
 *     behaviour instead of swallowing real code (a false negative in a ratchet
 *     is the dangerous direction, so the ambiguity is resolved away from it).
 *   - LINE-BOUNDED QUOTES. `'`/`"` strings cannot span a raw newline in JS.
 *     Terminating them at end-of-line caps any residual desync at one line
 *     instead of letting it run to EOF. Template literals (backtick) may span
 *     lines and are exempt.
 */
export function stripComments(source: string): string {
  let out = '';
  const n = source.length;
  let i = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  let regex = false;
  let regexClass = false;
  // Last non-whitespace character emitted as CODE — decides whether a `/` opens
  // a regex literal (operand position) or is a division operator.
  let lastSignificant = '';

  const startsRegex = (): boolean =>
    lastSignificant === '' || !/[A-Za-z0-9_$)\]]/.test(lastSignificant);

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
    if (regex) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < n) out += source[i + 1] ?? '';
        i += 2;
        continue;
      }
      // A raw newline cannot appear in a regex literal — bail out rather than
      // run away, so a misjudged `/` costs at most one line.
      if (ch === '\n') regex = false;
      else if (ch === '[') regexClass = true;
      else if (ch === ']') regexClass = false;
      else if (ch === '/' && !regexClass) regex = false;
      i += 1;
      continue;
    }
    if (quote !== null) {
      // `'`/`"` are line-bounded in JS; a newline means the lexer desynced, so
      // resynchronise instead of consuming the rest of the file as string body.
      if (ch === '\n' && quote !== '`') {
        quote = null;
        out += ch;
        i += 1;
        continue;
      }
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
    if (ch === '/' && startsRegex()) {
      regex = true;
      regexClass = false;
      out += ch;
      lastSignificant = ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      lastSignificant = ch;
      i += 1;
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }
  return out;
}

// ── Detection rules ─────────────────────────────────────────────────────────
//
// A git argument vector `['worktree', 'add', …]` — the two subcommand tokens are
// adjacent string literals separated by a comma. The quote style is captured and
// back-referenced so `'worktree'` and `"worktree"` both match but a mismatched
// pair does not.
const WORKTREE_ADD_RE = /(['"`])worktree\1\s*,\s*(['"`])add\2/;
const WORKTREE_REMOVE_RE = /(['"`])worktree\1\s*,\s*(['"`])remove\2/;
// `['branch', '-d'|'-D']` — branch deletion.
const BRANCH_DELETE_RE = /(['"`])branch\1\s*,\s*(['"`])-[dD]\2/;

// ── DR-12 widening: `merge` and branch *creation* ───────────────────────────
//
// The bare tokens `'merge'` and `'branch'` are NOT separable from unrelated
// string literals by adjacency alone: `'merge'` ships in the live tree as a Zod
// enum member (`z.enum(['squash', 'rebase', 'merge'])`), a liveness-surface name
// (`LivenessSurface = 'merge' | …`), a `switch` case label, an SDLC-catalog
// `applies-to` entry, a wait-predicate selector (`z.enum(['merge', 'idle'])`)
// and a `gh`/`glab` PR subcommand (`['pr', 'merge', prId]`); `'branch'` ships as
// a runbook template variable (`['taskId', …, 'branch', 'worktreePath']`), an
// index key (`task['branch']`) and a git READ (`['branch', '--show-current']`).
//
// The discriminator is therefore ARGV SHAPE, not the token:
//
//   (1) HEAD POSITION — the subcommand literal must be the FIRST element of an
//       array literal (`[` + optional whitespace/newlines immediately before
//       it). `git <subcommand>` is always argv[0] in this codebase's exec
//       helpers, whereas every incidental `'merge'` above is either mid-array
//       (`'rebase', 'merge'`, `'pr', 'merge'`), a union member, an object value
//       or a `case` label.
//   (2) OPERAND SHAPE — the element *after* the subcommand must be either a
//       quoted git OPTION token (`-x` / `--long-form`) or a bare JS identifier
//       (a branch/ref variable such as `sourceBranch` or `input.branch`). A
//       quoted NON-option string is the signature of a plain data array, which
//       is what excludes `['merge', 'idle']` and `['branch', 'worktreePath']`.
//
// Each rule below is over-determined: on the live tree, (1) and (2) each
// independently exclude every incidental literal, so a future edit that erodes
// one guard does not immediately open a false-positive hole.
//
// `['merge', <option|ref>]` — every `git merge` invocation mutates (including
// `merge --abort`, which mutates in-progress merge state), so any option token
// qualifies.
const MERGE_RE = /\[\s*(['"`])merge\1\s*,\s*(?:(['"`])--?[A-Za-z][-A-Za-z0-9]*\2|[A-Za-z_$])/;
// `['branch', <ref-identifier>]` — `git branch <name>` CREATES. The operand must
// be an identifier: a quoted operand is either an option (`'-D'` → deletion,
// handled above; `'--show-current'` → a read) or a data-array neighbour.
const BRANCH_CREATE_RE = /\[\s*(['"`])branch\1\s*,\s*[A-Za-z_$]/;
// `['checkout', '-b'|'-B', …]` / `['switch', '-c'|'-C', …]` — the other two real
// branch-creation vectors. These ARE adjacent-literal-clean (a bare `['checkout',
// ref]` or `['checkout', ref, '--', …]` is a working-tree switch/restore, not a
// creation, and is correctly excluded by requiring the create flag).
const CHECKOUT_CREATE_RE = /\[\s*(['"`])checkout\1\s*,\s*(['"`])-[bB]\2/;
const SWITCH_CREATE_RE = /\[\s*(['"`])switch\1\s*,\s*(['"`])-[cC]\2/;

/**
 * Enumerate the git worktree/branch/merge mutation sites in one module's source.
 * Pure; comment-stripped so doc examples do not count. At most one occurrence
 * per (module, mutation-kind) — ownership is per module.
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
