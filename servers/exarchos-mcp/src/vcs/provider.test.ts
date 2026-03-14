import { describe, it, expect } from 'vitest';
import { GitLabProvider } from './gitlab.js';
import { AzureDevOpsProvider } from './azure-devops.js';
import type { VcsProvider } from './provider.js';

describe('VcsProvider', () => {
  it('VcsProvider_Interface_DefinesRequiredMethods', () => {
    // Type-level test: verify interface is implementable
    const provider: VcsProvider = {
      name: 'github',
      createPr: async () => ({ url: '', number: 0 }),
      checkCi: async () => ({ status: 'pending', checks: [] }),
      mergePr: async () => ({ merged: false }),
      addComment: async () => {},
      getReviewStatus: async () => ({ state: 'pending', reviewers: [] }),
    };
    expect(provider.name).toBe('github');
  });

  it('GitLabProvider_CreatePr_ThrowsNotImplemented', async () => {
    const provider = new GitLabProvider({});
    await expect(provider.createPr({
      title: 'test', body: 'test', baseBranch: 'main', headBranch: 'feat'
    })).rejects.toThrow(/not yet implemented/i);
  });

  it('AzureDevOpsProvider_CreatePr_ThrowsNotImplemented', async () => {
    const provider = new AzureDevOpsProvider({});
    await expect(provider.createPr({
      title: 'test', body: 'test', baseBranch: 'main', headBranch: 'feat'
    })).rejects.toThrow(/not yet implemented/i);
  });

  it('GitLabProvider_Name_IsGitlab', () => {
    const provider = new GitLabProvider({});
    expect(provider.name).toBe('gitlab');
  });

  it('AzureDevOpsProvider_Name_IsAzureDevOps', () => {
    const provider = new AzureDevOpsProvider({});
    expect(provider.name).toBe('azure-devops');
  });

  it('GitLabProvider_AllMethods_ThrowNotImplemented', async () => {
    const provider = new GitLabProvider({});
    await expect(provider.checkCi('1')).rejects.toThrow(/not yet implemented/i);
    await expect(provider.mergePr('1', 'squash')).rejects.toThrow(/not yet implemented/i);
    await expect(provider.addComment('1', 'test')).rejects.toThrow(/not yet implemented/i);
    await expect(provider.getReviewStatus('1')).rejects.toThrow(/not yet implemented/i);
  });

  it('AzureDevOpsProvider_AllMethods_ThrowNotImplemented', async () => {
    const provider = new AzureDevOpsProvider({});
    await expect(provider.checkCi('1')).rejects.toThrow(/not yet implemented/i);
    await expect(provider.mergePr('1', 'squash')).rejects.toThrow(/not yet implemented/i);
    await expect(provider.addComment('1', 'test')).rejects.toThrow(/not yet implemented/i);
    await expect(provider.getReviewStatus('1')).rejects.toThrow(/not yet implemented/i);
  });
});
