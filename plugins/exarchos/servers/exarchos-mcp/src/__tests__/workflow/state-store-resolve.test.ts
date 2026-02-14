import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'node:os';
import * as path from 'node:path';

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

  it('should fall back to ~/.claude/workflow-state when env var is not set', () => {
    delete process.env.WORKFLOW_STATE_DIR;

    const dir = resolveStateDir();
    expect(dir).toBe(path.join(homedir(), '.claude', 'workflow-state'));
  });

  it('should prefer WORKFLOW_STATE_DIR env var', () => {
    process.env.WORKFLOW_STATE_DIR = '/custom/state-dir';

    const dir = resolveStateDir();
    expect(dir).toBe('/custom/state-dir');
  });
});
