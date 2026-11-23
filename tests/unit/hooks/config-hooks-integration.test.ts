import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConfigHookRunner } from '../../../src/hooks/config-hooks.js';
import {
  bindProjectHooks,
  HOOK_TRUST_FILENAME,
  type BoundProjectHooks,
} from '../../../src/hooks/hook-trust.js';
import { DEFAULTS } from '../../../src/config/resolve.js';
import type { ResolvedProjectConfig } from '../../../src/config/resolve.js';
import { makeTempDir, rmrf } from '../../../tools/test-helpers/temp-dir.js';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  })),
}));

import { spawn } from 'child_process';

const dirs: string[] = [];

/** Binds `hooks` for a scratch project after the test writes a matching trust record. */
function trusted(hooks: ResolvedProjectConfig['hooks']): BoundProjectHooks {
  const stateDir = makeTempDir('hook-integration-state-');
  const projectRoot = makeTempDir('hook-integration-project-');
  dirs.push(stateDir, projectRoot);
  const first = bindProjectHooks({ stateDir, projectRoot, hooks });
  if (first.kind !== 'untrusted') throw new Error(`expected untrusted, got ${first.kind}`);
  writeFileSync(
    join(stateDir, HOOK_TRUST_FILENAME),
    JSON.stringify({ projects: { [first.projectRoot]: { hooksDigest: first.digest } } }),
  );
  const second = bindProjectHooks({ stateDir, projectRoot, hooks });
  if (second.kind !== 'trusted') throw new Error(`expected trusted, got ${second.kind}`);
  return second.hooks;
}

describe('Config Hook Integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) rmrf(dir);
  });

  /** The test calls the runner directly with a `workflow.transition` event. It has no EventStore. */
  it('EventStore_Append_TriggersConfigHook', async () => {
    const runner = createConfigHookRunner(trusted({
      on: { 'workflow.transition': [{ command: './notify.sh', timeout: 10000 }] },
    }));

    const event = {
      type: 'workflow.transition',
      data: { phase: 'review', from: 'delegate', workflowType: 'feature' },
      featureId: 'ext-points',
      timestamp: new Date().toISOString(),
    };

    await runner(event);
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      './notify.sh',
      [],
      expect.objectContaining({ shell: false }),
    );
  });

  /** `DEFAULTS` configures no hooks. */
  it('EventStore_Append_NoProjectConfig_NoHooks', async () => {
    const stateDir = makeTempDir('hook-integration-state-');
    dirs.push(stateDir);
    const binding = bindProjectHooks({ stateDir, projectRoot: stateDir, hooks: DEFAULTS.hooks });
    const runner = createConfigHookRunner(binding.hooks);

    await runner({
      type: 'workflow.transition',
      data: {},
      featureId: 'test',
      timestamp: '',
    });

    expect(binding.kind).toBe('none');
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  /** The test calls the runner one time for each event. It has no batch append. */
  it('EventStore_BatchAppend_TriggersHooksForEach', async () => {
    const runner = createConfigHookRunner(trusted({
      on: { 'task.completed': [{ command: 'echo done', timeout: 30000 }] },
    }));

    const events = [
      { type: 'task.completed', data: { taskId: '1' }, featureId: 'f', timestamp: '' },
      { type: 'task.completed', data: { taskId: '2' }, featureId: 'f', timestamp: '' },
      { type: 'task.completed', data: { taskId: '3' }, featureId: 'f', timestamp: '' },
    ];

    for (const event of events) {
      await runner(event);
    }

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(3);
  });
});
