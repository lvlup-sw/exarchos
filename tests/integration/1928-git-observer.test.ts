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
