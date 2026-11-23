// @oracle-sources: ../../../src/testgen/adapters/cli.ts, the hand-written repository fixtures and expected project verdicts in this file
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { dispatchInspection } from '../../../src/testgen/contract/operations.js';
import { collectMetadata } from '../../../src/testgen/inspection/collect.js';
import { runCli } from '../../../src/testgen/adapters/cli.js';

/** Create a Git repository that tracks the given files. */
async function repository(files: Record<string, string>): Promise<string> {
  const root = makeTempDir('testgen inspect ');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  await execFileAsync('git', ['init', '-q'], { cwd: root });
  await execFileAsync('git', ['add', '-A'], { cwd: root });
  return root;
}

/** Run the testgen CLI and return its exit code and standard output. */
async function cli(args: string[]) {
  let stdout = '';
  const exit = await runCli(args, (value) => { stdout += value; }, () => {});
  return { exit, stdout };
}

const vitestManifest = JSON.stringify({ devDependencies: { vitest: '^4.0.0' }, scripts: { test: 'vitest run' } });

it('resolves scoped TUnit pins and does not qualify conditional references', () => {
  const central = (version: string) => `<Project><ItemGroup><PackageVersion Include = "TUnit" Version = "${version}" /></ItemGroup></Project>`;
  const project = '<Project><ItemGroup><PackageReference Include = "TUnit" /></ItemGroup></Project>';
  const result = dispatchInspection({ files: [
    { path: 'Directory.Packages.props', text: central('1.83.8') },
    { path: 'Sample/Directory.Packages.props', text: central('1.2.11') },
    { path: 'Sample/Tests/Tests.csproj', text: project },
    { path: 'Tests/Tests.csproj', text: project },
    { path: 'Tests/Conditional.csproj', text: project.replace('<ItemGroup>', '<ItemGroup Condition="x">') },
  ] });
  expect(result).toMatchObject({ ok: true, projects: [
    { path: 'Sample/Tests/Tests.csproj', status: 'supported', version: '1.2.11' },
    { path: 'Tests/Conditional.csproj', status: 'ambiguous', version: null },
    { path: 'Tests/Tests.csproj', status: 'supported', version: '1.83.8' },
  ] });
});

it('distinguishes a workspace lock resolution from a manifest range', () => {
  const manifest = JSON.stringify({ devDependencies: { vitest: '^5.0.0' }, scripts: { test: 'bun test:unit', 'test:unit': 'vitest run' } });
  const files = [
    { path: 'packages/@demo app/package.json', text: manifest },
    { path: 'package-lock.json', text: JSON.stringify({ packages: {
      'node_modules/vitest': { version: '4.1.12' },
      'packages/@demo app/node_modules/vitest': { version: '5.1.0' },
    } }) },
  ];
  expect(dispatchInspection({ files })).toMatchObject({ ok: true, projects: [
    { version: '5.1.0', status: 'supported', commands: ['bun test:unit', 'vitest run'] },
  ] });
  expect(dispatchInspection({ files: files.slice(0, 1) })).toMatchObject({ ok: true, projects: [
    { version: null, status: 'ambiguous' },
  ] });
});

it('rejects metadata traversal paths and duplicate entries', () => {
  expect(dispatchInspection({ files: [{ path: '../package.json', text: '{}' }] })).toMatchObject({ ok: false });
  const project = { path: 'package.json', text: '{}' };
  expect(dispatchInspection({ files: [project, project] })).toMatchObject({ ok: false });
});

it('reports an oversized lockfile as unresolved instead of failing the inspection', async () => {
  const root = await repository({ 'package.json': vitestManifest, 'package-lock.json': ' '.repeat(1_000_001) });
  try {
    const { exit, stdout } = await cli(['inspect', '--root', root, '--json']);
    expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, projects: [{ path: 'package.json', status: 'ambiguous', version: null }] });
  } finally {
    await rmrfAsync(root);
  }
}, 20_000);

it('reads only the selected project and its parent folders', async () => {
  const lock = JSON.stringify({ packages: { 'packages/a/node_modules/vitest': { version: '4.1.12' } } });
  const root = await repository({
    'package-lock.json': lock,
    'packages/a/package.json': vitestManifest,
    'packages/b/package.json': vitestManifest,
    'packages/b/package-lock.json': ' '.repeat(900_000),
    'packages/c/package-lock.json': ' '.repeat(900_000),
  });
  try {
    const files = await collectMetadata(root, 'packages/a/package.json');
    expect(files.map(({ path }) => path).sort()).toEqual(['package-lock.json', 'packages/a/package.json']);
    const whole = await cli(['inspect', '--root', root, '--json']);
    expect(JSON.parse(whole.stdout).error.message).toMatch(/--project/);
    const scoped = await cli(['inspect', '--root', root, '--project', 'packages/a/package.json', '--json']);
    expect(JSON.parse(scoped.stdout)).toMatchObject({ ok: true, projects: [{ path: 'packages/a/package.json', version: '4.1.12' }] });
  } finally {
    await rmrfAsync(root);
  }
}, 20_000);

it('asks for a directory when the inferred project folder is not a portable scaffold path', async () => {
  const lock = JSON.stringify({ packages: { 'packages/@demo app/node_modules/vitest': { version: '4.1.12' } } });
  const root = await repository({ 'package-lock.json': lock, 'packages/@demo app/package.json': vitestManifest });
  const previous = process.cwd();
  process.chdir(root);
  try {
    const refused = await cli(['init', 'Example', '--inspect-project', 'packages/@demo app/package.json', '--json']);
    expect(refused.exit).not.toBe(0);
    expect(JSON.parse(refused.stdout).error.message).toMatch(/--directory/);
    const accepted = await cli(['init', 'Example', '--inspect-project', 'packages/@demo app/package.json', '--directory', 'packages/demo/tests', '--json']);
    expect(accepted.exit).toBe(0);
  } finally {
    process.chdir(previous);
    await rmrfAsync(root);
  }
}, 20_000);
