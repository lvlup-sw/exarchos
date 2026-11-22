// RESERVED(issue: #1928, owner: exarchos, expires: 2027-02-28) — staged reader for the planned observation cutover.
/** Staged structural Git observations. Cleanliness remains an external harness obligation. */
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  createConstrainedGitReads, constrainedBranchRef as branchRef, constrainedCommitId as commitId, type ConstrainedGitReads,
} from './git-tree.js';

/** Read only bounded regular metadata, rejecting symlinks, devices and raced replacements. */
async function optionalFile(path: string): Promise<string | undefined> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.size > 64 * 1024) throw new Error('Unsupported Git metadata file');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > 64 * 1024) throw new Error('Git metadata identity changed');
      const bytes = Buffer.alloc(64 * 1024 + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 64 * 1024 || bytesRead !== stat.size) throw new Error('Git metadata exceeds bounded read');
      return bytes.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Pointer records have one exact path line. Whitespace inside the path is not normalized away. */
function pointerLine(value: string): string {
  const line = value.replace(/\r?\n$/, '');
  if (!line || /[\r\n\0]/.test(line)) throw new Error('Malformed Git metadata pointer');
  return line;
}

/** One observed checkout: its canonical root, its common dir, its own Git directory, its full branch ref and its head commit. */
export interface ObservedCheckout {
  readonly checkout: string;
  readonly repository: string;
  readonly gitDir: string;
  readonly branch: string;
  readonly head: string;
}

/** True when the value is a full commit object ID. */
function isObjectId(value: string): boolean {
  try { commitId(value); return true; } catch { return false; }
}

/** A section header that loads another file or turns on a repository extension. Git starts a section at any `[`, also after another header on one line. */
const LOADING_HEADER = /\[\s*(?:include|includeif|extensions)\b/i;

/** The one extensions header line that the observational policy accepts in the common config. */
const EXTENSIONS_HEADER_LINE = /^[ \t]*\[extensions\][ \t]*$/i;

/** One key line of an extensions section with the value `true`. The compare of the key name is in lower case. */
const TRUE_KEY_LINE = /^[ \t]*([A-Za-z]+)[ \t]*=[ \t]*true[ \t]*$/;

/** A branch or remote section header at any position. With worktreeConfig on, such a section in a config.worktree can move an upstream. */
const UPSTREAM_HEADER = /\[\s*(?:branch|remote)\b/i;

/** The storage policy of a located checkout: the strict policy of the verifier, or the observational policy of the inspection callers. */
type StoragePolicy = 'strict' | 'observational';

/** The most shallow boundary commits for which the decision helper decides a negative result. */
const SHALLOW_BOUNDARY_LIMIT = 64;

/** Refuse a config file that holds a loading header at any position. */
function refuseLoadingHeaders(config: string): void {
  if (LOADING_HEADER.test(config)) throw new Error('Unsupported repository config include or extension');
}

/**
 * Check the common config under the observational policy and tell whether it turns on `worktreeConfig`.
 * One `[extensions]` header line is allowed. Its body holds exactly the key line `worktreeConfig = true`, with blank lines and comments.
 * Each other loading header refuses, and so does each other body line.
 */
function observationalCommonConfig(config: string): boolean {
  const lines = config.split(/\r?\n/);
  let accepted: number | undefined;
  for (const [index, line] of lines.entries()) {
    if (!LOADING_HEADER.test(line)) continue;
    if (accepted !== undefined || !EXTENSIONS_HEADER_LINE.test(line)) throw new Error('Unsupported repository config include or extension');
    accepted = index;
  }
  if (accepted === undefined) return false;
  let keys = 0;
  for (const line of lines.slice(accepted + 1)) {
    if (/^[ \t]*\[/.test(line)) break;
    if (/^[ \t]*$/.test(line) || /^[ \t]*[#;]/.test(line)) continue;
    if (keys > 0 || TRUE_KEY_LINE.exec(line)?.[1]?.toLowerCase() !== 'worktreeconfig') {
      throw new Error('Unsupported repository config include or extension');
    }
    keys += 1;
  }
  if (keys !== 1) throw new Error('Unsupported repository config include or extension');
  return true;
}

/** The storage facts of one located checkout. */
interface LocatedStorage {
  readonly checkout: string;
  readonly repository: string;
  readonly gitDir: string;
  readonly shallow: readonly string[];
  readonly worktreeConfig: boolean;
}

/**
 * Locate a checkout root and run the storage checks of a policy, with no process.
 * Both policies refuse a `.git` symlink, a bad linked-worktree backpointer, a loading header in a checked config file, alternates and grafts.
 * The strict policy also refuses each extensions section and a non-empty shallow file.
 * The observational policy accepts exactly `worktreeConfig = true` and a shallow file whose lines are full object IDs.
 * It also checks the config.worktree of the common directory, because the worktree listing loads it.
 */
async function locateStorage(input: { readonly checkout: string; readonly repository?: string }, policy: StoragePolicy): Promise<LocatedStorage> {
  const checkout = await realpath(input.checkout);
  const claimed = input.repository === undefined ? undefined : await realpath(input.repository);
  const dotGit = join(checkout, '.git');
  const entry = await lstat(dotGit);
  if (entry.isSymbolicLink()) throw new Error('A checkout .git symlink is not supported');
  let gitDir: string;
  if (entry.isDirectory()) gitDir = await realpath(dotGit);
  else {
    const pointer = await optionalFile(dotGit);
    if (pointer === undefined) throw new Error('Missing checkout Git pointer');
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(pointer);
    if (match?.[1] === undefined) throw new Error('Malformed checkout Git pointer');
    gitDir = await realpath(resolve(checkout, match[1]));
  }
  const commonPointer = await optionalFile(join(gitDir, 'commondir'));
  const actualCommon = commonPointer === undefined ? gitDir : await realpath(resolve(gitDir, pointerLine(commonPointer)));
  const repository = claimed ?? actualCommon;
  if (actualCommon !== repository) throw new Error('Checkout belongs to a different repository');
  if (gitDir !== repository) {
    const registration = relative(join(repository, 'worktrees'), gitDir);
    if (!registration || registration === '..' || registration.startsWith(`..${sep}`) || registration.includes(sep) || isAbsolute(registration)) throw new Error('Unsupported linked Git directory');
    const back = await optionalFile(join(gitDir, 'gitdir'));
    if (back === undefined || await realpath(resolve(gitDir, pointerLine(back))) !== await realpath(dotGit)) throw new Error('Linked worktree backpointer differs');
  }
  const common = await optionalFile(join(repository, 'config'));
  let worktreeConfig = false;
  if (common !== undefined) {
    if (policy === 'strict') refuseLoadingHeaders(common);
    else worktreeConfig = observationalCommonConfig(common);
  }
  const worktreeFiles = policy === 'observational' && gitDir !== repository
    ? [join(gitDir, 'config.worktree'), join(repository, 'config.worktree')]
    : [join(gitDir, 'config.worktree')];
  for (const path of worktreeFiles) {
    const config = await optionalFile(path);
    if (config !== undefined) refuseLoadingHeaders(config);
  }
  const objects = join(repository, 'objects');
  if (await realpath(objects) !== objects || await optionalFile(join(objects, 'info', 'alternates')) !== undefined
    || await optionalFile(join(repository, 'info', 'grafts')) !== undefined) throw new Error('Unsupported object storage or shallow ancestry');
  const shallowFile = await optionalFile(join(repository, 'shallow'));
  if (policy === 'strict') {
    if (shallowFile?.trim()) throw new Error('Unsupported object storage or shallow ancestry');
    return { checkout, repository, gitDir, shallow: [], worktreeConfig };
  }
  const shallow = (shallowFile ?? '').split(/\r?\n/).filter(line => line !== '');
  if (shallow.some(line => !isObjectId(line))) throw new Error('Unsupported shallow boundary record');
  return { checkout, repository, gitDir, shallow, worktreeConfig };
}

/** Resolve a base name to a commit: a full object ID, then `refs/heads/<name>`, then `refs/remotes/<name>`. A rejected name refuses. */
async function resolveBase(reads: ConstrainedGitReads, at: { readonly gitDir: string; readonly checkout: string }, name: string): Promise<string> {
  if (isObjectId(name)) {
    await reads.requireCommit(at.gitDir, at.checkout, name);
    return name;
  }
  const local = branchRef(`refs/heads/${name}`);
  try { return commitId((await reads.commit(at.gitDir, at.checkout, local)).trim()); }
  catch { return commitId((await reads.remoteCommit(at.gitDir, at.checkout, `refs/remotes/${name}`)).trim()); }
}

/** True when the error is a Git exit with code 1. Git gives it for a negative ancestry or merge-base answer and for a missing ref under `--quiet`. */
export function exitedWithOne(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 1;
}

/** The message of a caught failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when a file system error says that the path or one of its parents does not exist. */
function missingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/**
 * Find the checkout root that holds `start`, with no process. The climb starts at the real path of `start` and stops at the first directory with a `.git` entry.
 * A start path that does not exist, or a climb that reaches the file system root, finds no checkout.
 */
async function climbToCheckout(start: string): Promise<string | undefined> {
  let directory: string;
  try { directory = await realpath(resolve(start)); }
  catch (error) {
    if (missingPath(error)) return undefined;
    throw error;
  }
  for (;;) {
    try {
      await lstat(join(directory, '.git'));
      return directory;
    } catch (error) {
      if (!missingPath(error)) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** One checkout that the observational located form found: its reader, its directories, its shallow boundary commits and its worktreeConfig flag. */
export interface ObservationalCheckout extends LocatedStorage {
  readonly reads: ConstrainedGitReads;
}

/** The outcome of the observational located form: no checkout, an unreadable checkout, or a located checkout. */
export type Observation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'located'; readonly located: ObservationalCheckout };

/**
 * The observational located form. It climbs from `start` to the checkout root with no process, then runs the observational storage policy.
 * It asks the reader source for its reader only after the checks pass, so a refused checkout starts no Git process.
 * No checkout gives `absent`. A refused check, a failed climb and an unusable reader give `unreadable`.
 */
export async function locateObservational(start: string, reader: () => Promise<ConstrainedGitReads>): Promise<Observation> {
  try {
    const root = await climbToCheckout(start);
    if (root === undefined) return { kind: 'absent' };
    const storage = await locateStorage({ checkout: root }, 'observational');
    return { kind: 'located', located: { ...storage, reads: await reader() } };
  } catch (error) {
    return { kind: 'unreadable', reason: messageOf(error) };
  }
}

/** One record of the constrained worktree listing. A HEAD of zeros is an unborn HEAD and gives no head. */
interface ListedWorktree {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly prunable: boolean;
}

/** Read the constrained worktree listing of a located repository. It passes the common directory as the Git directory. A failed listing rejects. */
export async function listObservedWorktrees(located: ObservationalCheckout): Promise<readonly ListedWorktree[]> {
  const listing = await located.reads.worktrees(located.repository, located.checkout);
  return listing.split('\0\0').filter(Boolean).flatMap((record) => {
    const fields = record.split('\0');
    const path = fields.find(field => field.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined) return [];
    const head = fields.find(field => field.startsWith('HEAD '))?.slice('HEAD '.length);
    const branch = fields.find(field => field.startsWith('branch '))?.slice('branch '.length);
    return [{
      path,
      ...(head !== undefined && isObjectId(head) && !/^0+$/.test(head) ? { head } : {}),
      ...(branch === undefined ? {} : { branch }),
      detached: fields.includes('detached'),
      bare: fields.includes('bare'),
      prunable: fields.some(field => field.startsWith('prunable')),
    }];
  });
}

/**
 * The head form: the HEAD commit and the optional full branch ref of the located checkout, from the constrained worktree listing.
 * A detached checkout gives a head and no branch. A bare, prunable, missing or unborn record rejects, because a read that needs the head is unreadable.
 */
export async function observeHead(located: ObservationalCheckout): Promise<{ readonly head: string; readonly branch?: string }> {
  const matching: ListedWorktree[] = [];
  for (const record of await listObservedWorktrees(located)) {
    try { if (await realpath(record.path) === located.checkout) matching.push(record); }
    catch { continue; }
  }
  const record = matching[0];
  if (matching.length !== 1 || record === undefined || record.bare || record.prunable || record.head === undefined) {
    throw new Error('The checkout has no readable head commit');
  }
  return { head: record.head, ...(record.branch === undefined ? {} : { branch: record.branch }) };
}

/** Resolve a base name in the located checkout in the base-name order: a full object ID, then `refs/heads/<name>`, then `refs/remotes/<name>`. */
export function resolveObservedBase(located: ObservationalCheckout, name: string): Promise<string> {
  return resolveBase(located.reads, located, name);
}

/**
 * True when a negative answer over the walked commits is decided. A checkout with no shallow boundary decides it.
 * Otherwise each boundary commit must not be an ancestor of each walked commit. A reachable boundary, a failed check or too many boundary commits leaves it undecided.
 */
async function negativeDecided(located: ObservationalCheckout, walked: readonly string[]): Promise<boolean> {
  if (located.shallow.length === 0) return true;
  if (located.shallow.length > SHALLOW_BOUNDARY_LIMIT) return false;
  for (const boundary of located.shallow) {
    for (const commit of walked) {
      try {
        await located.reads.ancestry(located.gitDir, located.checkout, boundary, commit);
        return false;
      } catch (error) {
        if (!exitedWithOne(error)) return false;
      }
    }
  }
  return true;
}

/** The answer of the decision helper: related with the common commit, decided unrelated, or unreadable. */
type Relation =
  | { readonly kind: 'related'; readonly commit: string }
  | { readonly kind: 'unrelated' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * The decision helper of the observational callers. An `ancestry` query asks whether `left` is an ancestor of `right`. A `merge-base` query reads their merge base.
 * A positive answer is decided. Its commit is `left` for ancestry and the merge base for a merge-base query.
 *
 * A negative answer is decided only when the shallow boundary cut no walked commit. An undecided answer and a failed read are unreadable, never a pass.
 */
export async function decideRelation(located: ObservationalCheckout, kind: 'ancestry' | 'merge-base', left: string, right: string): Promise<Relation> {
  try {
    if (kind === 'ancestry') {
      await located.reads.ancestry(located.gitDir, located.checkout, left, right);
      return { kind: 'related', commit: left };
    }
    return { kind: 'related', commit: commitId((await located.reads.mergeBase(located.gitDir, located.checkout, left, right)).trim()) };
  } catch (error) {
    if (!exitedWithOne(error)) return { kind: 'unreadable', reason: messageOf(error) };
  }
  if (await negativeDecided(located, kind === 'ancestry' ? [right] : [left, right])) return { kind: 'unrelated' };
  return { kind: 'unreadable', reason: 'The shallow boundary leaves the answer undecided' };
}

/**
 * True when the own config.worktree of a located linked worktree cannot move its upstream. The check applies only with worktreeConfig on.
 * The main worktree uses the common directory, so it passes. An unreadable file, or a branch or remote section at any position, fails.
 */
export async function ownWorktreeConfigNeutral(located: ObservationalCheckout): Promise<boolean> {
  if (!located.worktreeConfig || located.gitDir === located.repository) return true;
  try {
    const config = await optionalFile(join(located.gitDir, 'config.worktree'));
    return config === undefined || !UPSTREAM_HEADER.test(config);
  } catch {
    return false;
  }
}

/**
 * Create an operator-pinned structural reader that refuses unsupported observations without unsafe recovery.
 *
 * The storage checks of a checkout start no process and run before any Git read. The current observation reads the symbolic HEAD itself.
 * A current observation is observation only. It never selects a verifier identity, resource or request subject.
 * A base name resolves to a full object ID, then `refs/heads/<name>`, then `refs/remotes/<name>`. A rejected name refuses, and no later form is tried.
 */
export async function createGitObserver(executable: string) {
  const reads = await createConstrainedGitReads(executable);

  async function locate(input: { readonly checkout: string; readonly repository?: string }) {
    const { checkout, repository, gitDir } = await locateStorage(input, 'strict');
    return { checkout, repository, gitDir };
  }

  async function registered(located: { readonly checkout: string; readonly repository: string; readonly gitDir: string }, branch: string): Promise<ObservedCheckout> {
    const { checkout, repository, gitDir } = located;
    const registration = await reads.worktrees(repository, checkout);
    const records = registration.split('\0\0').filter(Boolean).map(record => record.split('\0'));
    const matching = [];
    for (const fields of records) {
      const root = fields.find(field => field.startsWith('worktree '))?.slice(9);
      if (root !== undefined) {
        try { if (await realpath(root) === checkout) matching.push(fields); }
        catch (error) { if (resolve(root) === checkout) throw error; }
      }
    }
    const fields = matching[0];
    if (matching.length !== 1 || fields === undefined || fields.some(field => field === 'bare' || field === 'detached' || field.startsWith('prunable'))
      || !fields.includes(`branch ${branch}`)) throw new Error('Checkout is not registered on the claimed branch');
    const symbolic = (await reads.branch(gitDir, checkout)).trim();
    if (symbolic !== branch) throw new Error('Selected checkout symbolic branch differs');
    const head = (await reads.commit(gitDir, checkout, branch)).trim();
    commitId(head);
    if (!fields.includes(`HEAD ${head}`)) throw new Error('Worktree moved during structural observation');
    return { checkout, repository, gitDir, branch, head };
  }

  async function identity(input: { readonly checkout: string; readonly repository: string; readonly branch: string }): Promise<ObservedCheckout> {
    const branch = branchRef(input.branch);
    return registered(await locate(input), branch);
  }

  async function currentIdentity(checkout: string): Promise<ObservedCheckout> {
    const located = await locate({ checkout });
    let symbolic: string;
    try { symbolic = (await reads.branch(located.gitDir, located.checkout)).trim(); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 1) throw new Error('The checkout HEAD is detached');
      throw error;
    }
    return registered(located, branchRef(symbolic));
  }

  async function baseCommit(selected: ObservedCheckout, name: string): Promise<string> {
    return resolveBase(reads, selected, name);
  }

  async function observe<T>(read: () => Promise<T>): Promise<{ readonly kind: 'observed'; readonly value: T } | { readonly kind: 'refused'; readonly reason: string }> {
    try { return { kind: 'observed', value: await read() }; }
    catch (error) { return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }; }
  }

  return {
    reads,
    current: (checkout: string) => observe(() => currentIdentity(checkout)),
    base: (selected: ObservedCheckout, name: string) => observe(() => baseCommit(selected, name)),
    checkout: (input: Parameters<typeof identity>[0]) => observe(() => identity(input)),
    ancestry: (input: Parameters<typeof identity>[0], ancestor: string, descendant: string) => observe(async () => {
      commitId(ancestor); commitId(descendant);
      const selected = await identity(input);
      for (const id of [ancestor, descendant]) await reads.requireCommit(selected.gitDir, selected.checkout, id);
      try { await reads.ancestry(selected.gitDir, selected.checkout, ancestor, descendant); return true; }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 1) return false; throw error; }
    }),
    diff: (input: Parameters<typeof identity>[0], base: string, head: string) => observe(async () => {
      commitId(base); commitId(head);
      const selected = await identity(input);
      for (const id of [base, head]) await reads.requireCommit(selected.gitDir, selected.checkout, id);
      return reads.diff(selected.gitDir, selected.checkout, base, head);
    }),
    nameStatus: (input: Parameters<typeof identity>[0], base: string, head: string) => observe(async () => {
      commitId(base); commitId(head);
      const selected = await identity(input);
      if (selected.head !== head) throw new Error('Registered head differs from the selected commit');
      await reads.requireCommit(selected.gitDir, selected.checkout, base);
      await reads.ancestry(selected.gitDir, selected.checkout, base, head);
      const diff = await reads.nameStatus(selected.gitDir, selected.checkout, base, head);
      const current = await identity(input);
      if (current.head !== head || current.gitDir !== selected.gitDir || current.repository !== selected.repository) {
        throw new Error('Registered checkout changed during the immutable diff');
      }
      return diff;
    }),
    cleanliness: () => ({ kind: 'refused', reason: 'Hosted clean-tree evidence is required; this reader never runs status' }),
  };
}
