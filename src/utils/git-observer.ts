// RESERVED(issue: #1928, owner: exarchos, expires: 2027-02-28) — staged reader for the planned observation cutover.
/** Staged structural Git observations. Cleanliness remains an external harness obligation. */
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createConstrainedGitReads, constrainedBranchRef as branchRef, constrainedCommitId as commitId } from './git-tree.js';

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

/** Create an operator-pinned structural reader that refuses unsupported observations without unsafe recovery. */
export async function createGitObserver(executable: string) {
  const reads = await createConstrainedGitReads(executable);

  async function identity(input: { readonly checkout: string; readonly repository: string; readonly branch: string }) {
    const branch = branchRef(input.branch);
    const checkout = await realpath(input.checkout);
    const repository = await realpath(input.repository);
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
    if (actualCommon !== repository) throw new Error('Checkout belongs to a different repository');
    if (gitDir !== repository) {
      const registration = relative(join(repository, 'worktrees'), gitDir);
      if (!registration || registration === '..' || registration.startsWith(`..${sep}`) || registration.includes(sep) || isAbsolute(registration)) throw new Error('Unsupported linked Git directory');
      const back = await optionalFile(join(gitDir, 'gitdir'));
      if (back === undefined || await realpath(resolve(gitDir, pointerLine(back))) !== await realpath(dotGit)) throw new Error('Linked worktree backpointer differs');
    }
    for (const path of [join(repository, 'config'), join(gitDir, 'config.worktree')]) {
      const config = await optionalFile(path);
      if (config !== undefined && /^\s*\[\s*(?:include|includeIf|extensions)\b/im.test(config)) throw new Error('Unsupported repository config include or extension');
    }
    const objects = join(repository, 'objects');
    if (await realpath(objects) !== objects || await optionalFile(join(objects, 'info', 'alternates')) !== undefined
      || await optionalFile(join(repository, 'info', 'grafts')) !== undefined
      || (await optionalFile(join(repository, 'shallow')))?.trim()) throw new Error('Unsupported object storage or shallow ancestry');
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

  async function observe<T>(read: () => Promise<T>): Promise<{ readonly kind: 'observed'; readonly value: T } | { readonly kind: 'refused'; readonly reason: string }> {
    try { return { kind: 'observed', value: await read() }; }
    catch (error) { return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }; }
  }

  return {
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
    cleanliness: () => ({ kind: 'refused', reason: 'Hosted clean-tree evidence is required; this reader never runs status' }),
  };
}
