import { describe, it, expect } from 'vitest';
import { requiresGitHub } from './require-github.js';
import { GitLabProvider } from './gitlab.js';
import { AzureDevOpsProvider } from './azure-devops.js';
import { GitHubProvider } from './github.js';

describe('requiresGitHub', () => {
  it('requiresGitHub_GitHubProvider_ReturnsNull', () => {
    const provider = new GitHubProvider({});
    const result = requiresGitHub(provider, 'assess_stack');
    expect(result).toBeNull();
  });

  it('requiresGitHub_UndefinedProvider_ReturnsNull', () => {
    const result = requiresGitHub(undefined, 'assess_stack');
    expect(result).toBeNull();
  });

  it('requiresGitHub_GitLabProvider_ReturnsSkippedResult', () => {
    const provider = new GitLabProvider({});
    const result = requiresGitHub(provider, 'assess_stack');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    const data = result!.data as { skipped: boolean; reason: string; provider: string; operation: string };
    expect(data.skipped).toBe(true);
    expect(data.reason).toBe('gitlab: assess_stack is not yet supported');
    expect(data.provider).toBe('gitlab');
    expect(data.operation).toBe('assess_stack');
  });

  it('requiresGitHub_AzureDevOpsProvider_ReturnsSkippedResult', () => {
    const provider = new AzureDevOpsProvider({});
    const result = requiresGitHub(provider, 'validate_pr_stack');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    const data = result!.data as { skipped: boolean; reason: string; provider: string; operation: string };
    expect(data.skipped).toBe(true);
    expect(data.reason).toBe('azure-devops: validate_pr_stack is not yet supported');
    expect(data.provider).toBe('azure-devops');
    expect(data.operation).toBe('validate_pr_stack');
  });

  it('requiresGitHub_DifferentOperations_IncludeOperationInReason', () => {
    const provider = new GitLabProvider({});
    const result1 = requiresGitHub(provider, 'check_pr_comments');
    const result2 = requiresGitHub(provider, 'pre_synthesis_check');

    const data1 = result1!.data as { operation: string };
    const data2 = result2!.data as { operation: string };
    expect(data1.operation).toBe('check_pr_comments');
    expect(data2.operation).toBe('pre_synthesis_check');
  });
});
