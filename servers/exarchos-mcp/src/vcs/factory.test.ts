import { describe, it, expect } from 'vitest';
import { createVcsProvider } from './factory.js';
import { DEFAULTS } from '../config/resolve.js';
import { GitHubProvider } from './github.js';
import { GitLabProvider } from './gitlab.js';
import { AzureDevOpsProvider } from './azure-devops.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import type { VcsDetectorDeps } from './detector.js';

/**
 * Helper: builds detector deps that simulate a git remote URL.
 * The comprehensive detector uses `exec` (for running `git remote get-url origin`
 * and CLI version checks) and `env` (for env var overrides).
 */
function fakeDetectorDeps(remoteUrl: string | null): VcsDetectorDeps {
  return {
    exec: async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('get-url')) {
        if (remoteUrl === null) throw new Error('no remote');
        return remoteUrl;
      }
      // CLI version checks — simulate unavailable
      throw new Error('not found');
    },
    env: {},
  };
}

describe('createVcsProvider', () => {
  // ── Existing behavior (explicit config) ─────────────────────────────────

  it('createVcsProvider_GitHub_ReturnsGitHubProvider', async () => {
    const provider = await createVcsProvider({ config: DEFAULTS }); // default is github
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

  it('createVcsProvider_NoOpts_DefaultsToGitHub', async () => {
    // When no opts at all, detection runs but in CI there may be no remote.
    // We inject deps that return null to guarantee the GitHub fallback.
    const provider = await createVcsProvider({
      detectorDeps: fakeDetectorDeps(null),
    });
    expect(provider).toBeInstanceOf(GitHubProvider);
  });

  // ── Auto-detection integration ──────────────────────────────────────────

  it('CreateVcsProvider_AutoDetect_UsesDetectedProvider', async () => {
    // No explicit config -> detector runs; remote is a gitlab URL -> GitLabProvider
    const provider = await createVcsProvider({
      detectorDeps: fakeDetectorDeps('git@gitlab.com:org/repo.git'),
    });
    expect(provider).toBeInstanceOf(GitLabProvider);
    expect(provider.name).toBe('gitlab');
  });

  it('CreateVcsProvider_ExplicitConfig_SkipsDetection', async () => {
    // Explicit config says github, but remote points to gitlab.
    // Explicit config must win — detection is skipped.
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
    // No config, no remote -> detection returns null -> fallback to GitHub
    const provider = await createVcsProvider({
      detectorDeps: fakeDetectorDeps(null),
    });
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.name).toBe('github');
  });

  it('CreateVcsProvider_AutoDetect_AzureDevOps', async () => {
    // Detects Azure DevOps from dev.azure.com URL
    const provider = await createVcsProvider({
      detectorDeps: fakeDetectorDeps('https://dev.azure.com/org/project/_git/repo'),
    });
    expect(provider).toBeInstanceOf(AzureDevOpsProvider);
    expect(provider.name).toBe('azure-devops');
  });

  it('CreateVcsProvider_AutoDetect_GitHub', async () => {
    // Detects GitHub from github.com URL
    const provider = await createVcsProvider({
      detectorDeps: fakeDetectorDeps('git@github.com:org/repo.git'),
    });
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.name).toBe('github');
  });

  it('CreateVcsProvider_AutoDetect_UnknownHost_DefaultsToGitHub', async () => {
    // Unknown hosting provider -> fallback to GitHub
    const provider = await createVcsProvider({
      detectorDeps: fakeDetectorDeps('git@bitbucket.org:org/repo.git'),
    });
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.name).toBe('github');
  });
});
