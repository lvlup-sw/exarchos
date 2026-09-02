// ─── GitLab VCS Provider ─────────────────────────────────────────────────────
//
// Implements VcsProvider by wrapping the `glab` CLI.
// Requires `glab` to be installed and authenticated.
// GitLab uses "merge request" (MR) terminology; `number` maps to `iid`.

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

// Raw GitLab REST shapes from `glab api .../discussions`. `glab api` proxies
// the GitLab API verbatim, so these are snake_case (unlike `glab mr view
// --json`, whose camelCase serialization is glab's own). Every field is
// optional/defensive: a real payload always carries id/body/created_at, but we
// never trust the wire shape.
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

  constructor(_config: Record<string, unknown>) {
    // Config reserved for future use (e.g., custom glab path, self-hosted URL)
  }

  async createPr(opts: CreatePrOpts): Promise<PrResult> {
    // `glab mr create` has NO `--json` flag, and its create stream is
    // undocumented — so we do not parse its stdout. We issue the create, then
    // read the freshly created MR's identity with `glab mr view` (which DOES
    // support `--json` field selection, matching `checkCi`/`getReviewStatus`).
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

    // Resolve the new MR by its source branch. A read failure THROWS (does not
    // return a partial): `PrResult.number` is non-optional, and the caller
    // `handleCreatePr` maps the throw to a structured VCS_ERROR.
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

  async mergePr(prId: string, strategy: string): Promise<MergeResult> {
    const args = ['mr', 'merge', prId];

    // glab supports --squash and --rebase; plain merge needs no extra flag
    if (strategy === 'squash') {
      args.push('--squash');
    } else if (strategy === 'rebase') {
      args.push('--rebase');
    }
    // 'merge' strategy uses the default glab behavior (no flag)

    try {
      await exec('glab', args);

      // Fetch the merge commit SHA via glab mr view
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
        // SHA retrieval failed — merge still succeeded
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

  // Per-thread review-comment replies map to GitLab discussion notes
  // (`POST /projects/:id/merge_requests/:iid/discussions/:discussion_id/notes`),
  // which `glab` does not expose as a first-class verb. Tracked as a DR-7
  // follow-up (#1612); throws rather than silently no-op'ing so callers get a
  // clear capability signal.
  async addReply(_prId: string, _threadId: string, _body: string): Promise<ReplyResult> {
    throw new UnsupportedOperationError('gitlab', 'addReply');
  }

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

    // Overall: approved only if all reviewers have approved and there's at least one
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

  async getPrComments(prId: string): Promise<PrComment[]> {
    // GitLab collapses ALL merge-request feedback onto ONE endpoint:
    // `discussions`. Each discussion is either an *individual note* (a
    // PR-level comment or a standalone diff note) or a *thread* (a root note
    // plus replies). This mirrors the GitHub provider's fetch → normalize →
    // tri-state-resolution shape, but GitLab has only TWO sources:
    //
    //  - a note carrying a diff `position` → 'review-inline' (path/line).
    //  - every other note                  → 'issue-comment'.
    //
    // There is no 'review-summary' surface — review verdicts are
    // getReviewStatus's job, not ours.
    //
    // We paginate explicitly (GitLab defaults to ~20 notes/page) so large MRs
    // are never silently truncated. `glab api` proxies the raw GitLab API, so
    // `:fullpath` is glab's placeholder for the URL-encoded current project
    // path (same resolution `glab mr` uses).
    const PER_PAGE = 100;
    const discussions: GlabDiscussion[] = [];
    // Defensive page cap (50 × 100 = 5000 discussions) so a misbehaving pager
    // can never spin this into an unbounded loop.
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
      // One-level threading: the first NON-system note in a discussion is the
      // thread root; every later note replies to it (parentId → root id).
      let rootId: number | undefined;
      for (const note of notes) {
        // System notes (label changes, description edits, …) are activity, not
        // feedback. GitHub's comment endpoints never surface these, so we skip
        // them to keep two-source parity.
        if (note.system === true) continue;

        const position = note.position;
        const path = position?.new_path ?? position?.old_path ?? undefined;
        const line = position?.new_line ?? position?.old_line ?? undefined;
        const isInline = position != null && typeof path === 'string';

        // Emit ONLY contract keys — never leak a GitLab field name (no
        // new_path / resolvable / system, etc.).
        const comment: PrComment = {
          id: note.id,
          author: note.author?.username ?? '',
          body: note.body,
          createdAt: note.created_at,
          source: isInline ? 'review-inline' : 'issue-comment',
          ...(isInline && typeof path === 'string' ? { path } : {}),
          ...(isInline && typeof line === 'number' ? { line } : {}),
          ...(rootId !== undefined ? { parentId: rootId } : {}),
          // Tri-state resolution, inline on the note: a resolvable note's
          // boolean `resolved` maps through; a non-resolvable note — or one
          // whose resolution field is missing/garbled — leaves `resolved`
          // ABSENT (unknown, never coerced to false). Per-field defensive: a
          // bad resolution field never drops the rest of the comment.
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
