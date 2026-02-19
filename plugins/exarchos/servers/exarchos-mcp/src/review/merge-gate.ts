// ─── Types ──────────────────────────────────────────────────────────────────

export type SelfHostedResult = 'pass' | 'findings' | 'fail';
export type CodeRabbitResult = 'pass' | 'findings' | 'skipped' | 'pending';
export type GateDecision = 'approved' | 'wait' | 'block';

export interface ReviewGateInput {
  selfHosted: SelfHostedResult;
  coderabbit: CodeRabbitResult;
  selfHostedHasCriticalMajor: boolean;
  coderabbitHasCriticalMajor: boolean;
}

export interface ReviewGateOutput {
  decision: GateDecision;
  reason: string;
}

export interface EscalationCheck {
  shouldEscalate: boolean;
  reason?: string;
}

// ─── Merge Gate Decision Logic ──────────────────────────────────────────────

export function evaluateMergeGate(input: ReviewGateInput): ReviewGateOutput {
  // Self-hosted FAIL → BLOCK (regardless of CodeRabbit)
  if (input.selfHosted === 'fail') {
    return { decision: 'block', reason: 'Blocked: self-hosted review failed' };
  }

  // CodeRabbit FINDINGS with critical/major → BLOCK (regardless of self-hosted)
  if (input.coderabbitHasCriticalMajor) {
    return { decision: 'block', reason: 'Blocked: CodeRabbit found critical/major findings' };
  }

  // Self-hosted PASS + CodeRabbit PENDING → WAIT
  if (input.coderabbit === 'pending') {
    return { decision: 'wait', reason: 'Waiting: CodeRabbit review is pending' };
  }

  // Self-hosted PASS + CodeRabbit PASS → APPROVED
  if (input.selfHosted === 'pass' && input.coderabbit === 'pass') {
    return { decision: 'approved', reason: 'Approved: both reviewers passed' };
  }

  // Self-hosted PASS + CodeRabbit SKIPPED → APPROVED
  if (input.selfHosted === 'pass' && input.coderabbit === 'skipped') {
    return { decision: 'approved', reason: 'Approved: low-risk, velocity-triaged' };
  }

  // Self-hosted FINDINGS (minor) + CodeRabbit PASS → APPROVED
  if (input.selfHosted === 'findings' && !input.selfHostedHasCriticalMajor && input.coderabbit === 'pass') {
    return { decision: 'approved', reason: 'Approved: minor self-hosted findings only' };
  }

  // Self-hosted PASS + CodeRabbit FINDINGS (minor only) → APPROVED
  if (input.selfHosted === 'pass' && input.coderabbit === 'findings' && !input.coderabbitHasCriticalMajor) {
    return { decision: 'approved', reason: 'Approved: CodeRabbit findings are minor only' };
  }

  // Self-hosted FINDINGS + CodeRabbit FINDINGS (minor on both sides) → APPROVED
  if (input.selfHosted === 'findings' && input.coderabbit === 'findings' && !input.selfHostedHasCriticalMajor && !input.coderabbitHasCriticalMajor) {
    return { decision: 'approved', reason: 'Approved: all findings are minor' };
  }

  // Default: block for any unhandled combination with findings
  return { decision: 'block', reason: 'Blocked: unresolved findings require attention' };
}

// ─── Secondary Escalation Logic ─────────────────────────────────────────────

export function checkEscalation(
  selfHostedResult: SelfHostedResult,
  coderabbitResult: CodeRabbitResult,
  selfHostedMaxSeverity: 'critical' | 'major' | 'minor' | 'suggestion' | 'none',
): EscalationCheck {
  // Only escalate if CodeRabbit was skipped (velocity-triaged as low-risk)
  if (coderabbitResult !== 'skipped') {
    return { shouldEscalate: false };
  }

  // Only escalate if self-hosted found severity >= medium (major or critical)
  if (selfHostedMaxSeverity === 'major' || selfHostedMaxSeverity === 'critical') {
    return {
      shouldEscalate: true,
      reason: `Self-hosted found ${selfHostedMaxSeverity} issue on velocity-triaged PR; escalating to CodeRabbit`,
    };
  }

  return { shouldEscalate: false };
}
