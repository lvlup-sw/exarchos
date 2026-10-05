/**
 * Tests the install freshness gate through the real `dispatch()` chokepoint.
 * Each test sends a real action through `dispatch()`, on a real filesystem and
 * with the installed posture set in `process.env`. No test calls the freshness
 * functions directly. A stale dimension must block a mutating action with
 * `INSTALL_FRESHNESS_MISMATCH`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { dispatch } from '../../../../src/dispatch/core/dispatch.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import {
  collectInstallIdentity,
  writeRecordedIdentity,
  installIdentityLockPath,
  CACHE_DESCRIPTOR_FILENAME,
} from '../../../../src/install/collect-identity.js';
import { resetInstallFreshnessGateForTest } from '../../../../src/install/freshness-gate.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const MUTATING_TOOL = 'exarchos_workflow';
const MUTATING_ARGS = { action: 'init', featureId: 'p05-freshness', workflowType: 'feature' };

/** The temp plugin root, in the installed layout. */
let root: string;
let cacheDir: string;
/** Holds the event store only. The lock is not in this directory. */
let stateDir: string;
/** The temp install-identity directory, which holds the lock. */
let installDir: string;
let eventStore: EventStore;

function seedCoherentInstall(overrides?: Partial<{ pkg: string; manifest: string; skill: string; cache: string }>): void {
  const pkg = overrides?.pkg ?? JSON.stringify({ name: 'exarchos', version: '2.11.0' });
  const manifest = overrides?.manifest ?? JSON.stringify({ name: 'exarchos', commands: ['wf'] });
  const skill = overrides?.skill ?? '# Skill A\nbody\n';
  const cache = overrides?.cache ?? JSON.stringify({ owner: 'exarchos@2.11.0', format: 1 });

  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'claude', 'skill-a'), { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  fs.writeFileSync(path.join(root, 'package.json'), pkg);
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), manifest);
  fs.writeFileSync(path.join(root, 'skills', 'claude', 'skill-a', 'SKILL.md'), skill);
  fs.writeFileSync(path.join(cacheDir, CACHE_DESCRIPTOR_FILENAME), cache);
}

/**
 * Records the current on-disk state as the expected lock. The lock belongs to
 * the installation, not to the state directory. `EXARCHOS_INSTALL_STATE_DIR`
 * redirects the lock into the temp tree, away from the real home directory.
 */
function recordCoherentLock(): void {
  writeRecordedIdentity(root, collectInstallIdentity(root));
}

function lockPath(): string {
  return installIdentityLockPath(root);
}

function ctx(): DispatchContext {
  return { stateDir, eventStore, enableTelemetry: false };
}

/** The env stubs set the installed posture, because the gate reads `process.env`. */
beforeEach(async () => {
  resetInstallFreshnessGateForTest();
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p05-freshness-'));
  root = path.join(base, 'plugin');
  cacheDir = path.join(base, 'cache');
  stateDir = path.join(base, 'state');
  installDir = path.join(base, 'install');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  vi.stubEnv('EXARCHOS_PLUGIN_ROOT', root);
  vi.stubEnv('EXARCHOS_CACHE_DIR', cacheDir);
  vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
  vi.stubEnv('EXARCHOS_INSTALL_STATE_DIR', installDir);
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
});

afterEach(async () => {
  resetInstallFreshnessGateForTest();
  vi.unstubAllEnvs();
  const base = path.dirname(root);
  await rmrfAsync(base);
});

describe('P05-04 dispatch chokepoint — matching install proceeds', () => {
  it('a coherent install is NOT freshness-blocked (handler runs)', async () => {
    seedCoherentInstall();
    recordCoherentLock();
    const result = await dispatch(MUTATING_TOOL, MUTATING_ARGS, ctx());
    expect(result.error?.code).not.toBe('INSTALL_FRESHNESS_MISMATCH');
  });

  /** The gate records the lock on the first run, so later runs have a baseline. */
  it('first run with NO recorded lock BOOTSTRAPS (records, does not block)', async () => {
    seedCoherentInstall();
    expect(fs.existsSync(lockPath())).toBe(false);
    const result = await dispatch(MUTATING_TOOL, MUTATING_ARGS, ctx());
    expect(result.error?.code).not.toBe('INSTALL_FRESHNESS_MISMATCH');
    expect(fs.existsSync(lockPath())).toBe(true);
  });

  /**
   * The new `package.json` makes the binary dimension stale. `get` is read-only
   * and must stay available for diagnosis.
   */
  it('a read-only action is exempt even when the install is stale', async () => {
    seedCoherentInstall();
    recordCoherentLock();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    const result = await dispatch(
      MUTATING_TOOL,
      { action: 'get', featureId: 'p05-freshness' },
      ctx(),
    );
    expect(result.error?.code).not.toBe('INSTALL_FRESHNESS_MISMATCH');
  });
});

/** Each test changes one on-disk dimension after it records the lock. */
describe('P05-04 dispatch chokepoint — each seeded mismatch blocks before execution', () => {
  async function expectBlockedOnDimension(mutate: () => void, dimension: string): Promise<void> {
    seedCoherentInstall();
    recordCoherentLock();
    mutate();
    const result = await dispatch(MUTATING_TOOL, MUTATING_ARGS, ctx());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INSTALL_FRESHNESS_MISMATCH');
    expect(result.error?.message).toContain(dimension);
  }

  it('BINARY mismatch blocks the mutating action', async () => {
    await expectBlockedOnDimension(
      () => fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' })),
      'binary',
    );
  });

  it('PLUGIN mismatch blocks the mutating action', async () => {
    await expectBlockedOnDimension(
      () => fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'stale-plugin' })),
      'plugin',
    );
  });

  it('SKILL mismatch blocks the mutating action', async () => {
    await expectBlockedOnDimension(
      () => fs.writeFileSync(path.join(root, 'skills', 'claude', 'skill-a', 'SKILL.md'), '# Skill A\nSTALE rendered body\n'),
      'skill',
    );
  });

  it('CACHE mismatch blocks the mutating action', async () => {
    await expectBlockedOnDimension(
      () => fs.writeFileSync(path.join(cacheDir, CACHE_DESCRIPTOR_FILENAME), JSON.stringify({ owner: 'exarchos@1.0.0', format: 1 })),
      'cache',
    );
  });
});
