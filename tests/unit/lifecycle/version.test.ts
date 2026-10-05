import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleVersionCheck } from '../../../src/lifecycle/version.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('version subcommand', () => {
  let tmpDir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'version-cmd-test-'));
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    await rmrfAsync(tmpDir);
  });

  async function writePluginJson(root: string, body: unknown): Promise<void> {
    const dir = path.join(root, '.claude-plugin');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(body), 'utf-8');
  }

  function capturedStderr(): string {
    return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  it('VersionCheck_PluginRootCompatible_ExitsZero', async () => {
    await writePluginJson(tmpDir, {
      name: 'exarchos',
      metadata: { compat: { minBinaryVersion: '2.0.0' } },
    });

    const exitCode = await handleVersionCheck({
      pluginRoot: tmpDir,
      binaryVersion: '2.9.0',
    });

    expect(exitCode).toBe(0);
  });

  /** The declared minimum is newer than the binary. Stderr must name the required version. */
  it('VersionCheck_PluginRootIncompatible_ExitsNonZeroWithMessage', async () => {
    await writePluginJson(tmpDir, {
      name: 'exarchos',
      metadata: { compat: { minBinaryVersion: '5.0.0' } },
    });

    const exitCode = await handleVersionCheck({
      pluginRoot: tmpDir,
      binaryVersion: '2.9.0',
    });

    expect(exitCode).not.toBe(0);
    const stderr = capturedStderr();
    expect(stderr).toContain('5.0.0');
  });

  /**
   * `plugin.json` exists but has no `metadata.compat`. That is an advisory, not a failure.
   * The warning must name `compat`.
   */
  it('VersionCheck_PluginRootMissingMetadata_ExitsZeroWithWarning', async () => {
    await writePluginJson(tmpDir, { name: 'exarchos', version: '2.8.3' });

    const exitCode = await handleVersionCheck({
      pluginRoot: tmpDir,
      binaryVersion: '2.9.0',
    });

    expect(exitCode).toBe(0);
    const stderr = capturedStderr();
    expect(stderr.toLowerCase()).toContain('compat');
  });

  it('VersionCheck_PluginRootMissing_ExitsZeroWithWarning', async () => {
    const missingRoot = path.join(tmpDir, 'does-not-exist');

    const exitCode = await handleVersionCheck({
      pluginRoot: missingRoot,
      binaryVersion: '2.9.0',
    });

    expect(exitCode).toBe(0);
  });
});
