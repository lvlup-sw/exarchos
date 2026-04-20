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

// ─── Review Action Items (Issue #1159) ──────────────────────────────────────
// Canonical types for the multi-reviewer fixer-dispatch pipeline.
// Adapters in src/review/providers/ produce ActionItem values from raw
// VcsPrComment input. assess-stack.ts re-exports these for backwards compat.

import type { PrComment as VcsPrComment } from '../vcs/provider.js';

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
  readonly file?: string;
  readonly line?: number;
  readonly reviewer?: ReviewerKind;
  readonly threadId?: string;
  readonly raw?: unknown;
  readonly normalizedSeverity?: Severity;
  /**
   * True when the adapter could not match any recognised severity tier
   * in the comment body. Surfaced via the `provider.unknown-tier` event
   * by assess_stack so that drift in upstream tier vocabulary is visible
   * (#1159).
   */
  readonly unknownTier?: boolean;
}

export interface ProviderAdapter {
  readonly kind: ReviewerKind;
  parse(rawComment: VcsPrComment): ActionItem | null;
}

export interface ReviewAdapterRegistry {
  forReviewer(kind: ReviewerKind): ProviderAdapter | undefined;
  list(): readonly ProviderAdapter[];
}

// ─── Review Classification (Issue #1159 Phase 2) ────────────────────────────
// classify_review_items groups parsed ActionItems by file and recommends a
// dispatch strategy per group. Replaces the prose direct-vs-delegate
// heuristic in skills-src/shepherd/references/fix-strategies.md.

export type DispatchRecommendation = 'direct' | 'delegate-fixer' | 'delegate-scaffolder';

export interface ClassificationGroup {
  readonly file: string | null;        // null = file-less group (e.g. PR-level comments)
  readonly items: readonly ActionItem[];
  readonly severity: Severity;          // max severity in the group
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
