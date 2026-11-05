/**
 * The label of the worktree baseline comes from the registry. The test command of a package-manager profile or of a
 * toolchain row takes the `projectType` of that profile or row. A refusal names the markers of the registry.
 *
 * Each case writes a real root in a temporary directory. It mocks `node:child_process`, as the handler suite does,
 * so no git and no test command runs.
 *
 * @oracle-sources: ../../../../src/config/toolchains.ts, the seven labels of the gate at the base commit written here as literals
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { BUILTIN_TOOLCHAINS } from '../../../../src/config/toolchains.js';
import { handleVerifyWorktreeBaseline } from '../../../../src/verbs/gates/verify-worktree-baseline.js';
import { makeTempDir, rmrf } from '../../../../tools/test-helpers/temp-dir.js';

/** The state directory of the handler. The handler does not read it. */
const STATE_DIR = '/tmp/worktree-baseline-label-state';

/** The fields of the baseline carrier that the cases read. */
interface BaselineLabel {
  readonly projectType: string;
  readonly testCommand: string;
}

/** One root of a test command that had a label before the label came from the registry. */
interface LabelledRoot {
  readonly command: string;
  readonly label: string;
  readonly files: Readonly<Record<string, string>>;
}

/** A `package.json` with one script, as the resolver reads it. */
function packageJson(scripts: Readonly<Record<string, string>>): string {
  return JSON.stringify({ scripts });
}

/** The seven test commands that had a label before, with a root that resolves to each one. */
const LABELLED_ROOTS: readonly LabelledRoot[] = [
  { command: 'npm run test:run', label: 'Node.js', files: { 'package.json': packageJson({ 'test:run': 'vitest run' }) } },
  { command: 'bun test', label: 'Node.js (bun)', files: { 'package.json': '{}', 'bun.lockb': '' } },
  { command: 'pnpm test', label: 'Node.js (pnpm)', files: { 'package.json': packageJson({ test: 'vitest run' }), 'pnpm-lock.yaml': '' } },
  { command: 'yarn test', label: 'Node.js (yarn)', files: { 'package.json': packageJson({ test: 'vitest run' }), 'yarn.lock': '' } },
  { command: 'dotnet test', label: '.NET', files: { 'App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n' } },
  { command: 'cargo test', label: 'Rust', files: { 'Cargo.toml': '[package]\nname = "app"\n' } },
  { command: 'pytest', label: 'Python', files: { 'pyproject.toml': '[project]\nname = "app"\n' } },
];

/** The temporary roots of the running case. Each case adds its roots, and the teardown deletes them. */
const roots: string[] = [];

/** Writes a root with the given files and returns its path. */
function makeRoot(files: Readonly<Record<string, string>>): string {
  const root = makeTempDir('worktree-baseline-label-');
  roots.push(root);
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content);
  return root;
}

/** Reads the label and the test command of a passing baseline carrier, with no cast. */
function baselineLabel(data: unknown): BaselineLabel {
  if (
    typeof data === 'object' &&
    data !== null &&
    'projectType' in data &&
    'testCommand' in data &&
    typeof data.projectType === 'string' &&
    typeof data.testCommand === 'string'
  ) {
    return { projectType: data.projectType, testCommand: data.testCommand };
  }
  throw new Error(`the baseline gave no label: ${JSON.stringify(data)}`);
}

/** Runs the baseline at a root and returns its label. */
async function labelAt(root: string): Promise<BaselineLabel> {
  const result = await handleVerifyWorktreeBaseline({ worktreePath: root }, STATE_DIR);
  expect(result.success, JSON.stringify(result.error)).toBe(true);
  return baselineLabel(result.data);
}

describe('the label of the worktree baseline', () => {
  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
    for (const root of roots.splice(0)) rmrf(root);
  });

  /**
   * A `go.mod` root resolves to `go test ./...`, the test command of the Go row. The killing assertion is the label `Go`.
   * Before the label came from the registry, the command had no label and got `Override`.
   */
  it('VerifyWorktreeBaseline_AGoRepository_GetsTheLabelOfItsRegistryRow', async () => {
    vi.mocked(execFileSync).mockReturnValue('ok  \texample.com/app\t0.01s\n');
    const root = makeRoot({ 'go.mod': 'module example.com/app\n\ngo 1.22\n' });

    const label = await labelAt(root);

    expect(label.testCommand).toBe('go test ./...');
    expect(label.projectType).toBe('Go');
    const run = vi.mocked(execFileSync).mock.calls.find((call) => String(call[0]).replace(/\.(?:cmd|exe)$/, '') === 'go');
    expect(run?.[1]).toEqual(['test', './...']);
  });

  /**
   * The twin of the Go case: the seven test commands that had a label before keep it.
   * A command of a toolchain row gets the `projectType` of that row.
   */
  it('VerifyWorktreeBaseline_TheLabel_ComesFromTheRegistry', async () => {
    vi.mocked(execFileSync).mockReturnValue('passed\n');

    for (const { command, label, files } of LABELLED_ROOTS) {
      const found = await labelAt(makeRoot(files));
      const row = BUILTIN_TOOLCHAINS.find((toolchain) => toolchain.commands.test === command);

      expect(found, command).toEqual({ projectType: label, testCommand: command });
      if (row !== undefined) expect(found.projectType, command).toBe(row.projectType);
    }
    expect(LABELLED_ROOTS.filter(({ command }) => BUILTIN_TOOLCHAINS.some((toolchain) => toolchain.commands.test === command))).toHaveLength(4);
  });

  /** A root with no test command is refused, and the refusal names each marker of the built-in toolchains, such as `go.mod`. */
  it('VerifyWorktreeBaseline_TheRefusal_NamesTheMarkersOfTheRegistry', async () => {
    vi.mocked(execFileSync).mockReturnValue('');
    const root = makeRoot({ 'README.md': '# app\n' });
    const markers = BUILTIN_TOOLCHAINS.flatMap((toolchain) => toolchain.markers);

    const result = await handleVerifyWorktreeBaseline({ worktreePath: root }, STATE_DIR);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_PROJECT_TYPE');
    expect(markers).toEqual(expect.arrayContaining(['package.json', 'go.mod', 'Gemfile', 'CMakeLists.txt']));
    for (const marker of markers) expect(result.error?.message, marker).toContain(marker);
  });
});
