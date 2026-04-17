// ─── Azure DevOps VCS Provider (Stub) ────────────────────────────────────────
//
// Placeholder implementation for Azure DevOps support.
// Track progress at https://github.com/lvlup-sw/exarchos/issues/1024

import type {
  VcsProvider,
  CreatePrOpts,
  PrResult,
  CiStatus,
  MergeResult,
  ReviewStatus,
  PrFilter,
  PrSummary,
  PrComment,
  CreateIssueOpts,
  IssueResult,
  RepoInfo,
} from './provider.js';

export class AzureDevOpsProvider implements VcsProvider {
  readonly name = 'azure-devops' as const;

  constructor(_config: Record<string, unknown>) {
    // Config reserved for future use
  }

  async createPr(_opts: CreatePrOpts): Promise<PrResult> {
    throw new Error(
      'Azure DevOps support is not yet implemented. Track progress at https://github.com/lvlup-sw/exarchos/issues/1024'
    );
  }

  async checkCi(_prId: string): Promise<CiStatus> {
    throw new Error(
      'Azure DevOps support is not yet implemented. Track progress at https://github.com/lvlup-sw/exarchos/issues/1024'
    );
  }

  async mergePr(_prId: string, _strategy: string): Promise<MergeResult> {
    throw new Error(
      'Azure DevOps support is not yet implemented. Track progress at https://github.com/lvlup-sw/exarchos/issues/1024'
    );
  }

  async addComment(_prId: string, _body: string): Promise<void> {
    throw new Error(
      'Azure DevOps support is not yet implemented. Track progress at https://github.com/lvlup-sw/exarchos/issues/1024'
    );
  }

  async getReviewStatus(_prId: string): Promise<ReviewStatus> {
    throw new Error(
      'Azure DevOps support is not yet implemented. Track progress at https://github.com/lvlup-sw/exarchos/issues/1024'
    );
  }

  async listPrs(_filter?: PrFilter): Promise<PrSummary[]> {
    throw new Error(
      'Azure DevOps support is not yet implemented. Track progress at https://github.com/lvlup-sw/exarchos/issues/1024'
    );
  }

  async getPrComments(_prId: string): Promise<PrComment[]> {
    throw new Error(
      'Azure DevOps support is not yet implemented. Track progress at https://github.com/lvlup-sw/exarchos/issues/1024'
    );
  }

  async getPrDiff(_prId: string): Promise<string> {
    throw new Error(
      'Azure DevOps support is not yet implemented. Track progress at https://github.com/lvlup-sw/exarchos/issues/1024'
    );
  }

  async createIssue(_opts: CreateIssueOpts): Promise<IssueResult> {
    throw new Error(
      'Azure DevOps support is not yet implemented. Track progress at https://github.com/lvlup-sw/exarchos/issues/1024'
    );
  }

  async getRepository(): Promise<RepoInfo> {
    throw new Error(
      'Azure DevOps support is not yet implemented. Track progress at https://github.com/lvlup-sw/exarchos/issues/1024'
    );
  }
}
