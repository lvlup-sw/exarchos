import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import os from 'node:os';

import { resolveStateDir } from '../../workflow/state-store.js';

describe('resolveStateDir fallback', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
    vi.stubEnv('WORKFLOW_STATE_DIR', '');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '');
    vi.stubEnv('XDG_STATE_HOME', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('should fall back to ~/.exarchos/state when no env vars are set', () => {
    const dir = resolveStateDir();
    expect(dir).toBe('/home/testuser/.exarchos/state');
  });

  it('should fall back to ~/.claude/workflow-state in plugin mode', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/some/path');
    const dir = resolveStateDir();
    expect(dir).toBe('/home/testuser/.claude/workflow-state');
  });

  it('should prefer WORKFLOW_STATE_DIR env var', () => {
    vi.stubEnv('WORKFLOW_STATE_DIR', '/custom/state-dir');
    const dir = resolveStateDir();
    expect(dir).toBe('/custom/state-dir');
  });
});
