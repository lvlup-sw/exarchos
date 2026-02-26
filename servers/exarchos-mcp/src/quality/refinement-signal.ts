// ─── Refinement Signal Types ─────────────────────────────────────────────────

export interface RefinementEvidence {
  readonly metric: string;
  readonly baseline: number;
  readonly current: number;
  readonly threshold: number;
}

export interface RefinementSignal {
  readonly skill: string;
  readonly signalConfidence: 'high' | 'medium';
  readonly trigger: 'regression' | 'trend-degradation' | 'attribution-outlier';
  readonly evidence: RefinementEvidence;
  readonly suggestedAction: string;
  readonly affectedPromptPaths: string[];
}
