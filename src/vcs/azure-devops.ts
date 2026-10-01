/**
 * Azure DevOps `VcsProvider`. It wraps the `az repos`, `az pipelines` and
 * `az devops invoke` commands. It needs an authenticated `az` CLI with the
 * `azure-devops` extension.
 */

import type {
  VcsProvider,
  CreatePrOpts,
  PrResult,
  CiCheck,
  CiStatus,
  MergeResult,
  ReviewerStatus,
  ReviewStatus,
  PrFilter,
  PrSummary,
  PrComment,
  CreateIssueOpts,
  IssueResult,
  IssueSearchSummary,
  RepoInfo,
  ReplyResult,
} from './provider.js';
import { UnsupportedOperationError, computeOverallCiStatus } from './provider.js';
import { exec } from './shell.js';

interface AzPrCreateResponse {
  readonly repository: { readonly webUrl: string };
  readonly pullRequestId: number;
}

interface AzPipelineRun {
  readonly name: string;
  readonly result: string | null;
  readonly status: string;
  readonly _links?: { readonly web?: { readonly href?: string } };
}

interface AzReviewer {
  readonly uniqueName: string;
  readonly vote: number;
  readonly displayName?: string;
}

/** The fields of `az repos pr show` that give the route parameters for `az devops invoke`. */
interface AzPrShowResponse {
  readonly repository: {
    readonly id?: string;
    readonly project?: { readonly id?: string; readonly name?: string };
  };
}

interface AzCommentPosition {
  readonly line?: number;
}

interface AzThreadContext {
  readonly filePath?: string;
  readonly rightFileStart?: AzCommentPosition;
  readonly rightFileEnd?: AzCommentPosition;
  readonly leftFileStart?: AzCommentPosition;
  readonly leftFileEnd?: AzCommentPosition;
}

interface AzCommentAuthor {
  readonly uniqueName?: string;
  readonly displayName?: string;
}

interface AzPrThreadComment {
  readonly id: number;
  readonly parentCommentId?: number;
  readonly content?: string;
  readonly commentType?: string;
  readonly author?: AzCommentAuthor;
  readonly publishedDate?: string;
}

interface AzPrThread {
  readonly id: number;
  readonly status?: string;
  readonly threadContext?: AzThreadContext | null;
  readonly comments?: readonly AzPrThreadComment[];
}

interface AzPrThreadsResponse {
  readonly value?: readonly AzPrThread[];
}

function mapAzPipelineStatus(run: AzPipelineRun): CiCheck['status'] {
  if (run.status !== 'completed') {
    return 'pending';
  }
  switch (run.result) {
    case 'succeeded':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'canceled':
      return 'skipped';
    default:
      return 'pending';
  }
}

/**
 * Maps an Azure DevOps vote to a review state. A vote of 10 or 5 (approved,
 * with or without suggestions) is approved. A vote of -5 or -10 (waiting for
 * author, rejected) is changes requested. A vote of 0 is pending.
 */
function mapAzVote(vote: number): ReviewerStatus['state'] {
  if (vote >= 5) return 'approved';
  if (vote < 0) return 'changes_requested';
  return 'pending';
}

/**
 * ADO comment ids and `parentCommentId` count up inside one thread, so a raw
 * id collides across threads. The thread id times this stride, plus the comment
 * id, gives an id that is unique in the PR. The consumer keys idempotency on
 * that id. The stride assumes fewer than 100,000 comments in one thread.
 */
const ID_THREAD_STRIDE = 100_000;

function composePrUniqueId(threadId: number, commentId: number): number {
  return threadId * ID_THREAD_STRIDE + commentId;
}

/**
 * Maps the Azure DevOps `CommentThreadStatus` to the tri-state `resolved` of a
 * `PrComment`. A decided state gives `true`, and an open state gives `false`.
 * `unknown`, an unrecognized value, or a missing status gives `undefined`.
 */
function mapThreadStatusToResolved(
  status: string | undefined,
): boolean | undefined {
  switch (status) {
    case 'fixed':
    case 'closed':
    case 'wontFix':
    case 'byDesign':
      return true;
    case 'active':
    case 'pending':
      return false;
    default:
      return undefined;
  }
}

/**
 * Azure DevOps provider. The constructor ignores its config. `getPrComments`
 * reads threads through the REST `pullRequestThreads` resource, because
 * `az repos pr` has no thread-list subcommand. It skips system comments and
 * gives a file-anchored thread the `review-inline` source.
 */
export class AzureDevOpsProvider implements VcsProvider {
  readonly name = 'azure-devops' as const;

  constructor(_config: Record<string, unknown>) {
  }

  async createPr(opts: CreatePrOpts): Promise<PrResult> {
    const args = [
      'repos',
      'pr',
      'create',
      '--title',
      opts.title,
      '--description',
      opts.body,
      '--source-branch',
      opts.headBranch,
      '--target-branch',
      opts.baseBranch,
      '--output',
      'json',
    ];

    if (opts.draft) {
      args.push('--draft', 'true');
    }

    if (opts.labels && opts.labels.length > 0) {
      args.push('--labels', opts.labels.join(' '));
    }

    const output = await exec('az', args);
    const parsed = JSON.parse(output) as AzPrCreateResponse;
    const url = `${parsed.repository.webUrl}/pullrequest/${parsed.pullRequestId}`;
    return { url, number: parsed.pullRequestId };
  }

  async checkCi(prId: string): Promise<CiStatus> {
    const prOutput = await exec('az', [
      'repos',
      'pr',
      'show',
      '--id',
      prId,
      '--output',
      'json',
    ]);
    const prData = JSON.parse(prOutput) as { sourceRefName: string };
    const branch = prData.sourceRefName.replace(/^refs\/heads\//, '');

    const runsOutput = await exec('az', [
      'pipelines',
      'runs',
      'list',
      '--branch',
      branch,
      '--output',
      'json',
    ]);

    const runs = JSON.parse(runsOutput) as readonly AzPipelineRun[];

    if (runs.length === 0) {
      return { status: 'pending', checks: [] };
    }

    const checks: CiCheck[] = runs.map((run) => ({
      name: run.name,
      status: mapAzPipelineStatus(run),
      url: run._links?.web?.href,
    }));

    return {
      status: computeOverallCiStatus(checks),
      checks,
    };
  }

  async mergePr(prId: string, strategy: string): Promise<MergeResult> {
    const isSquash = strategy === 'squash';

    let azStrategy: string;
    switch (strategy) {
      case 'squash':
        azStrategy = 'squash';
        break;
      case 'rebase':
        azStrategy = 'rebase';
        break;
      case 'merge':
        azStrategy = 'noFastForward';
        break;
      default:
        azStrategy = 'squash';
    }

    try {
      const output = await exec('az', [
        'repos',
        'pr',
        'update',
        '--id',
        prId,
        '--auto-complete',
        'true',
        '--squash',
        isSquash ? 'true' : 'false',
        '--merge-strategy',
        azStrategy,
        '--output',
        'json',
      ]);

      const parsed = JSON.parse(output) as {
        status?: string;
        lastMergeCommit?: { commitId?: string };
      };

      const sha = parsed.lastMergeCommit?.commitId;
      return sha ? { merged: true, sha } : { merged: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { merged: false, error: message };
    }
  }

  async addComment(prId: string, body: string): Promise<void> {
    await exec('az', [
      'repos',
      'pr',
      'comment',
      'create',
      '--id',
      prId,
      '--text',
      body,
      '--output',
      'json',
    ]);
  }

  /**
   * Throws `UnsupportedOperationError`. `az repos pr comment` posts a new thread,
   * not a reply in a thread, so a reply needs the REST thread API.
   */
  async addReply(_prId: string, _threadId: string, _body: string): Promise<ReplyResult> {
    throw new UnsupportedOperationError('azure-devops', 'addReply');
  }

  async getReviewStatus(prId: string): Promise<ReviewStatus> {
    const output = await exec('az', [
      'repos',
      'pr',
      'reviewer',
      'list',
      '--id',
      prId,
      '--output',
      'json',
    ]);

    const reviewers = JSON.parse(output) as readonly AzReviewer[];

    const mapped: ReviewerStatus[] = reviewers.map((r) => ({
      login: r.uniqueName,
      state: mapAzVote(r.vote),
    }));

    const hasChangesRequested = mapped.some((r) => r.state === 'changes_requested');
    if (hasChangesRequested) {
      return { state: 'changes_requested', reviewers: mapped };
    }

    const allApproved =
      mapped.length > 0 && mapped.every((r) => r.state === 'approved');

    return {
      state: allApproved ? 'approved' : 'pending',
      reviewers: mapped,
    };
  }

  async listPrs(_filter?: PrFilter): Promise<PrSummary[]> {
    throw new UnsupportedOperationError('azure-devops', 'listPrs');
  }

  async getPrComments(prId: string): Promise<PrComment[]> {
    const showOutput = await exec('az', [
      'repos',
      'pr',
      'show',
      '--id',
      prId,
      '--output',
      'json',
    ]);
    const prData = JSON.parse(showOutput) as AzPrShowResponse;
    const repositoryId = prData.repository.id;
    const project =
      prData.repository.project?.name ?? prData.repository.project?.id;
    if (!repositoryId || !project) {
      throw new Error(
        `azure-devops: could not resolve repositoryId/project for PR ${prId} from 'az repos pr show'`,
      );
    }

    const invokeOutput = await exec('az', [
      'devops',
      'invoke',
      '--area',
      'git',
      '--resource',
      'pullRequestThreads',
      '--route-parameters',
      `project=${project}`,
      `repositoryId=${repositoryId}`,
      `pullRequestId=${prId}`,
      '--api-version',
      '7.1',
      '--output',
      'json',
    ]);

    const parsedUnknown: unknown = JSON.parse(invokeOutput);
    const threads: readonly AzPrThread[] = Array.isArray(parsedUnknown)
      ? (parsedUnknown as readonly AzPrThread[])
      : ((parsedUnknown as AzPrThreadsResponse).value ?? []);

    const comments: PrComment[] = [];

    for (const thread of threads) {
      const threadId = thread.id;
      const resolved = mapThreadStatusToResolved(thread.status);
      const ctx = thread.threadContext;
      const filePath =
        ctx && typeof ctx.filePath === 'string' && ctx.filePath.length > 0
          ? ctx.filePath
          : undefined;
      const isInline = filePath !== undefined;
      const line = ctx?.rightFileStart?.line;

      for (const comment of thread.comments ?? []) {
        if (comment.commentType === 'system') continue;

        let parentId: number | undefined;
        if (
          typeof comment.parentCommentId === 'number' &&
          comment.parentCommentId > 0
        ) {
          parentId = composePrUniqueId(threadId, comment.parentCommentId);
        }

        comments.push({
          id: composePrUniqueId(threadId, comment.id),
          author:
            comment.author?.uniqueName ?? comment.author?.displayName ?? '',
          body: comment.content ?? '',
          createdAt: comment.publishedDate ?? '',
          source: isInline ? 'review-inline' : 'issue-comment',
          ...(isInline && filePath !== undefined ? { path: filePath } : {}),
          ...(isInline && typeof line === 'number' ? { line } : {}),
          ...(parentId !== undefined ? { parentId } : {}),
          ...(resolved !== undefined ? { resolved } : {}),
        });
      }
    }

    return comments;
  }

  async getPrDiff(_prId: string): Promise<string> {
    throw new UnsupportedOperationError('azure-devops', 'getPrDiff');
  }

  async createIssue(_opts: CreateIssueOpts): Promise<IssueResult> {
    throw new UnsupportedOperationError('azure-devops', 'createIssue');
  }

  async searchIssuesByMarker(_operationId: string): Promise<IssueSearchSummary[]> {
    throw new UnsupportedOperationError('azure-devops', 'searchIssuesByMarker');
  }

  async getRepository(): Promise<RepoInfo> {
    throw new UnsupportedOperationError('azure-devops', 'getRepository');
  }
}
