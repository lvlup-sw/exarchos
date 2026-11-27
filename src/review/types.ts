export interface PRDiffMetadata {
  number: number;
  paths: string[];
  linesChanged: number;
  filesChanged: number;
  newFiles: number;
}

export interface RiskFactor {
  name: string;
  weight: number;
  matched: boolean;
  detail: string;
}

export interface PRRiskScore {
  pr: number;
  score: number;
  factors: RiskFactor[];
  recommendation: "coderabbit" | "self-hosted" | "both";
}

export type VelocityTier = "normal" | "elevated" | "high";

export interface ReviewContext {
  activeWorkflows: Array<{ phase: string }>;
  pendingCodeRabbitReviews: number;
}

export interface ReviewDispatch {
  pr: number;
  riskScore: PRRiskScore;
  coderabbit: boolean;
  selfHosted: boolean;
  velocity: VelocityTier;
  reason: string;
}

/**
 * One review comment of a pull request, as a caller supplies it to a {@link ProviderAdapter}.
 * Exarchos reads no comment from a remote service, so this type is the whole input contract.
 */
export interface ReviewComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  /** The kind of feedback: a PR-level comment, an inline review thread or a review summary. */
  readonly source: 'issue-comment' | 'review-inline' | 'review-summary';
  readonly path?: string | undefined;
  readonly line?: number | undefined;
  /** The id of the top-level comment that this reply answers. It is absent on a top-level comment. */
  readonly parentId?: number;
  /** True is resolved, false is unresolved, and an absent value is unknown. */
  readonly resolved?: boolean;
  /** The review state of a review summary, such as `APPROVED`. */
  readonly state?: string;
}

/** Severity tier of an {@link ActionItem}. */
export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';

export type ReviewerKind =
  | 'coderabbit'
  | 'sentry'
  | 'human'
  | 'github-copilot'
  | 'unknown';

export interface ActionItem {
  readonly type: 'ci-fix' | 'comment-reply' | 'review-address' | 'stack-fix';
  readonly pr: number;
  readonly description: string;
  readonly severity: 'critical' | 'major' | 'minor';
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly reviewer?: ReviewerKind;
  readonly threadId?: string;
  readonly raw?: unknown;
  readonly normalizedSeverity: Severity;
  /**
   * True when the adapter found no known severity tier in the comment body.
   * Old logs hold a `provider.unknown-tier` row for such an item, so drift in the upstream tier words is visible.
   */
  readonly unknownTier?: boolean;
  /**
   * When `unknownTier` is true, the leading marker of the comment body that the adapter did not classify.
   * The `provider.unknown-tier` event carries it as `rawTier`.
   */
  readonly rawTier?: string;
}

export interface ProviderAdapter {
  readonly kind: ReviewerKind;
  parse(rawComment: ReviewComment): ActionItem | null;
}

export interface ReviewAdapterRegistry {
  forReviewer(kind: ReviewerKind): ProviderAdapter | undefined;
  list(): readonly ProviderAdapter[];
}

/** Dispatch strategy that `classify_review_items` recommends for each file group of action items. */
export type DispatchRecommendation = 'direct' | 'delegate-fixer' | 'delegate-scaffolder';

export interface ClassificationGroup {
  /** `null` for the group of items with no file, such as PR-level comments. */
  readonly file: string | null;
  readonly items: readonly ActionItem[];
  /** Highest severity in the group. */
  readonly severity: Severity;
  readonly recommendation: DispatchRecommendation;
  readonly rationale: string;
}

export interface ClassificationSummary {
  readonly totalItems: number;
  readonly directCount: number;
  readonly delegateCount: number;
}

export interface ClassificationResult {
  readonly groups: readonly ClassificationGroup[];
  readonly summary: ClassificationSummary;
}
