// @oracle-sources: child Node process importing the production observer and real disposable repository identities
/** Staged process proof, without claiming public CLI cutover or hosted cleanliness. */
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

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


it('StagedReader_ProcessEnvironmentCannotRedirectCoordinates', async () => {
  const root = await mkdtemp(join(tmpdir(), '1928-reader-process-'));
  try {
    const tree = join(root, 'tree'); await mkdir(tree);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullFile, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) await execute(gitExecutable, ['-C', tree, ...args], { env });
    await writeFile(join(tree, 'file'), 'content');
    await execute(gitExecutable, ['-C', tree, 'add', '.'], { env }); await execute(gitExecutable, ['-C', tree, 'commit', '-m', 'fixture'], { env });
    const repository = await realpath(join(tree, '.git'));
    const source = pathToFileURL(resolve('src/utils/git-observer.ts')).href;
    const program = `import { createGitObserver } from ${JSON.stringify(source)};
      const observer = await createGitObserver(${JSON.stringify(gitExecutable)});
      const result = await observer.checkout(${JSON.stringify({ checkout: tree, repository, branch: 'refs/heads/main' })});
      let relativeRefused = false; try { await createGitObserver('git'); } catch { relativeRefused = true; }
      console.log(JSON.stringify({ result, clean: observer.cleanliness(), relativeRefused }));`;
    const child = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { env: { ...env, GIT_DIR: '/not-the-repository', GIT_WORK_TREE: '/not-the-tree', GIT_INDEX_FILE: join(root, 'wrong-index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' }, timeout: 30_000 });
    expect(JSON.parse(child.stdout)).toMatchObject({ result: { kind: 'observed', value: { repository, branch: 'refs/heads/main' } }, clean: { kind: 'refused' }, relativeRefused: true });
  } finally { await rmrfAsync(root); }
});
