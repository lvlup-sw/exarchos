// @oracle-sources: real Git worktree registration, independent ref/index/object snapshots and observable callback marker files
/** Real disposable repositories distinguish constrained structural reads from callback-capable Git. */
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitObserver } from '../../src/utils/git-observer.js';

const exec = promisify(execFile);
const roots: string[] = [];
/** Resolve the fixture executable once from the trusted test process PATH. */
async function fixtureGit() {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch {}
  }
  throw new Error('Fixture requires Git on PATH');
}

const gitExecutable = await fixtureGit();
const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';


/** Fixture mutation uses ordinary Git only against the owned temporary root. */
async function git(cwd: string, ...args: string[]) {
  return (await exec(gitExecutable, ['-C', cwd, ...args], { timeout: 10_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullFile, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } })).stdout.trim();
}

/** Two registered checkouts deliberately have different branch heads and index bytes. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), '1928-observer-')); roots.push(root);
  const main = join(root, 'main'); const linked = join(root, 'linked');
  await mkdir(main); await git(main, 'init', '-b', 'main');
  await writeFile(join(main, 'file.txt'), 'base\n'); await git(main, 'add', '.'); await git(main, 'commit', '-m', 'base');
  const base = await git(main, 'rev-parse', 'HEAD');
  await git(main, 'worktree', 'add', '-b', 'task', linked);
  await writeFile(join(linked, 'file.txt'), 'task\n'); await git(linked, 'add', '.'); await git(linked, 'commit', '-m', 'task');
  const head = await git(linked, 'rev-parse', 'HEAD'); const repository = await realpath(join(main, '.git'));
  const input = { checkout: linked, repository, branch: 'refs/heads/task' };
  return { root, main, linked, base, head, repository, input, observer: await createGitObserver(gitExecutable) };
}

/** Content hashes inspect storage directly. No status or filter is used as an oracle. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(dir: string, prefix: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`; const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path, `${name}/`);
      else if (entry.isFile()) result[name] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await visit(root, ''); return result;
}

afterEach(async () => { for (const root of roots.splice(0)) await rmrfAsync(root); });

describe('constrained Git structural reader', () => {
  it('LinkedRegistration_ExactCoordinatesAndImmutableAncestry', async () => {
    const f = await fixture(); const before = await snapshot(f.repository);
    const selected = await f.observer.checkout(f.input);
    expect(selected).toMatchObject({ kind: 'observed', value: { checkout: f.linked, repository: f.repository, branch: 'refs/heads/task', head: f.head } });
    if (selected.kind !== 'observed') throw new Error(selected.reason);
    expect(selected.value.gitDir).not.toBe(f.repository);
    expect(await readFile(join(selected.value.gitDir, 'index'))).not.toEqual(await readFile(join(f.repository, 'index')));
    expect(await f.observer.ancestry(f.input, f.base, f.head)).toEqual({ kind: 'observed', value: true });
    expect(await f.observer.ancestry(f.input, f.head, f.base)).toEqual({ kind: 'observed', value: false });
    expect((await f.observer.ancestry(f.input, f.base, 'HEAD')).kind).toBe('refused');
    expect((await f.observer.ancestry(f.input, f.base, '0'.repeat(40))).kind).toBe('refused');
    const alias = join(f.root, 'alias'); await symlink(f.linked, alias);
    expect(await f.observer.checkout({ ...f.input, checkout: alias })).toEqual(selected);
    expect(await snapshot(f.repository)).toEqual(before);
    await git(f.linked, 'reset', '--hard', f.base);
    expect(await f.observer.ancestry(f.input, f.head, f.base)).toEqual({ kind: 'observed', value: false });
    expect(await f.observer.ancestry(f.input, f.base, f.head)).toEqual({ kind: 'observed', value: true });
  });

  it('CopiedPointerForeignRepositoryAndDetachedHead_Refuse', async () => {
    const f = await fixture(); const other = await fixture();
    expect((await f.observer.checkout({ ...f.input, checkout: other.linked })).kind).toBe('refused');
    expect((await f.observer.checkout({ ...f.input, branch: 'refs/heads/main' })).kind).toBe('refused');
    for (const branch of ['HEAD', '--help', 'refs/heads/task^{commit}', 'refs/heads/../task']) expect((await f.observer.checkout({ ...f.input, branch })).kind).toBe('refused');
    const copied = join(f.root, 'copied'); await mkdir(copied); await writeFile(join(copied, '.git'), await readFile(join(f.linked, '.git')));
    expect((await f.observer.checkout({ ...f.input, checkout: copied })).kind).toBe('refused');
    const stale = join(f.root, 'stale'); await git(f.main, 'worktree', 'add', '-b', 'stale', stale);
    await rmrfAsync(stale);
    expect((await f.observer.checkout(f.input)).kind).toBe('observed');
    await git(f.linked, 'checkout', '--detach');
    expect((await f.observer.checkout(f.input)).kind).toBe('refused');
  });

  it('MetadataAndCapability_UnsupportedInputsRefuseBeforeReads', async () => {
    const f = await fixture(); const configPath = join(f.repository, 'config'); const config = await readFile(configPath);
    for (const extra of ['\n[include]\n path = /untrusted/config\n', '\n[extensions]\n objectformat = sha256\n']) {
      await writeFile(configPath, Buffer.concat([config, Buffer.from(extra)]));
      expect(await f.observer.checkout(f.input)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('config include or extension') });
    }
    await writeFile(configPath, config);
    const pointer = join(f.linked, '.git'); const original = await readFile(pointer);
    await writeFile(pointer, 'x'.repeat(65537));
    expect(await f.observer.checkout(f.input)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('metadata') });
    await rm(pointer); await symlink(join(f.main, '.git'), pointer);
    expect(await f.observer.checkout(f.input)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('symlink') });
    await rm(pointer); await writeFile(pointer, original);
    await writeFile(join(f.repository, 'objects', 'info', 'alternates'), f.repository);
    expect(await f.observer.checkout(f.input)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('object storage') });
    await rm(join(f.repository, 'objects', 'info', 'alternates'));
    if (process.platform === 'linux') {
      await rm(pointer); await exec('mkfifo', [pointer]);
      expect(await f.observer.checkout(f.input)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('metadata') });
      await rm(pointer); await writeFile(pointer, original);
      const marker = join(f.root, 'unsupported-called'); const unsupported = join(f.root, 'old-git');
      await writeFile(unsupported, `#!/bin/sh\nprintf 'called' > '${marker}'\nexit 129\n`); await chmod(unsupported, 0o755);
      await expect(createGitObserver(unsupported)).rejects.toThrow(); expect(await readFile(marker, 'utf8')).toBe('called');
    }
    expect((await f.observer.checkout(f.input)).kind).toBe('observed');
  });

  it('StatusCallbacks_ReachableButCleanlinessNeverExecutesThem', async ({ skip }) => {
    if (process.platform !== 'linux') return skip();
    const f = await fixture(); const marker = join(f.root, 'callback'); const hook = join(f.root, 'callback.cjs');
    await writeFile(hook, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n'); process.stdout.write('token\\0/\\0');`);
    const command = `"${process.execPath}" "${hook}"`;
    await git(f.linked, 'config', 'core.fsmonitor', command);
    await git(f.linked, 'status', '--porcelain'); expect(await readFile(marker, 'utf8')).toContain('called');
    await rm(marker); await git(f.linked, 'config', 'core.fsmonitor', 'false');
    await writeFile(hook, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n'); process.stdin.pipe(process.stdout);`);
    await writeFile(join(f.linked, '.gitattributes'), 'file.txt filter=fixture\n');
    await git(f.linked, 'config', 'filter.fixture.clean', command);
    await git(f.linked, 'add', '.'); await git(f.linked, 'commit', '-m', 'filter');
    await rm(marker, { force: true });
    await writeFile(join(f.linked, 'file.txt'), 'diff\n');
    await git(f.linked, '--no-optional-locks', 'status', '--porcelain');
    expect(await readFile(marker, 'utf8')).toContain('called'); await rm(marker);
    const before = await snapshot(f.repository);
    expect(f.observer.cleanliness()).toMatchObject({ kind: 'refused', reason: expect.stringContaining('Hosted') });
    expect((await f.observer.checkout(f.input)).kind).toBe('observed');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await snapshot(f.repository)).toEqual(before);
  });

  it('TextconvAndExternalDiff_ReachableButExactDiffSuppressesCallbacks', async ({ skip }) => {
    if (process.platform !== 'linux') return skip();
    const f = await fixture(); const marker = join(f.root, 'textconv'); const script = join(f.root, 'textconv.cjs');
    await writeFile(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n'); console.log('converted');`);
    const command = `"${process.execPath}" "${script}"`;
    await writeFile(join(f.linked, '.gitattributes'), 'file.txt diff=fixture\n');
    await git(f.linked, 'config', 'diff.fixture.textconv', command);
    await git(f.linked, 'diff', f.base, f.head, '--', 'file.txt'); expect(await readFile(marker, 'utf8')).toContain('called'); await rm(marker);
    await git(f.linked, 'config', 'diff.fixture.command', command);
    await git(f.linked, 'diff', '--no-textconv', f.base, f.head, '--', 'file.txt'); expect(await readFile(marker, 'utf8')).toContain('called'); await rm(marker);
    const before = await snapshot(f.repository);
    expect(await f.observer.diff(f.input, f.base, f.head)).toMatchObject({ kind: 'observed', value: expect.stringContaining('-base') });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await snapshot(f.repository)).toEqual(before);
    await git(f.linked, 'config', '--unset', 'diff.fixture.command');
    const textconvBefore = await snapshot(f.repository);
    expect(await f.observer.diff(f.input, f.base, f.head)).toMatchObject({ kind: 'observed', value: expect.stringContaining('-base') });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await snapshot(f.repository)).toEqual(textconvBefore);
    expect((await f.observer.diff(f.input, '--output=bad', f.head)).kind).toBe('refused');
  });

  it('PromisorMissingObject_PositiveFetchThenGovernedRefusalWithoutStorageWrites', async ({ skip }) => {
    if (process.platform !== 'linux') return skip();
    const f = await fixture(); await git(f.main, 'config', 'uploadpack.allowFilter', 'true');
    const clone = join(f.root, 'partial'); await git(f.root, 'clone', '--no-checkout', '--filter=blob:none', `file://${f.main}`, clone);
    const blob = await git(f.main, 'rev-parse', `${f.base}:file.txt`);
    const objects = join(clone, '.git', 'objects'); const missing = await snapshot(objects);
    expect(await git(clone, 'cat-file', '-p', blob)).toBe('base'); expect(await snapshot(objects)).not.toEqual(missing);
    const second = join(f.root, 'partial-governed'); await git(f.root, 'clone', '--no-checkout', '--filter=blob:none', `file://${f.main}`, second);
    const input = { checkout: second, repository: join(second, '.git'), branch: 'refs/heads/main' };
    const before = await snapshot(input.repository);
    const outcome = await f.observer.diff(input, f.base, f.head);
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') throw new Error('Missing promisor objects must not be fetched');
    expect(outcome.reason).toMatch(/Unsupported repository config include or extension|could not fetch|unable to read|bad object|missing|transport .*not allowed/i);
    expect(await snapshot(input.repository)).toEqual(before);
  });
});

/** A marker program that appends one line to `marker` each time a hook runs it, and prints nothing. */
async function markerProgram(root: string): Promise<{ readonly program: string; readonly marker: string }> {
  const marker = join(root, 'marker.log');
  const program = join(root, 'marker.sh');
  await writeFile(program, `#!/bin/sh\necho "called $0 $*" >> '${marker}'\nexit 0\n`);
  await chmod(program, 0o755);
  return { program, marker };
}

/** Assert that the marker ran once or more, then clear it for the next control. */
async function expectMarkerRan(marker: string): Promise<void> {
  expect(await readFile(marker, 'utf8')).toContain('called');
  await rm(marker);
}

/** Replace the head of `checkout` with a copy of its commit that carries a garbage `gpgsig` header. It returns the new commit. */
async function garbageSignedHead(root: string, checkout: string): Promise<string> {
  const raw = await git(checkout, 'cat-file', 'commit', 'HEAD');
  const signed = raw.replace(/^(committer [^\n]*\n)/m, '$1gpgsig -----BEGIN PGP SIGNATURE-----\n garbage\n -----END PGP SIGNATURE-----\n');
  const file = join(root, 'signed-commit');
  await writeFile(file, `${signed}\n`);
  const commit = await git(checkout, 'hash-object', '-t', 'commit', '-w', file);
  await git(checkout, 'reset', '-q', '--hard', commit);
  return commit;
}

describe('closed reads of the current checkout', () => {
  /** The current observation reads the symbolic HEAD itself. A base name resolves to an object ID, then a local branch, then a remote-tracking ref. */
  it('CurrentCheckoutAndBaseNames_ClosedOrderAndDetachedRefusal', async () => {
    const f = await fixture();
    const main = await f.observer.current(f.main);
    const linked = await f.observer.current(f.linked);
    expect(main).toMatchObject({ kind: 'observed', value: { checkout: await realpath(f.main), branch: 'refs/heads/main', head: f.base } });
    expect(linked).toMatchObject({ kind: 'observed', value: { checkout: await realpath(f.linked), repository: f.repository, branch: 'refs/heads/task', head: f.head } });
    if (linked.kind !== 'observed') throw new Error(linked.reason);
    await git(f.main, 'update-ref', 'refs/remotes/origin/feature', f.head);
    await git(f.main, 'tag', 'only-a-tag', f.base);

    expect(await f.observer.base(linked.value, 'main')).toEqual({ kind: 'observed', value: f.base });
    expect(await f.observer.base(linked.value, f.head)).toEqual({ kind: 'observed', value: f.head });
    expect(await f.observer.base(linked.value, 'origin/feature')).toEqual({ kind: 'observed', value: f.head });
    for (const refused of ['only-a-tag', 'origin', 'main..task', 'main~1', '--help', '0'.repeat(40)]) {
      expect((await f.observer.base(linked.value, refused)).kind, refused).toBe('refused');
    }

    await git(f.linked, 'checkout', '-q', '--detach');
    expect(await f.observer.current(f.linked)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('detached') });
  });

  /**
   * Plain Git runs each armed repository hook: the fsmonitor through status, the external diff and textconv through diff, and gpg.program through log.
   * One governed control is a commit with a garbage gpgsig header under `log.showSignature=true`. The closed commit range lists it and runs no gpg.program.
   * No new closed read runs any marker, and no read writes repository storage.
   */
  it('ArmedRepositoryHooks_ReachableButEveryNewClosedReadRunsNone', async ({ skip }) => {
    if (process.platform !== 'linux') return skip();
    const f = await fixture();
    const { program, marker } = await markerProgram(f.root);
    const signedHead = await garbageSignedHead(f.root, f.linked);
    await git(f.main, 'update-ref', 'refs/remotes/origin/main', f.base);
    await git(f.main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    await writeFile(join(f.linked, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(f.linked, 'ignored.txt'), 'ignored\n');
    await writeFile(join(f.linked, 'untracked.txt'), 'untracked\n');
    await mkdir(join(f.repository, 'info'), { recursive: true });
    await writeFile(join(f.repository, 'info', 'attributes'), '* diff=fixture\n');
    for (const [key, value] of [['core.fsmonitor', program], ['diff.external', program], ['diff.fixture.textconv', program], ['log.showSignature', 'true'], ['gpg.program', program]]) {
      await git(f.main, 'config', key, value);
    }

    await git(f.linked, 'status', '--porcelain'); await expectMarkerRan(marker);
    await git(f.linked, 'diff', f.base, signedHead); await expectMarkerRan(marker);
    await git(f.linked, 'diff', '--no-ext-diff', f.base, signedHead); await expectMarkerRan(marker);
    await git(f.linked, 'log', '-1', signedHead); await expectMarkerRan(marker);
    const before = await snapshot(f.repository);

    const selected = await f.observer.current(f.linked);
    if (selected.kind !== 'observed') throw new Error(selected.reason);
    const { gitDir, checkout, head } = selected.value;
    const reads = f.observer.reads;
    const decode = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\0');
    expect(head).toBe(signedHead);
    expect(decode(await reads.treeListing(gitDir, checkout, head)).some((record) => record.endsWith('\tfile.txt'))).toBe(true);
    expect(decode(await reads.indexListing(gitDir, checkout)).some((record) => record.endsWith('\tfile.txt'))).toBe(true);
    const untracked = decode(await reads.untrackedListing(gitDir, checkout));
    expect(untracked).toContain('untracked.txt');
    expect(untracked).not.toContain('ignored.txt');
    expect((await reads.mergeBase(gitDir, checkout, f.base, head)).trim()).toBe(f.base);
    expect((await reads.remoteCommit(gitDir, checkout, 'refs/remotes/origin/main')).trim()).toBe(f.base);
    expect((await reads.originHead(gitDir, checkout)).trim()).toBe('refs/remotes/origin/main');
    expect(await f.observer.base(selected.value, 'origin/main')).toEqual({ kind: 'observed', value: f.base });
    expect((await reads.nameOnly(gitDir, checkout, f.base, head)).trim()).toBe('file.txt');
    expect(await reads.commitRange(gitDir, checkout, f.base, head)).toContain('task');
    expect(await reads.fullDiff(gitDir, checkout, f.base, head)).toContain('+task');

    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await snapshot(f.repository)).toEqual(before);
    await expect(async () => reads.commitRange(gitDir, checkout, 'HEAD', head)).rejects.toThrow();
    await expect(async () => reads.remoteCommit(gitDir, checkout, 'refs/remotes/origin')).rejects.toThrow();
  });

  /**
   * With `diff.submodule=diff`, plain Git starts a child diff in a populated submodule for a gitlink change, and that child runs the submodule `diff.external`.
   * The closed full diff passes `--submodule=short`, so the marker never runs and the gitlink shows as a short subproject line.
   */
  it('PopulatedSubmoduleExternalDiff_ReachableButFullDiffRunsNone', async ({ skip }) => {
    if (process.platform !== 'linux') return skip();
    const root = await mkdtemp(join(tmpdir(), '1928-observer-sub-')); roots.push(root);
    const { program, marker } = await markerProgram(root);
    const child = join(root, 'child'); const superproject = join(root, 'super');
    await mkdir(child); await git(child, 'init', '-q', '-b', 'main');
    await writeFile(join(child, 'f.txt'), 'one\n'); await git(child, 'add', '.'); await git(child, 'commit', '-q', '-m', 'one');
    const first = await git(child, 'rev-parse', 'HEAD');
    await writeFile(join(child, 'f.txt'), 'two\n'); await git(child, 'commit', '-q', '-am', 'two');
    const second = await git(child, 'rev-parse', 'HEAD');
    await mkdir(superproject); await git(superproject, 'init', '-q', '-b', 'main');
    await writeFile(join(superproject, 'top.txt'), 'top\n'); await git(superproject, 'add', 'top.txt');
    await git(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'sub');
    await git(join(superproject, 'sub'), 'checkout', '-q', first);
    await git(superproject, 'add', 'sub'); await git(superproject, 'commit', '-q', '-m', 'A');
    const before = await git(superproject, 'rev-parse', 'HEAD');
    await git(join(superproject, 'sub'), 'checkout', '-q', second);
    await git(superproject, 'add', 'sub'); await git(superproject, 'commit', '-q', '-m', 'B');
    const after = await git(superproject, 'rev-parse', 'HEAD');
    await git(superproject, 'config', 'diff.submodule', 'diff');
    await git(join(superproject, 'sub'), 'config', 'diff.external', program);

    await git(superproject, 'diff', before, after); await expectMarkerRan(marker);

    const observer = await createGitObserver(gitExecutable);
    const selected = await observer.current(superproject);
    if (selected.kind !== 'observed') throw new Error(selected.reason);
    const { gitDir, checkout } = selected.value;
    const diff = await observer.reads.fullDiff(gitDir, checkout, before, after);
    expect(diff).toContain('Subproject commit');
    expect((await observer.reads.nameOnly(gitDir, checkout, before, after)).trim()).toBe('sub');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
