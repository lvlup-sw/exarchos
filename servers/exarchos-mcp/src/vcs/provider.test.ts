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
      listPrs: async () => [],
      getPrComments: async () => [],
      getPrDiff: async () => '',
      createIssue: async () => ({ number: 0, url: '' }),
      getRepository: async () => ({ nameWithOwner: '', defaultBranch: '' }),
    };
    expect(provider.name).toBe('github');
  });

  it('GitLabProvider_Name_IsGitlab', () => {
    const provider = new GitLabProvider({});
    expect(provider.name).toBe('gitlab');
  });

  it('AzureDevOpsProvider_Name_IsAzureDevOps', () => {
    const provider = new AzureDevOpsProvider({});
    expect(provider.name).toBe('azure-devops');
  });

  it('GitLabProvider_ImplementsVcsProvider', async () => {
    const provider = new GitLabProvider({});
    // Verify all VcsProvider methods exist on the implementation
    expect(typeof provider.createPr).toBe('function');
    expect(typeof provider.checkCi).toBe('function');
    expect(typeof provider.mergePr).toBe('function');
    expect(typeof provider.addComment).toBe('function');
    expect(typeof provider.getReviewStatus).toBe('function');
    expect(typeof provider.listPrs).toBe('function');
    expect(typeof provider.getPrComments).toBe('function');
    expect(typeof provider.getPrDiff).toBe('function');
    expect(typeof provider.createIssue).toBe('function');
    expect(typeof provider.getRepository).toBe('function');
    // Methods not yet implemented should throw
    await expect(provider.listPrs()).rejects.toThrow(/not yet implemented/i);
    await expect(provider.getPrComments('1')).rejects.toThrow(/not yet implemented/i);
    await expect(provider.getPrDiff('1')).rejects.toThrow(/not yet implemented/i);
    await expect(provider.createIssue({ title: 't', body: 'b' })).rejects.toThrow(/not yet implemented/i);
    await expect(provider.getRepository()).rejects.toThrow(/not yet implemented/i);
  });

  it('AzureDevOpsProvider_ImplementsVcsProvider', async () => {
    const provider = new AzureDevOpsProvider({});
    // Verify all VcsProvider methods exist on the implementation
    expect(typeof provider.createPr).toBe('function');
    expect(typeof provider.checkCi).toBe('function');
    expect(typeof provider.mergePr).toBe('function');
    expect(typeof provider.addComment).toBe('function');
    expect(typeof provider.getReviewStatus).toBe('function');
    expect(typeof provider.listPrs).toBe('function');
    expect(typeof provider.getPrComments).toBe('function');
    expect(typeof provider.getPrDiff).toBe('function');
    expect(typeof provider.createIssue).toBe('function');
    expect(typeof provider.getRepository).toBe('function');
    // Methods not yet implemented should throw
    await expect(provider.listPrs()).rejects.toThrow(/not yet implemented/i);
    await expect(provider.getPrComments('1')).rejects.toThrow(/not yet implemented/i);
    await expect(provider.getPrDiff('1')).rejects.toThrow(/not yet implemented/i);
    await expect(provider.createIssue({ title: 't', body: 'b' })).rejects.toThrow(/not yet implemented/i);
    await expect(provider.getRepository()).rejects.toThrow(/not yet implemented/i);
  });
});
