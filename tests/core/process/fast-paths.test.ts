/**
 * Pins the output and exit code of each fast path of the compiled binary.
 *
 * `main()` in `src/index.ts` answers these commands before it opens the store or builds the CLI:
 * the version forms, the hook commands, `run-tests` and `verify-worktree-boundary`. Claude Code
 * runs the hooks on every session event and every subagent write, so a change to the entry must
 * keep these answers. Each test spawns the binary that `ensureBinaryBuilt` builds from this tree.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { spawnAsync } from '../../../tools/test-helpers/spawn.js';
import { ensureBinaryBuilt, findRepoRoot } from './_helpers.js';

const REPO_ROOT = findRepoRoot(fileURLToPath(new URL('.', import.meta.url)));

let binaryPath: string;
let scratch: string;
let stateDir: string;

beforeAll(async () => {
  ({ binaryPath } = await ensureBinaryBuilt(REPO_ROOT));
  scratch = makeTempDir('fast-paths-');
  stateDir = join(scratch, 'state');
  mkdirSync(stateDir, { recursive: true });
}, 120_000);

afterAll(async () => {
  await rmrfAsync(scratch);
});

/** Runs the binary with an isolated state directory, and returns its exit code and output. */
async function run(args: string[], options: { input?: string; cwd?: string } = {}) {
  const result = await spawnAsync(binaryPath, args, {
    cwd: options.cwd ?? scratch,
    env: { ...process.env, WORKFLOW_STATE_DIR: stateDir },
    input: options.input ?? '',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

/** The `version` field of the root `package.json`, which the build embeds in the binary. */
function packageVersion(): string {
  return (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
}

describe('fast paths of the compiled binary', () => {
  /** `--version`, `-V` and a bare `version` all print the package version. */
  it('VersionForms_CompiledBinary_PrintPackageVersion', async () => {
    for (const args of [['--version'], ['-V'], ['version']]) {
      const result = await run(args);
      expect(result.status, args.join(' ')).toBe(0);
      expect(result.stdout, args.join(' ')).toBe(packageVersion());
    }
  });

  /** `session-start` with an empty payload lets the session continue. */
  it('SessionStartHook_EmptyPayload_ContinuesWithExitZero', async () => {
    const result = await run(['session-start'], { input: '{}' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  });

  /** `subagent-stop` with an empty payload lets the session continue. */
  it('SubagentStopHook_EmptyPayload_ContinuesWithExitZero', async () => {
    const result = await run(['subagent-stop'], { input: '{}' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  });

  /** `session-end` without a session id reports the stable error code and exits 1. */
  it('SessionEndHook_NoSessionId_ReportsMissingSessionId', async () => {
    const result = await run(['session-end'], { input: '{}' });
    expect(result.status).toBe(1);
    expect((JSON.parse(result.stdout) as { error: { code: string } }).error.code).toBe('MISSING_SESSION_ID');
  });

  /** `run-tests` runs the test command of `.exarchos.yml` and returns its exit code. */
  it('RunTests_FixtureCommand_ReturnsItsExitCode', async () => {
    const project = join(scratch, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'exit3.mjs'), 'process.exit(3);\n');
    writeFileSync(join(project, '.exarchos.yml'), 'test: node exit3.mjs\n');
    const result = await run(['run-tests'], { cwd: project });
    expect(result.status).toBe(3);
  });

  /** The PreToolUse guard blocks a write outside the worktree with exit 2. */
  it('WorktreeBoundaryHook_WriteOutsideWorktree_ExitsTwo', async () => {
    const repo = join(scratch, 'repo-outside');
    mkdirSync(repo, { recursive: true });
    await spawnAsync('git', ['init', '-q'], { cwd: repo });
    const payload = { cwd: repo, tool_input: { file_path: join(scratch, 'elsewhere.txt') } };
    const result = await run(['verify-worktree-boundary'], { input: JSON.stringify(payload) });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('BLOCKED');
  });

  /** The PreToolUse guard allows a write inside the worktree with exit 0. */
  it('WorktreeBoundaryHook_WriteInsideWorktree_ExitsZero', async () => {
    const repo = join(scratch, 'repo-inside');
    mkdirSync(repo, { recursive: true });
    await spawnAsync('git', ['init', '-q'], { cwd: repo });
    const payload = { cwd: repo, tool_input: { file_path: join(repo, 'inside.txt') } };
    const result = await run(['verify-worktree-boundary'], { input: JSON.stringify(payload) });
    expect(result.status).toBe(0);
  });
});
