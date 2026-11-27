/**
 * A disposable copy of the exact head of one checkout, for a check that writes files.
 * The copy holds the committed blobs of the head tree, read through the constrained Git reader.
 * It holds a private Git directory, whose detached HEAD is the head and whose object store reads the repository objects as an alternate.
 * Thus a leg reads the exact commits, and a Git write in the copy changes only the private directory.
 *
 * A reverted copy holds the head tree with each named source path at its blob of a base commit. A source path that the base lacks is left out.
 * It links node_modules from the live checkout, so a project-local runner resolves as in the checkout.
 * The live checkout and its Git state are never written. The copy is deleted after the body, and a copy that stays refuses.
 */
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';

import type { ConstrainedGitReads } from '../../utils/git-tree.js';

/**
 * Write the private Git directory of a copy. It runs no Git process.
 * HEAD names the exact head, the refs are empty, and the alternates file names the object store of the repository.
 * A 64-character head selects the SHA-256 object format.
 */
async function writePrivateGitDirectory(copy: string, repository: string, head: string): Promise<void> {
  const gitDir = join(copy, '.git');
  for (const directory of ['refs/heads', 'refs/tags', 'objects/info']) await mkdir(join(gitDir, directory), { recursive: true });
  const sha256 = head.length === 64;
  const config = sha256
    ? '[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectformat = sha256\n'
    : '[core]\n\trepositoryformatversion = 0\n\tbare = false\n';
  await writeFile(join(gitDir, 'config'), config, { flag: 'wx' });
  await writeFile(join(gitDir, 'HEAD'), `${head}\n`, { flag: 'wx' });
  await writeFile(join(gitDir, 'objects', 'info', 'alternates'), `${await realpath(join(repository, 'objects'))}\n`, { flag: 'wx' });
}

/** The largest number of tracked entries that one copy holds. */
const MAXIMUM_COPY_ENTRIES = 32768;

/** The largest number of blob bytes that one copy holds. */
const MAXIMUM_COPY_BYTES = 256 * 1024 * 1024;

/** The prefix of each copy directory under the temporary directory of the operating system. */
const DISPOSABLE_COPY_PREFIX = 'exarchos-check-';

/** The exact head of one observed checkout and the constrained reads of its Git directory. */
export interface DisposableCopySource {
  readonly checkout: string;
  readonly gitDir: string;
  /** The common Git directory of the checkout. Its object store is the alternate of the private Git directory. */
  readonly repository: string;
  readonly head: string;
  readonly reads: Pick<ConstrainedGitReads, 'treeListing' | 'blobs'>;
}

/** One regular file of the head tree. */
interface CopyEntry {
  readonly path: string;
  readonly oid: string;
  readonly executable: boolean;
}

/** True for a tree path that stays inside the copy and names no Git directory. */
function safeTreePath(path: string): boolean {
  return !path.includes('\\') && !/[\x00]/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

/** The regular files of one commit tree. A link, a submodule, an unsafe path or a tree beyond the bounds refuses. */
async function treeEntries(source: DisposableCopySource, commit: string): Promise<readonly CopyEntry[]> {
  const records = new TextDecoder('utf-8', { fatal: true }).decode(await source.reads.treeListing(source.gitDir, source.checkout, commit)).split('\0');
  if (records.pop() !== '' || records.length > MAXIMUM_COPY_ENTRIES) throw new Error('The tree exceeds the bounds of a disposable copy');
  return records.map((record) => {
    const [, mode, oid, path] = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/s.exec(record) ?? [];
    if (mode === undefined || oid === undefined || path === undefined || !safeTreePath(path)) {
      throw new Error('The tree holds an entry that a disposable copy does not support');
    }
    return { path, oid, executable: mode === '100755' };
  });
}

/** The source paths of a reverted copy and the base commit that gives their blobs. */
export interface SourceRevert {
  readonly base: string;
  readonly sources: readonly string[];
}

/**
 * The entries of the copy: the head tree, with each source path of `revert` at its base entry.
 * A source path that the base lacks is left out. A source path that neither the base nor the head holds refuses.
 */
async function copyEntries(source: DisposableCopySource, revert: SourceRevert | undefined): Promise<readonly CopyEntry[]> {
  const head = await treeEntries(source, source.head);
  if (revert === undefined) return head;
  const base = new Map((await treeEntries(source, revert.base)).map(entry => [entry.path, entry]));
  const entries = new Map(head.map(entry => [entry.path, entry]));
  for (const path of revert.sources) {
    const original = base.get(path);
    if (original === undefined && !entries.has(path)) throw new Error(`The source path ${path} is in neither the base nor the head`);
    if (original === undefined) entries.delete(path);
    else entries.set(path, original);
  }
  return [...entries.values()];
}

/** True when a path exists, without following a final link. */
async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** One built copy: its root and the delete of it. A copy that stays after the delete throws. */
export interface DisposableCopy {
  readonly root: string;
  dispose(): Promise<void>;
}

/** Delete one copy root. A root that stays after the delete throws. */
async function removeCopy(copy: string): Promise<void> {
  await rm(copy, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  if (await present(copy)) throw new Error('The disposable copy was not removed');
}

/**
 * Delete one copy after `failure`, and give the error for the caller.
 * A delete that also fails does not hide `failure`: the result is an `AggregateError` with the message of `failure`, and `failure` first.
 */
async function removeAfterFailure(copy: string, failure: unknown): Promise<unknown> {
  try {
    await removeCopy(copy);
    return failure;
  } catch (cleanup) {
    const message = failure instanceof Error ? failure.message : String(failure);
    return new AggregateError([failure, cleanup], message);
  }
}

/**
 * Build a copy of the exact head, or of the head with the sources of `revert` at the base.
 * A copy that cannot be built is deleted before the error goes to the caller. A failed delete does not hide the build error.
 */
export async function buildDisposableCopy(source: DisposableCopySource, revert?: SourceRevert): Promise<DisposableCopy> {
  const entries = await copyEntries(source, revert);
  const blobs = await source.reads.blobs(source.gitDir, source.checkout, [...new Set(entries.map(entry => entry.oid))], MAXIMUM_COPY_BYTES);
  const copy = await realpath(await mkdtemp(join(os.tmpdir(), DISPOSABLE_COPY_PREFIX)));
  try {
    for (const entry of entries) {
      const bytes = blobs.get(entry.oid);
      if (bytes === undefined) throw new Error('A blob of the copied tree is missing');
      const target = join(copy, entry.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx', mode: entry.executable ? 0o755 : 0o644 });
    }
    await writePrivateGitDirectory(copy, source.repository, source.head);
    const modules = join(source.checkout, 'node_modules');
    if (await present(modules) && !await present(join(copy, 'node_modules'))) {
      await symlink(await realpath(modules), join(copy, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    }
  } catch (error) {
    throw await removeAfterFailure(copy, error);
  }
  return { root: copy, dispose: () => removeCopy(copy) };
}

/**
 * Build a copy of the exact head, run the body in it, then delete it.
 * The body gets the copy root. A copy that cannot be built, or that stays after the delete, throws.
 * When the body throws and the delete also fails, the error keeps the body error first.
 */
export async function withDisposableCopy<T>(source: DisposableCopySource, body: (copy: string) => Promise<T>): Promise<T> {
  const copy = await buildDisposableCopy(source);
  let result: T;
  try {
    result = await body(copy.root);
  } catch (error) {
    throw await removeAfterFailure(copy.root, error);
  }
  await copy.dispose();
  return result;
}
