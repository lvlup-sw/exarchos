// Jules API Types - based on https://jules.google/docs/api/reference/

// ============================================================================
// Source Types
// ============================================================================

export interface Branch {
  displayName: string;
}

export interface GitHubRepo {
  owner: string;
  repo: string;
  isPrivate: boolean;
  defaultBranch: Branch;
  branches: Branch[];
}

export interface Source {
  name: string; // "sources/github/{owner}/{repo}"
  id: string; // "github/{owner}/{repo}"
  githubRepo: GitHubRepo;
}

export interface ListSourcesResponse {
  sources: Source[];
  nextPageToken?: string;
}

// ============================================================================
// Session Types
// ============================================================================

export type SessionState =
  | 'QUEUED'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'AWAITING_USER_FEEDBACK'
  | 'IN_PROGRESS'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type AutomationMode = 'AUTO_CREATE_PR' | 'MANUAL';

export interface GitHubRepoContext {
  startingBranch?: string;
}

export interface SourceContext {
  source: string; // "sources/github/{owner}/{repo}"
  githubRepoContext?: GitHubRepoContext;
}

export interface PullRequestOutput {
  url: string;
  title: string;
  number: number;
}

export interface Session {
  name: string; // Resource identifier
  id: string; // Unique session ID
  prompt: string;
  title: string;
  state: SessionState;
  url: string; // Web URL to session
  createTime: string; // ISO 8601
  updateTime: string; // ISO 8601
  outputs?: PullRequestOutput[];
}

export interface ListSessionsResponse {
  sessions: Session[];
  nextPageToken?: string;
}

// ============================================================================
// Request Parameter Types
// ============================================================================

export interface CreateSessionParams {
  prompt: string;
  sourceContext: SourceContext;
  title?: string;
  requirePlanApproval?: boolean; // default: true
  automationMode?: AutomationMode;
}

export interface SendMessageParams {
  prompt: string;
}

// ============================================================================
// Activity Types
// ============================================================================

export type ActivityEventType =
  | 'planGenerated'
  | 'planApproved'
  | 'userMessaged'
  | 'agentMessaged'
  | 'progressUpdated'
  | 'sessionCompleted'
  | 'sessionFailed';

export interface Artifact {
  type: 'changeset' | 'bashOutput' | 'media';
  // ChangeSet fields
  baseCommitId?: string;
  unidiffPatch?: string;
  suggestedCommitMessage?: string;
  // Bash output fields
  command?: string;
  output?: string;
  exitCode?: number;
  // Media fields
  mimeType?: string;
  data?: string; // base64
}

export interface Activity {
  name: string;
  id: string;
  originator: 'system' | 'agent' | 'user';
  description: string;
  createTime: string;

  // Event-specific content (exactly one will be present)
  planGenerated?: { steps: string[] };
  planApproved?: { approvedBy: string };
  userMessaged?: { content: string };
  agentMessaged?: { content: string };
  progressUpdated?: { status: string };
  sessionCompleted?: { summary: string };
  sessionFailed?: { reason: string };

  artifacts?: Artifact[];
}

export interface ListActivitiesResponse {
  activities: Activity[];
  nextPageToken?: string;
}

// ============================================================================
// Error Types
// ============================================================================

export interface JulesApiError {
  code: number;
  message: string;
  status: string;
}

export interface JulesApiErrorResponse {
  error: JulesApiError;
}

// ============================================================================
// Client Interface
// ============================================================================

export interface IJulesClient {
  listSources(): Promise<Source[]>;
  createSession(params: CreateSessionParams): Promise<Session>;
  getSession(sessionId: string): Promise<Session>;
  listSessions(): Promise<Session[]>;
  approvePlan(sessionId: string): Promise<void>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  getActivities(sessionId: string): Promise<Activity[]>;
  deleteSession(sessionId: string): Promise<void>;
}

// ============================================================================
// MCP Tool Types
// ============================================================================

export interface ToolContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

// Tool-specific response types
export interface CreateTaskResult {
  sessionId: string;
  state: SessionState;
  url: string;
  message: string;
}

export interface CheckStatusResult {
  sessionId: string;
  state: SessionState;
  title: string;
  url: string;
  pullRequestUrl?: string;
  updatedAt: string;
}

export interface OperationResult {
  success: boolean;
  sessionId: string;
  message: string;
}
