import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleVersionCheck } from './version.js';

// ─── Test Suite ─────────────────────────────────────────────────────────────

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
    await fs.rm(tmpDir, { recursive: true, force: true });
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
    // Arrange — binary >= declared minBinaryVersion.
    await writePluginJson(tmpDir, {
      name: 'exarchos',
      metadata: { compat: { minBinaryVersion: '2.0.0' } },
    });

    // Act
    const exitCode = await handleVersionCheck({
      pluginRoot: tmpDir,
      binaryVersion: '2.9.0',
    });

    // Assert — exit 0 signals "ok" to CI.
    expect(exitCode).toBe(0);
  });

  it('VersionCheck_PluginRootIncompatible_ExitsNonZeroWithMessage', async () => {
    // Arrange — declared min is newer than the running binary.
    await writePluginJson(tmpDir, {
      name: 'exarchos',
      metadata: { compat: { minBinaryVersion: '5.0.0' } },
    });

    // Act
    const exitCode = await handleVersionCheck({
      pluginRoot: tmpDir,
      binaryVersion: '2.9.0',
    });

    // Assert — non-zero exit + stderr names the required version.
    expect(exitCode).not.toBe(0);
    const stderr = capturedStderr();
    expect(stderr).toContain('5.0.0');
  });

  it('VersionCheck_PluginRootMissingMetadata_ExitsZeroWithWarning', async () => {
    // Arrange — plugin.json exists but has no metadata.compat.
    await writePluginJson(tmpDir, { name: 'exarchos', version: '2.8.3' });

    // Act
    const exitCode = await handleVersionCheck({
      pluginRoot: tmpDir,
      binaryVersion: '2.9.0',
    });

    // Assert — missing metadata is a non-fatal advisory, not a failure.
    expect(exitCode).toBe(0);
    const stderr = capturedStderr();
    // Warning should mention that compat metadata is absent.
    expect(stderr.toLowerCase()).toContain('compat');
  });

  it('VersionCheck_PluginRootMissing_ExitsZeroWithWarning', async () => {
    // Arrange — plugin root path does not exist.
    const missingRoot = path.join(tmpDir, 'does-not-exist');

    // Act
    const exitCode = await handleVersionCheck({
      pluginRoot: missingRoot,
      binaryVersion: '2.9.0',
    });

    // Assert — still non-fatal.
    expect(exitCode).toBe(0);
  });
});
