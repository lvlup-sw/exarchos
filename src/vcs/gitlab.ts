/**
 * The GitLab VcsProvider. It wraps the `glab` CLI, which must be installed and authenticated.
 * GitLab calls a pull request a "merge request" (MR), and `number` maps to the MR `iid`.
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

interface GlabPipelineJob {
  readonly name: string;
  readonly status: string;
  readonly webUrl?: string;
}

interface GlabPipelineResponse {
  readonly pipeline: {
    readonly jobs: readonly GlabPipelineJob[];
  } | null;
}

interface GlabReviewer {
  readonly username: string;
}

interface GlabReviewResponse {
  readonly reviewers: readonly GlabReviewer[];
  readonly approvedBy: readonly GlabReviewer[];
}

/**
 * Raw GitLab REST shapes from `glab api .../discussions`. They are snake_case, because `glab api` proxies the GitLab API without change.
 * The code does not trust the wire shape, so most fields are optional.
 */
interface GlabDiscussionPosition {
  readonly new_path?: string | null;
  readonly old_path?: string | null;
  readonly new_line?: number | null;
  readonly old_line?: number | null;
}

interface GlabDiscussionNote {
  readonly id: number;
  readonly body: string;
  readonly author?: { readonly username?: string } | null;
  readonly created_at: string;
  readonly system?: boolean;
  readonly type?: string | null;
  readonly position?: GlabDiscussionPosition | null;
  readonly resolvable?: boolean;
  readonly resolved?: boolean;
}

interface GlabDiscussion {
  readonly id: string;
  readonly individual_note?: boolean;
  readonly notes?: readonly GlabDiscussionNote[];
}

function mapGitLabJobStatus(status: string): CiCheck['status'] {
  switch (status) {
    case 'success':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'skipped':
      return 'skipped';
    case 'created':
    case 'pending':
    case 'running':
    case 'manual':
      return 'pending';
    default:
      return 'pending';
  }
}

export class GitLabProvider implements VcsProvider {
  readonly name = 'gitlab' as const;

  /** The provider does not read `_config`. */
  constructor(_config: Record<string, unknown>) {
  }

  /**
   * Creates the MR, then reads its `iid` and `webUrl` by the source branch with `glab mr view --json`. `glab mr create` has no `--json` flag and no documented output.
   * A failed read throws, because `PrResult.number` is required. `handleCreatePr` maps the throw to a VCS_ERROR.
   */
  async createPr(opts: CreatePrOpts): Promise<PrResult> {
    const args = [
      'mr',
      'create',
      '--title',
      opts.title,
      '--description',
      opts.body,
      '--source-branch',
      opts.headBranch,
      '--target-branch',
      opts.baseBranch,
    ];

    if (opts.draft) {
      args.push('--draft');
    }

    if (opts.labels && opts.labels.length > 0) {
      args.push('--label', opts.labels.join(','));
    }

    await exec('glab', args);

    const viewOutput = await exec('glab', [
      'mr',
      'view',
      opts.headBranch,
      '--json',
      'iid,webUrl',
    ]);
    const parsed = JSON.parse(viewOutput) as { iid: number; webUrl: string };
    return { url: parsed.webUrl, number: parsed.iid };
  }

  async checkCi(prId: string): Promise<CiStatus> {
    const output = await exec('glab', [
      'mr',
      'view',
      prId,
      '--json',
      'pipeline',
    ]);

    const parsed = JSON.parse(output) as GlabPipelineResponse;

    if (!parsed.pipeline) {
      return { status: 'pending', checks: [] };
    }

    const checks: CiCheck[] = parsed.pipeline.jobs.map((job) => ({
      name: job.name,
      status: mapGitLabJobStatus(job.status),
      url: job.webUrl,
    }));

    return {
      status: computeOverallCiStatus(checks),
      checks,
    };
  }

  /**
   * Merges the MR. `squash` adds `--squash`, `rebase` adds `--rebase`, and any other strategy uses the default glab merge.
   * After the merge, it reads the merge commit SHA. If that read fails, the result is still `merged: true`, with no SHA.
   */
  async mergePr(prId: string, strategy: string): Promise<MergeResult> {
    const args = ['mr', 'merge', prId];

    if (strategy === 'squash') {
      args.push('--squash');
    } else if (strategy === 'rebase') {
      args.push('--rebase');
    }

    try {
      await exec('glab', args);

      try {
        const viewOutput = await exec('glab', [
          'mr',
          'view',
          prId,
          '--json',
          'sha',
        ]);
        const parsed = JSON.parse(viewOutput) as { sha?: string };
        return parsed.sha ? { merged: true, sha: parsed.sha } : { merged: true };
      } catch {
        return { merged: true };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { merged: false, error: message };
    }
  }

  async addComment(prId: string, body: string): Promise<void> {
    await exec('glab', ['mr', 'comment', prId, '--message', body]);
  }

  /**
   * Throws `UnsupportedOperationError`. A thread reply is a GitLab discussion note, and `glab` has no command for it.
   * The throw gives callers a clear capability signal, not a silent no-op.
   */
  async addReply(_prId: string, _threadId: string, _body: string): Promise<ReplyResult> {
    throw new UnsupportedOperationError('gitlab', 'addReply');
  }

  /** The state is `approved` only when there is at least one reviewer and every reviewer approved. */
  async getReviewStatus(prId: string): Promise<ReviewStatus> {
    const output = await exec('glab', [
      'mr',
      'view',
      prId,
      '--json',
      'reviewers,approvedBy',
    ]);

    const parsed = JSON.parse(output) as GlabReviewResponse;
    const approvedSet = new Set(parsed.approvedBy.map((a) => a.username));

    const reviewers: ReviewerStatus[] = parsed.reviewers.map((r) => ({
      login: r.username,
      state: approvedSet.has(r.username) ? 'approved' as const : 'pending' as const,
    }));

    const allApproved =
      reviewers.length > 0 && reviewers.every((r) => r.state === 'approved');

    return {
      state: allApproved ? 'approved' : 'pending',
      reviewers,
    };
  }

  async listPrs(_filter?: PrFilter): Promise<PrSummary[]> {
    throw new UnsupportedOperationError('gitlab', 'listPrs');
  }

  /**
   * Reads all MR feedback from the `discussions` endpoint. It reads page after page, 100 per page, because one page of a large MR is not complete.
   * A cap of 50 pages (5000 discussions) keeps a faulty pager from an endless loop.
   * A note with a diff `position` and a path becomes `review-inline` with its path and line. Every other note becomes `issue-comment`.
   * The first non-system note of a discussion is the thread root, and each later note gets it as `parentId`.
   *
   * System notes are activity, not feedback, so the method skips them, as the GitHub endpoints do.
   * A comment carries only contract keys. `resolved` is present only for a resolvable note with a boolean `resolved`, and is never coerced to false.
   */
  async getPrComments(prId: string): Promise<PrComment[]> {
    const PER_PAGE = 100;
    const discussions: GlabDiscussion[] = [];
    for (let page = 1; page <= 50; page++) {
      const output = await exec('glab', [
        'api',
        `projects/:fullpath/merge_requests/${prId}/discussions?per_page=${PER_PAGE}&page=${page}`,
      ]);
      const parsed = JSON.parse(output) as readonly GlabDiscussion[];
      if (!Array.isArray(parsed) || parsed.length === 0) break;
      discussions.push(...parsed);
      if (parsed.length < PER_PAGE) break;
    }

    const comments: PrComment[] = [];
    for (const discussion of discussions) {
      const notes = discussion.notes ?? [];
      let rootId: number | undefined;
      for (const note of notes) {
        if (note.system === true) continue;

        const position = note.position;
        const path = position?.new_path ?? position?.old_path ?? undefined;
        const line = position?.new_line ?? position?.old_line ?? undefined;
        const isInline = position != null && typeof path === 'string';

        const comment: PrComment = {
          id: note.id,
          author: note.author?.username ?? '',
          body: note.body,
          createdAt: note.created_at,
          source: isInline ? 'review-inline' : 'issue-comment',
          ...(isInline && typeof path === 'string' ? { path } : {}),
          ...(isInline && typeof line === 'number' ? { line } : {}),
          ...(rootId !== undefined ? { parentId: rootId } : {}),
          ...(note.resolvable === true && typeof note.resolved === 'boolean'
            ? { resolved: note.resolved }
            : {}),
        };

        comments.push(comment);
        if (rootId === undefined) rootId = note.id;
      }
    }

    return comments;
  }

  async getPrDiff(_prId: string): Promise<string> {
    throw new UnsupportedOperationError('gitlab', 'getPrDiff');
  }

  async createIssue(_opts: CreateIssueOpts): Promise<IssueResult> {
    throw new UnsupportedOperationError('gitlab', 'createIssue');
  }

  async searchIssuesByMarker(_operationId: string): Promise<IssueSearchSummary[]> {
    throw new UnsupportedOperationError('gitlab', 'searchIssuesByMarker');
  }

  async getRepository(): Promise<RepoInfo> {
    throw new UnsupportedOperationError('gitlab', 'getRepository');
  }
}
