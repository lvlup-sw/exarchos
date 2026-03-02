import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { handleRunScript } from './run-script.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../utils/paths.js', () => ({
  resolveScript: vi.fn((name: string) => `/resolved/scripts/${name}`),
}));

// Import the mocked resolveScript so we can assert on it
import { resolveScript } from '../utils/paths.js';

describe('handleRunScript', () => {
  const stateDir = '/tmp/test-state';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('RunScript_ValidScript_ReturnsStructuredResult', async () => {
    vi.mocked(execFileSync).mockReturnValue('All links valid');

    const result = await handleRunScript(
      { script: 'verify-doc-links.sh', args: ['--docs-dir', 'docs/'] },
      stateDir,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      passed: true,
      exitCode: 0,
      stdout: 'All links valid',
    });
  });

  it('RunScript_ScriptFails_ReturnsFailure', async () => {
    const error = new Error('Process exited with code 1') as Error & {
      status: number;
      stdout: string;
      stderr: string;
    };
    error.status = 1;
    error.stdout = '2 broken links found';
    error.stderr = '';
    vi.mocked(execFileSync).mockImplementation(() => {
      throw error;
    });

    const result = await handleRunScript(
      { script: 'verify-doc-links.sh' },
      stateDir,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      passed: false,
      exitCode: 1,
    });
  });

  it('RunScript_PathTraversal_RejectsUnsafePaths', async () => {
    const result = await handleRunScript(
      { script: '../../../etc/passwd' },
      stateDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('RunScript_AbsolutePath_RejectsUnsafePaths', async () => {
    const result = await handleRunScript(
      { script: '/etc/passwd' },
      stateDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('RunScript_UsesResolveScript_ForPathResolution', async () => {
    vi.mocked(execFileSync).mockReturnValue('ok');

    await handleRunScript({ script: 'foo.sh' }, stateDir);

    expect(resolveScript).toHaveBeenCalledWith('foo.sh');
  });
});
