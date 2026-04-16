/**
 * RED tests for vcs-git-available. Exercises the three branches of the
 * check: (1) binary + repo → Pass, (2) missing binary → Warning with
 * install fix, (3) binary present but not inside a repo → Warning with
 * git-init fix. Uses makeStubProbes so every non-git probe throws if
 * accidentally touched (DIM-4/T-4.2: ≤3 overrides per test).
 */

import { describe, it, expect } from 'vitest';
import { makeStubProbes } from './__shared__/make-stub-probes.js';
import { vcsGitAvailable } from './vcs-git-available.js';

describe('vcsGitAvailable', () => {
  it('VcsGitAvailable_BinaryAndRepoDetected_ReturnsPass', async () => {
    const probes = makeStubProbes({
      git: {
        which: async () => '/usr/bin/git',
        isRepo: async () => true,
        version: async () => '2.43.0',
      },
    });

    const result = await vcsGitAvailable(probes, new AbortController().signal);

    expect(result.status).toBe('Pass');
    expect(result.category).toBe('vcs');
    expect(result.name).toBe('git-available');
    expect(result.message).toBe('Git 2.43.0 detected in repository.');
    expect(result.fix).toBeUndefined();
  });

  it('VcsGitAvailable_GitBinaryMissing_ReturnsWarning', async () => {
    const probes = makeStubProbes({
      git: {
        which: async () => null,
        isRepo: async () => {
          throw new Error('isRepo should not be called when binary is missing');
        },
        version: async () => {
          throw new Error('version should not be called when binary is missing');
        },
      },
    });

    const result = await vcsGitAvailable(probes, new AbortController().signal);

    expect(result.status).toBe('Warning');
    expect(result.category).toBe('vcs');
    expect(result.fix).toBe('Install git from https://git-scm.com');
  });

  it('VcsGitAvailable_NotInGitRepository_ReturnsWarning', async () => {
    const probes = makeStubProbes({
      git: {
        which: async () => '/usr/bin/git',
        isRepo: async () => false,
        version: async () => '2.43.0',
      },
    });

    const result = await vcsGitAvailable(probes, new AbortController().signal);

    expect(result.status).toBe('Warning');
    expect(result.category).toBe('vcs');
    expect(result.fix).toBe('Run git init in project root');
  });
});
