import type { Source, Session, Activity, PullRequestOutput } from '../types.js';

// ============================================================================
// Source Fixtures
// ============================================================================

export const mockSource: Source = {
  name: 'sources/github/lvlup-sw/test-repo',
  id: 'github/lvlup-sw/test-repo',
  githubRepo: {
    owner: 'lvlup-sw',
    repo: 'test-repo',
    isPrivate: false,
    defaultBranch: { displayName: 'main' },
    branches: [
      { displayName: 'main' },
      { displayName: 'develop' }
    ]
  }
};

export const mockPrivateSource: Source = {
  name: 'sources/github/lvlup-sw/private-repo',
  id: 'github/lvlup-sw/private-repo',
  githubRepo: {
    owner: 'lvlup-sw',
    repo: 'private-repo',
    isPrivate: true,
    defaultBranch: { displayName: 'main' },
    branches: [{ displayName: 'main' }]
  }
};

// ============================================================================
// Session Fixtures
// ============================================================================

export const mockSession: Session = {
  name: 'abc123',
  id: 'abc123',
  prompt: 'Add user profile feature with TDD',
  title: 'Add user profile feature',
  state: 'QUEUED',
  url: 'https://jules.google/sessions/abc123',
  createTime: '2025-01-04T00:00:00Z',
  updateTime: '2025-01-04T00:00:00Z'
};

export const mockSessionPlanning: Session = {
  ...mockSession,
  state: 'PLANNING',
  updateTime: '2025-01-04T00:01:00Z'
};

export const mockSessionAwaitingApproval: Session = {
  ...mockSession,
  state: 'AWAITING_PLAN_APPROVAL',
  updateTime: '2025-01-04T00:02:00Z'
};

export const mockSessionInProgress: Session = {
  ...mockSession,
  state: 'IN_PROGRESS',
  updateTime: '2025-01-04T00:03:00Z'
};

export const mockPullRequest: PullRequestOutput = {
  url: 'https://github.com/lvlup-sw/test-repo/pull/42',
  title: 'Add user profile feature',
  number: 42
};

export const mockSessionCompleted: Session = {
  ...mockSession,
  state: 'COMPLETED',
  updateTime: '2025-01-04T01:00:00Z',
  outputs: [mockPullRequest]
};

export const mockSessionFailed: Session = {
  ...mockSession,
  state: 'FAILED',
  updateTime: '2025-01-04T00:30:00Z'
};

// ============================================================================
// Activity Fixtures
// ============================================================================

export const mockActivityPlanning: Activity = {
  name: 'sessions/abc123/activities/1',
  type: 'PLANNING',
  message: 'Analyzing codebase structure',
  createTime: '2025-01-04T00:01:00Z'
};

export const mockActivityCoding: Activity = {
  name: 'sessions/abc123/activities/2',
  type: 'CODING',
  message: 'Implementing UserProfile entity',
  createTime: '2025-01-04T00:05:00Z'
};

export const mockActivityTesting: Activity = {
  name: 'sessions/abc123/activities/3',
  type: 'TESTING',
  message: 'Running test suite',
  createTime: '2025-01-04T00:10:00Z'
};

// ============================================================================
// Error Response Fixtures
// ============================================================================

export const mockErrorUnauthorized = {
  error: {
    code: 401,
    message: 'Invalid API key',
    status: 'UNAUTHENTICATED'
  }
};

export const mockErrorNotFound = {
  error: {
    code: 404,
    message: 'Session not found',
    status: 'NOT_FOUND'
  }
};

export const mockErrorBadRequest = {
  error: {
    code: 400,
    message: 'Session not awaiting plan approval',
    status: 'FAILED_PRECONDITION'
  }
};

export const mockErrorSourceNotFound = {
  error: {
    code: 404,
    message: 'Source not found',
    status: 'NOT_FOUND'
  }
};
