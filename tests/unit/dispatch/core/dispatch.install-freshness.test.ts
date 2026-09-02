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

/**
 * P05-04 — install freshness gating THROUGH THE REAL DISPATCH CHOKEPOINT.
 *
 * These tests do NOT call `verifyInstallFreshness` / `evaluateInstallFreshness`
 * directly. They drive a real mutating action (`exarchos_workflow.init`)
 * through `dispatch()` with the gate wired in production mode — real
 * filesystem, real `process.env` (installed posture via `EXARCHOS_PLUGIN_ROOT`)
 * — and assert that each stale dimension surfaces as an
 * `INSTALL_FRESHNESS_MISMATCH` ToolResult BEFORE the handler runs.
 */

const MUTATING_TOOL = 'exarchos_workflow';
const MUTATING_ARGS = { action: 'init', featureId: 'p05-freshness', workflowType: 'feature' };

let root: string; // temp "plugin root" (installed layout)
let cacheDir: string; // temp cache dir
let stateDir: string; // temp state dir (event store only — the lock no longer lives here)
let installDir: string; // temp install-identity dir (holds the TOFU lock)
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
 * Record the current on-disk state as the expected lock (a coherent install).
 *
 * The lock is keyed to the INSTALLATION, not the state dir, so freshness stays
 * invariant under WORKFLOW_STATE_DIR. `EXARCHOS_INSTALL_STATE_DIR` redirects it
 * into the temp tree here — without it the gate would write to the real `~`.
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

beforeEach(async () => {
  resetInstallFreshnessGateForTest();
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p05-freshness-'));
  root = path.join(base, 'plugin');
  cacheDir = path.join(base, 'cache');
  stateDir = path.join(base, 'state');
  installDir = path.join(base, 'install');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  // Installed posture, deterministically, via env — the gate reads process.env.
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

  it('first run with NO recorded lock BOOTSTRAPS (records, does not block)', async () => {
    seedCoherentInstall();
    expect(fs.existsSync(lockPath())).toBe(false);
    const result = await dispatch(MUTATING_TOOL, MUTATING_ARGS, ctx());
    expect(result.error?.code).not.toBe('INSTALL_FRESHNESS_MISMATCH');
    // The gate recorded the lock so subsequent runs have a baseline.
    expect(fs.existsSync(lockPath())).toBe(true);
  });

  it('a read-only action is exempt even when the install is stale', async () => {
    seedCoherentInstall();
    recordCoherentLock();
    // Corrupt the binary dimension on disk — a mutating action would block…
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    // …but `get` is read-only and must remain available for diagnosis.
    const result = await dispatch(
      MUTATING_TOOL,
      { action: 'get', featureId: 'p05-freshness' },
      ctx(),
    );
    expect(result.error?.code).not.toBe('INSTALL_FRESHNESS_MISMATCH');
  });
});

describe('P05-04 dispatch chokepoint — each seeded mismatch blocks before execution', () => {
  async function expectBlockedOnDimension(mutate: () => void, dimension: string): Promise<void> {
    seedCoherentInstall();
    recordCoherentLock();
    mutate(); // diverge exactly one on-disk dimension AFTER recording the lock
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
