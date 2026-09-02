/**
 * The hermetic install-identity setup file: one scratch directory per vitest
 * run, shared by every file of that run, swept once its host process is gone.
 *
 * @oracle-sources: ./hermetic-install-identity.ts
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMainThread } from 'node:worker_threads';
import {
  INSTALL_IDENTITY_SCRATCH_PREFIX,
  sweepOrphanInstallIdentityDirs,
} from './hermetic-install-identity.js';

describe('hermetic install identity scratch directory', () => {
  it('InstallIdentityScratch_IsKeyedOnThisRunsHostProcess', () => {
    const dir = process.env['EXARCHOS_INSTALL_STATE_DIR'];
    const host = isMainThread ? process.ppid : process.pid;

    expect(dir).toBeDefined();
    expect(path.basename(dir ?? '')).toBe(`${INSTALL_IDENTITY_SCRATCH_PREFIX}${host}`);
    expect(fs.existsSync(dir ?? '')).toBe(true);
  });

  it('InstallIdentitySweep_RemovesADeadRunsDirectoryAndKeepsLiveOnes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-identity-sweep-'));
    try {
      // A pid that provably existed and provably no longer does: a child that
      // has already exited. This is the shape of a finished run's directory.
      const exited = spawnSync(process.execPath, ['-e', '0']);
      expect(exited.status).toBe(0);
      const dead = `${INSTALL_IDENTITY_SCRATCH_PREFIX}${exited.pid}`;
      const live = `${INSTALL_IDENTITY_SCRATCH_PREFIX}${process.pid}`;
      const ours = `${INSTALL_IDENTITY_SCRATCH_PREFIX}999999999`;
      const unrelated = 'exarchos-test-install-identity';
      const randomSuffix = `${INSTALL_IDENTITY_SCRATCH_PREFIX}3TLy7g`;
      for (const name of [dead, live, ours, unrelated, randomSuffix]) {
        fs.mkdirSync(path.join(tmp, name));
        fs.writeFileSync(path.join(tmp, name, 'lock.json'), '{}');
      }

      const removed = sweepOrphanInstallIdentityDirs(tmp, ours);

      expect(removed).toEqual([dead]);
      expect(fs.existsSync(path.join(tmp, dead))).toBe(false);
      expect(fs.existsSync(path.join(tmp, live)), 'a live run\'s directory was swept').toBe(true);
      expect(fs.existsSync(path.join(tmp, ours)), 'the current run\'s directory was swept').toBe(true);
      expect(fs.existsSync(path.join(tmp, unrelated)), 'a non-scratch entry was swept').toBe(true);
      expect(
        fs.existsSync(path.join(tmp, randomSuffix)),
        'a non-numeric suffix was parsed as a pid and swept',
      ).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
