import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installFreshness } from '../../../../../src/verbs/doctor/checks/install-freshness.js';
import { makeStubProbes } from '../../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import {
  writeRecordedIdentity,
  collectInstallIdentity,
  installIdentityLockPath,
  CACHE_DESCRIPTOR_FILENAME,
} from '../../../../../src/install/collect-identity.js';
import type { DoctorProbes } from '../../../../../src/verbs/doctor/probes.js';

let base: string;
let root: string;
let cacheDir: string;
let stateDir: string;
let installDir: string; // holds the identity lock — keyed to the install, not the store

function seedInstall(overrides?: Partial<{ pkg: string }>): void {
  const pkg = overrides?.pkg ?? JSON.stringify({ name: 'exarchos', version: '2.11.0' });
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'claude', 'skill-a'), { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), pkg);
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'exarchos' }));
  fs.writeFileSync(path.join(root, 'skills', 'claude', 'skill-a', 'SKILL.md'), '# A\nbody\n');
  fs.writeFileSync(path.join(cacheDir, CACHE_DESCRIPTOR_FILENAME), JSON.stringify({ owner: 'exarchos@2.11.0' }));
}

/** Installed-posture probes, driven purely by injected env (no fs fallback). */
function installedProbes(): DoctorProbes {
  return makeStubProbes({ env: lockEnv(), stateDir });
}

/**
 * Env for an installed posture with the identity lock redirected into the temp
 * tree. `EXARCHOS_INSTALL_STATE_DIR` is load-bearing for hermeticity: the lock
 * is keyed to the INSTALLATION rather than the state dir, so without it these
 * tests would read and write the real home directory.
 */
function lockEnv(): Record<string, string> {
  return {
    EXARCHOS_PLUGIN_ROOT: root,
    EXARCHOS_CACHE_DIR: cacheDir,
    EXARCHOS_INSTALL_STATE_DIR: installDir,
  };
}

/** Record the lock for the seeded install, in the temp install dir. */
function recordLock(): void {
  writeRecordedIdentity(root, collectInstallIdentity(root, { env: lockEnv() }), { env: lockEnv() });
}

const signal = new AbortController().signal;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-freshness-'));
  root = path.join(base, 'plugin');
  cacheDir = path.join(base, 'cache');
  stateDir = path.join(base, 'state');
  installDir = path.join(base, 'install');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('doctor install-freshness check', () => {
  it('reports Pass for a fresh install matching the recorded identity', async () => {
    seedInstall();
    recordLock();
    const r = await installFreshness(installedProbes(), signal);
    expect(r.status).toBe('Pass');
    expect(r.name).toBe('install-freshness');
    expect(r.category).toBe('plugin');
    expect(r.message).toContain('fresh');
  });

  it('reports Warning naming the stale dimension, with a fix', async () => {
    seedInstall();
    recordLock();
    // Upgrade the binary on disk after recording — binary dimension diverges.
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    const r = await installFreshness(installedProbes(), signal);
    expect(r.status).toBe('Warning');
    expect(r.message).toContain('binary');
    expect(r.fix).toBeDefined();
    expect(r.fix!.length).toBeGreaterThan(0);
  });

  it('reports Pass (no baseline yet) when installed but no lock recorded', async () => {
    seedInstall();
    const r = await installFreshness(installedProbes(), signal);
    expect(r.status).toBe('Pass');
    expect(r.message).toMatch(/no recorded install identity|baseline/);
  });

  it('is read-only — does NOT write a bootstrap lock (unlike the dispatch gate)', async () => {
    seedInstall();
    await installFreshness(installedProbes(), signal);
    expect(fs.existsSync(installIdentityLockPath(root, { env: lockEnv() }))).toBe(false);
  });

  it('reports Pass with no plugin-root env (source checkout is not a corrupt install)', async () => {
    const r = await installFreshness(
      makeStubProbes({ env: { EXARCHOS_INSTALL_STATE_DIR: installDir }, stateDir }),
      signal,
    );
    // Either dev-checkout (no cache) or installed-but-no-lock — both are Pass.
    expect(r.status).toBe('Pass');
  });
});
