import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'node:path';

// Mock child_process at module level to intercept execSync used by resolveStateDir
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => {
    throw new Error('fatal: not a git repository');
  }),
}));

// Import AFTER mock is registered so the module picks up the mock
import { resolveStateDir } from '../../workflow/state-store.js';

describe('resolveStateDir fallback', () => {
  const originalEnv = process.env.WORKFLOW_STATE_DIR;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.WORKFLOW_STATE_DIR = originalEnv;
    } else {
      delete process.env.WORKFLOW_STATE_DIR;
    }
  });

  it('should fall back to cwd-based path when git command fails', () => {
    delete process.env.WORKFLOW_STATE_DIR;

    const dir = resolveStateDir();
    expect(dir).toBe(path.join(process.cwd(), 'docs', 'workflow-state'));
  });

  it('should still prefer WORKFLOW_STATE_DIR env var even when git fails', () => {
    process.env.WORKFLOW_STATE_DIR = '/custom/state-dir';

    const dir = resolveStateDir();
    expect(dir).toBe('/custom/state-dir');
  });
});
