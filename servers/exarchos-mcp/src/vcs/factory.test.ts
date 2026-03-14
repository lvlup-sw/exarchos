import { describe, it, expect } from 'vitest';
import { createVcsProvider } from './factory.js';
import { DEFAULTS } from '../config/resolve.js';
import { GitHubProvider } from './github.js';
import { GitLabProvider } from './gitlab.js';
import { AzureDevOpsProvider } from './azure-devops.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';

describe('createVcsProvider', () => {
  it('createVcsProvider_GitHub_ReturnsGitHubProvider', () => {
    const provider = createVcsProvider(DEFAULTS); // default is github
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.name).toBe('github');
  });

  it('createVcsProvider_GitLab_ReturnsGitLabProvider', () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      vcs: { provider: 'gitlab', settings: {} },
    };
    const provider = createVcsProvider(config);
    expect(provider).toBeInstanceOf(GitLabProvider);
    expect(provider.name).toBe('gitlab');
  });

  it('createVcsProvider_AzureDevOps_ReturnsAzureProvider', () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      vcs: { provider: 'azure-devops', settings: {} },
    };
    const provider = createVcsProvider(config);
    expect(provider).toBeInstanceOf(AzureDevOpsProvider);
    expect(provider.name).toBe('azure-devops');
  });

  it('createVcsProvider_PassesSettings_ToProvider', () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      vcs: { provider: 'github', settings: { 'auto-merge-strategy': 'rebase' } },
    };
    const provider = createVcsProvider(config);
    expect(provider).toBeInstanceOf(GitHubProvider);
  });

  it('createVcsProvider_NoProjectConfig_DefaultsToGitHub', () => {
    const provider = createVcsProvider(undefined as unknown as ResolvedProjectConfig);
    expect(provider).toBeInstanceOf(GitHubProvider);
  });
});
