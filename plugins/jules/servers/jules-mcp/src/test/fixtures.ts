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
  id: '1',
  originator: 'agent',
  description: 'Analyzing codebase structure',
  createTime: '2025-01-04T00:01:00Z',
  planGenerated: { steps: ['Analyze codebase', 'Create UserProfile entity', 'Add tests'] }
};

export const mockActivityCoding: Activity = {
  name: 'sessions/abc123/activities/2',
  id: '2',
  originator: 'agent',
  description: 'Implementing UserProfile entity',
  createTime: '2025-01-04T00:05:00Z',
  progressUpdated: { status: 'Implementing UserProfile entity' }
};

export const mockActivityTesting: Activity = {
  name: 'sessions/abc123/activities/3',
  id: '3',
  originator: 'agent',
  description: 'Running test suite',
  createTime: '2025-01-04T00:10:00Z',
  progressUpdated: { status: 'Running test suite' }
};

// Agent message with a question (for pending question detection)
export const mockActivityAgentQuestion: Activity = {
  name: 'sessions/abc123/activities/q1',
  id: 'q1',
  originator: 'agent',
  description: 'Agent asked for clarification',
  createTime: '2025-01-04T00:15:00Z',
  agentMessaged: {
    content: 'Which database should I use for this project? PostgreSQL or MongoDB?'
  }
};

// Agent message without a question (plain statement)
export const mockActivityAgentStatement: Activity = {
  name: 'sessions/abc123/activities/s1',
  id: 's1',
  originator: 'agent',
  description: 'Agent provided update',
  createTime: '2025-01-04T00:20:00Z',
  agentMessaged: {
    content: 'I have completed the user authentication module. All tests are passing.'
  }
};

// User message
export const mockActivityUserMessage: Activity = {
  name: 'sessions/abc123/activities/u1',
  id: 'u1',
  originator: 'user',
  description: 'User sent message',
  createTime: '2025-01-04T00:16:00Z',
  userMessaged: {
    content: 'Please use PostgreSQL for better relational data support.'
  }
};

// Plan generated with steps
export const mockActivityPlanGenerated: Activity = {
  name: 'sessions/abc123/activities/p1',
  id: 'p1',
  originator: 'agent',
  description: 'Plan generated',
  createTime: '2025-01-04T00:05:00Z',
  planGenerated: {
    steps: [
      'Set up project structure',
      'Create database schema',
      'Implement user authentication',
      'Add API endpoints',
      'Write tests'
    ]
  }
};

// Activity with artifacts (changeset)
export const mockActivityWithArtifacts: Activity = {
  name: 'sessions/abc123/activities/a1',
  id: 'a1',
  originator: 'agent',
  description: 'Code changes committed',
  createTime: '2025-01-04T00:30:00Z',
  progressUpdated: {
    status: 'Committed changes to feature branch'
  },
  artifacts: [
    {
      type: 'changeset',
      baseCommitId: 'abc123def456',
      unidiffPatch: '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,10 @@\n+import { hash } from "bcrypt";\n+\n export function authenticate(user: string, pass: string) {\n-  return true;\n+  const hashedPass = await hash(pass, 10);\n+  return validateCredentials(user, hashedPass);\n }',
      suggestedCommitMessage: 'feat: add password hashing to authentication'
    }
  ]
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
