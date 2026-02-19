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
