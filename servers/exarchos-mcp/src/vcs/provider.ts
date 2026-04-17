// ─── VCS Provider Interface ──────────────────────────────────────────────────
//
// Abstraction layer for version control system operations.
// Enables Exarchos to work with GitHub, GitLab, and Azure DevOps.

export interface CreatePrOpts {
  readonly title: string;
  readonly body: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly draft?: boolean;
  readonly labels?: readonly string[];
}

export interface PrResult {
  readonly url: string;
  readonly number: number;
}

export interface CiCheck {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'pending' | 'skipped';
  readonly url?: string;
}

export interface CiStatus {
  readonly status: 'pass' | 'fail' | 'pending';
  readonly checks: readonly CiCheck[];
}

export interface MergeResult {
  readonly merged: boolean;
  readonly sha?: string;
  readonly error?: string;
}

export interface ReviewerStatus {
  readonly login: string;
  readonly state: 'approved' | 'changes_requested' | 'pending' | 'commented';
}

export interface ReviewStatus {
  readonly state: 'approved' | 'changes_requested' | 'pending';
  readonly reviewers: readonly ReviewerStatus[];
}

export interface PrFilter {
  readonly state?: 'open' | 'closed' | 'merged' | 'all';
  readonly head?: string;
  readonly base?: string;
}

export interface PrSummary {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly state: string;
}

export interface PrComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly path?: string;
  readonly line?: number;
}

export interface CreateIssueOpts {
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
}

export interface IssueResult {
  readonly number: number;
  readonly url: string;
}

export interface RepoInfo {
  readonly nameWithOwner: string;
  readonly defaultBranch: string;
}

export interface VcsProvider {
  readonly name: 'github' | 'gitlab' | 'azure-devops';
  createPr(opts: CreatePrOpts): Promise<PrResult>;
  checkCi(prId: string): Promise<CiStatus>;
  mergePr(prId: string, strategy: string): Promise<MergeResult>;
  addComment(prId: string, body: string): Promise<void>;
  getReviewStatus(prId: string): Promise<ReviewStatus>;
  listPrs(filter?: PrFilter): Promise<PrSummary[]>;
  getPrComments(prId: string): Promise<PrComment[]>;
  getPrDiff(prId: string): Promise<string>;
  createIssue(opts: CreateIssueOpts): Promise<IssueResult>;
  getRepository(): Promise<RepoInfo>;
}
