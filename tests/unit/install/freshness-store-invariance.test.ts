// ─── #1840 — freshness is a property of the INSTALL, not of the store ────────
//
// The recorded install-identity lock was written into the WORKFLOW_STATE_DIR-
// resolved event store, so the freshness verdict was a function of which store
// the invocation happened to resolve. The same installation reported "fresh"
// under its default store and "stale or mixed" under a pinned one — and the
// gate blocked precisely the pinning an operator adopts to collapse a
// store-path divergence. There was no configuration in which a plain CLI could
// correctly write to the plugin's store.
//
// Second defect, and the sharper one: the binary version falls back to a
// sentinel when it cannot be read, and the comparison used equality, so
// unknown === unknown reported the dimension as MATCHING. `doctor` claimed all
// five dimensions matched while separately warning that two were unknown.

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';

import {
  evaluateInstallFreshness,
  resetInstallFreshnessGateForTest,
  type FreshnessGateDeps,
} from '../../../src/install/freshness-gate.js';
import {
  collectInstallIdentity,
  installIdentityLockPath,
  CACHE_DESCRIPTOR_FILENAME,
  type IdentityDeps,
} from '../../../src/install/collect-identity.js';
import { verifyInstallFreshness } from '../../../src/install/freshness-check.js';
import { resolveCacheDir, resolveInstallIdentityDir } from '../../../src/utils/paths.js';
import {
  UNKNOWN_VERSION_SENTINEL,
  type InstallIdentity,
} from '../../../src/install/install-identity.js';

const PLUGIN_ROOT = '/opt/exarchos';
const HOME = '/home/u';
const BASE_ENV = { EXARCHOS_PLUGIN_ROOT: PLUGIN_ROOT, EXARCHOS_CACHE_DIR: '/opt/cache' } as const;

function cacheDescriptorPath(): string {
  return path.join(resolveCacheDir({ env: BASE_ENV, homedir: HOME }), CACHE_DESCRIPTOR_FILENAME);
}

function coherentFiles(pkgVersion = '2.12.0-preview.4'): Map<string, string> {
  return new Map<string, string>([
    [path.join(PLUGIN_ROOT, 'package.json'), JSON.stringify({ name: 'exarchos', version: pkgVersion })],
    [path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'exarchos' })],
    [path.join(PLUGIN_ROOT, 'skills', 'claude', 'skill-a', 'SKILL.md'), '# Skill A\nbody\n'],
    [cacheDescriptorPath(), JSON.stringify({ owner: 'exarchos', format: 1 })],
  ]);
}

function seams(files: Map<string, string>): IdentityDeps {
  return {
    readFileText: (p) => files.get(p),
    readTree: (dir) => {
      const out: { path: string; content: string }[] = [];
      for (const [key, content] of files) {
        for (const pre of [`${dir}/`, `${dir}\\`]) {
          if (key.startsWith(pre)) out.push({ path: key.slice(pre.length), content });
        }
      }
      return out;
    },
    pathExists: (p) => {
      for (const key of files.keys()) {
        if (key === p || key.startsWith(`${p}/`) || key.startsWith(`${p}\\`)) return true;
      }
      return false;
    },
    writeFileText: (p, c) => { files.set(p, c); },
    mkdirp: () => {},
  };
}

/** Gate deps under a specific WORKFLOW_STATE_DIR — the variable under test. */
function depsWithStateDir(files: Map<string, string>, workflowStateDir: string): FreshnessGateDeps {
  return {
    env: { ...BASE_ENV, WORKFLOW_STATE_DIR: workflowStateDir },
    homedir: HOME,
    ...seams(files),
  };
}

beforeEach(() => resetInstallFreshnessGateForTest());

describe('Install freshness is invariant under WORKFLOW_STATE_DIR (#1840)', () => {
  it('Freshness_SameInstallTwoStores_ReportsTheSameVerdict', () => {
    const files = coherentFiles();

    // First run under store A bootstraps the TOFU lock.
    const bootstrap = evaluateInstallFreshness(depsWithStateDir(files, '/home/u/.exarchos/state'));
    expect(bootstrap.status).toBe('bootstrapped');

    // Re-evaluating under store A sees the lock and reports fresh.
    resetInstallFreshnessGateForTest();
    const underA = evaluateInstallFreshness(depsWithStateDir(files, '/home/u/.exarchos/state'));

    // The SAME installation under a DIFFERENT store must reach the SAME
    // verdict. Pre-fix this returned 'bootstrapped' (a second, independent
    // lock) or 'blocked'; the operator saw one install report two verdicts.
    resetInstallFreshnessGateForTest();
    const underB = evaluateInstallFreshness(depsWithStateDir(files, '/home/u/.claude/workflow-state'));

    expect(underA.status).toBe('fresh');
    expect(underB.status, 'freshness changed when only WORKFLOW_STATE_DIR changed').toBe(underA.status);
  });

  it('Freshness_PinningTheStore_DoesNotBlockMutations', () => {
    const files = coherentFiles();
    // Bootstrap under the CLI default store.
    evaluateInstallFreshness(depsWithStateDir(files, '/home/u/.exarchos/state'));

    // Now adopt the documented remedy for a store divergence: pin the CLI at
    // the plugin's store. That must not turn a working install into a blocked
    // one — the trap this issue reported.
    resetInstallFreshnessGateForTest();
    const pinned = evaluateInstallFreshness(depsWithStateDir(files, '/home/u/.claude/workflow-state'));
    expect(pinned.status, 'pinning the store must not block mutations').not.toBe('blocked');
  });

  it('LockPath_IsKeyedToTheInstall_NotTheStateDir', () => {
    const a = installIdentityLockPath(PLUGIN_ROOT, {
      env: { ...BASE_ENV, WORKFLOW_STATE_DIR: '/store/a' },
      homedir: HOME,
    });
    const b = installIdentityLockPath(PLUGIN_ROOT, {
      env: { ...BASE_ENV, WORKFLOW_STATE_DIR: '/store/b' },
      homedir: HOME,
    });
    expect(a).toBe(b);

    // And it must not live inside either store.
    expect(a).not.toContain('/store/a');
    expect(a).not.toContain('/store/b');
    expect(a.startsWith(resolveInstallIdentityDir({ env: BASE_ENV, homedir: HOME }))).toBe(true);

    // Two DIFFERENT installs must not share one lock.
    const other = installIdentityLockPath('/opt/exarchos-next', { env: BASE_ENV, homedir: HOME });
    expect(other).not.toBe(a);
  });
});

describe('An undetermined dimension cannot report as matching (#1840)', () => {
  function identityWithBinaryVersion(version: string): InstallIdentity {
    const files = coherentFiles(version);
    return collectInstallIdentity(PLUGIN_ROOT, { env: BASE_ENV, homedir: HOME, ...seams(files) });
  }

  it('Verify_BothVersionsUnknown_IsIndeterminateNotFresh', () => {
    // The exact reported shape: the version could not be read on either side,
    // so both carry the sentinel. Equality made this a PASS.
    const unknown = identityWithBinaryVersion(UNKNOWN_VERSION_SENTINEL);
    const result = verifyInstallFreshness(unknown, unknown);

    expect(result.fresh, 'two unknown versions must not satisfy a match').toBe(false);
    expect('indeterminate' in result && result.indeterminate).toBe(true);
    if (!result.fresh && 'indeterminate' in result) {
      expect(result.dimensions).toContain('binary');
    }
  });

  it('Verify_MissingPackageJson_IsIndeterminate', () => {
    // No package.json at all — collect substitutes the sentinel.
    const files = coherentFiles();
    files.delete(path.join(PLUGIN_ROOT, 'package.json'));
    const observed = collectInstallIdentity(PLUGIN_ROOT, { env: BASE_ENV, homedir: HOME, ...seams(files) });
    expect(observed.binary.version).toBe(UNKNOWN_VERSION_SENTINEL);

    const result = verifyInstallFreshness(observed, observed);
    expect(result.fresh).toBe(false);
    expect('indeterminate' in result).toBe(true);
  });

  it('Verify_KnownMatchingVersions_StillFresh', () => {
    // The converse — the fix must not have made everything indeterminate.
    const known = identityWithBinaryVersion('2.12.0-preview.4');
    expect(verifyInstallFreshness(known, known).fresh).toBe(true);
  });

  it('Gate_IndeterminateInstall_DegradesRatherThanBlocking', () => {
    // Cannot-tell is reported as cannot-tell, and must never become a block —
    // an unreadable package.json must not turn the gate into an outage.
    const lockFiles = coherentFiles();
    const observedFiles = coherentFiles();
    observedFiles.delete(path.join(PLUGIN_ROOT, 'package.json'));

    const lock = collectInstallIdentity(PLUGIN_ROOT, { env: BASE_ENV, homedir: HOME, ...seams(lockFiles) });
    observedFiles.set(
      installIdentityLockPath(PLUGIN_ROOT, { env: BASE_ENV, homedir: HOME }),
      `${JSON.stringify(lock, null, 2)}\n`,
    );

    const outcome = evaluateInstallFreshness({
      env: BASE_ENV,
      homedir: HOME,
      ...seams(observedFiles),
    });
    expect(outcome.status).toBe('degraded');
  });
});
