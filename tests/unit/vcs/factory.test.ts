import { describe, it, expect } from 'vitest';
import { createVcsProvider } from '../../../src/vcs/factory.js';
import { DEFAULTS } from '../../../src/config/resolve.js';
import { GitHubProvider } from '../../../src/vcs/github.js';
import { GitLabProvider } from '../../../src/vcs/gitlab.js';
import { AzureDevOpsProvider } from '../../../src/vcs/azure-devops.js';
import type { ResolvedProjectConfig } from '../../../src/config/resolve.js';
import type { VcsDetectorDeps } from '../../../src/vcs/detector.js';

/**
 * Detector deps whose `git remote get-url` call returns `remoteUrl`, or throws when it is null.
 * Each CLI version check throws, so no CLI is available. The env is empty.
 */
function fakeDetectorDeps(remoteUrl: string | null): VcsDetectorDeps {
  return {
    exec: async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('get-url')) {
        if (remoteUrl === null) throw new Error('no remote');
        return remoteUrl;
      }
      throw new Error('not found');
    },
    env: {},
  };
}

describe('createVcsProvider', () => {
  /** The provider of `DEFAULTS` is `github`. */
  it('createVcsProvider_GitHub_ReturnsGitHubProvider', async () => {
    const provider = await createVcsProvider({ config: DEFAULTS });
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.name).toBe('github');
  });

  it('createVcsProvider_GitLab_ReturnsGitLabProvider', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      vcs: { provider: 'gitlab', settings: {} },
    };
    const provider = await createVcsProvider({ config });
    expect(provider).toBeInstanceOf(GitLabProvider);
    expect(provider.name).toBe('gitlab');
  });

  it('createVcsProvider_AzureDevOps_ReturnsAzureProvider', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      vcs: { provider: 'azure-devops', settings: {} },
    };
    const provider = await createVcsProvider({ config });
    expect(provider).toBeInstanceOf(AzureDevOpsProvider);
    expect(provider.name).toBe('azure-devops');
  });

  it('createVcsProvider_PassesSettings_ToProvider', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      vcs: { provider: 'github', settings: { 'auto-merge-strategy': 'rebase' } },
    };
    const provider = await createVcsProvider({ config });
    expect(provider).toBeInstanceOf(GitHubProvider);
  });

  /** The injected deps have no remote, so detection returns null on every host. */
  it('createVcsProvider_NoOpts_DefaultsToGitHub', async () => {
    const provider = await createVcsProvider({
      detectorDeps: fakeDetectorDeps(null),
    });
    expect(provider).toBeInstanceOf(GitHubProvider);
  });

  it('CreateVcsProvider_AutoDetect_UsesDetectedProvider', async () => {
    const provider = await createVcsProvider({
      detectorDeps: fakeDetectorDeps('git@gitlab.com:org/repo.git'),
    });
    expect(provider).toBeInstanceOf(GitLabProvider);
    expect(provider.name).toBe('gitlab');
  });

  /** The config names `github` and the remote is a GitLab URL. The config must win. */
  it('CreateVcsProvider_ExplicitConfig_SkipsDetection', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      vcs: { provider: 'github', settings: {} },
    };
    const provider = await createVcsProvider({
      config,
      detectorDeps: fakeDetectorDeps('git@gitlab.com:org/repo.git'),
    });
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.name).toBe('github');
  });

  it('CreateVcsProvider_NoRemote_DefaultsToGitHub', async () => {
    const provider = await createVcsProvider({
      detectorDeps: fakeDetectorDeps(null),
    });
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.name).toBe('github');
  });

  it('CreateVcsProvider_AutoDetect_AzureDevOps', async () => {
    const provider = await createVcsProvider({
      detectorDeps: fakeDetectorDeps('https://dev.azure.com/org/project/_git/repo'),
    });
    expect(provider).toBeInstanceOf(AzureDevOpsProvider);
    expect(provider.name).toBe('azure-devops');
  });

  it('CreateVcsProvider_AutoDetect_GitHub', async () => {
    const provider = await createVcsProvider({
      detectorDeps: fakeDetectorDeps('git@github.com:org/repo.git'),
    });
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.name).toBe('github');
  });

  it('CreateVcsProvider_AutoDetect_UnknownHost_DefaultsToGitHub', async () => {
    const provider = await createVcsProvider({
      detectorDeps: fakeDetectorDeps('git@bitbucket.org:org/repo.git'),
    });
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.name).toBe('github');
  });
});
