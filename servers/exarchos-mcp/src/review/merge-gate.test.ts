import { describe, it, expect } from 'vitest';
import {
  evaluateMergeGate,
  checkEscalation,
} from './merge-gate.js';
import type {
  ReviewGateInput,
  ReviewGateOutput,
  EscalationCheck,
} from './merge-gate.js';

// ─── T7: Merge Gate Decision Logic ─────────────────────────────────────────

describe('evaluateMergeGate', () => {
  it('mergeGate_SelfHostedPass_CodeRabbitPass_Approves', () => {
    const input: ReviewGateInput = {
      selfHosted: 'pass',
      coderabbit: 'pass',
      selfHostedHasCriticalMajor: false,
      coderabbitHasCriticalMajor: false,
    };
    const result = evaluateMergeGate(input);
    expect(result.decision).toBe('approved');
  });

  it('mergeGate_SelfHostedPass_CodeRabbitSkipped_Approves', () => {
    const input: ReviewGateInput = {
      selfHosted: 'pass',
      coderabbit: 'skipped',
      selfHostedHasCriticalMajor: false,
      coderabbitHasCriticalMajor: false,
    };
    const result = evaluateMergeGate(input);
    expect(result.decision).toBe('approved');
  });

  it('mergeGate_SelfHostedFindings_CodeRabbitPass_Approves', () => {
    const input: ReviewGateInput = {
      selfHosted: 'findings',
      coderabbit: 'pass',
      selfHostedHasCriticalMajor: false,
      coderabbitHasCriticalMajor: false,
    };
    const result = evaluateMergeGate(input);
    expect(result.decision).toBe('approved');
    expect(result.reason).toContain('minor');
  });

  it('mergeGate_SelfHostedPass_CodeRabbitFindingsCritical_Blocks', () => {
    const input: ReviewGateInput = {
      selfHosted: 'pass',
      coderabbit: 'findings',
      selfHostedHasCriticalMajor: false,
      coderabbitHasCriticalMajor: true,
    };
    const result = evaluateMergeGate(input);
    expect(result.decision).toBe('block');
  });

  it('mergeGate_SelfHostedPass_CodeRabbitFindingsMinor_Approves', () => {
    const input: ReviewGateInput = {
      selfHosted: 'pass',
      coderabbit: 'findings',
      selfHostedHasCriticalMajor: false,
      coderabbitHasCriticalMajor: false,
    };
    const result = evaluateMergeGate(input);
    expect(result.decision).toBe('approved');
  });

  it('mergeGate_SelfHostedFail_Blocks', () => {
    const input: ReviewGateInput = {
      selfHosted: 'fail',
      coderabbit: 'pass',
      selfHostedHasCriticalMajor: true,
      coderabbitHasCriticalMajor: false,
    };
    const result = evaluateMergeGate(input);
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('self-hosted');
  });

  it('mergeGate_CodeRabbitCriticalMajor_Blocks', () => {
    const input: ReviewGateInput = {
      selfHosted: 'findings',
      coderabbit: 'findings',
      selfHostedHasCriticalMajor: false,
      coderabbitHasCriticalMajor: true,
    };
    const result = evaluateMergeGate(input);
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('CodeRabbit');
  });

  it('mergeGate_SelfHostedPass_CodeRabbitPending_Waits', () => {
    const input: ReviewGateInput = {
      selfHosted: 'pass',
      coderabbit: 'pending',
      selfHostedHasCriticalMajor: false,
      coderabbitHasCriticalMajor: false,
    };
    const result = evaluateMergeGate(input);
    expect(result.decision).toBe('wait');
    expect(result.reason).toContain('pending');
  });
});

// ─── T8: Escalation Logic ──────────────────────────────────────────────────

describe('checkEscalation', () => {
  it('escalation_SelfHostedMajorFinding_CodeRabbitSkipped_Escalates', () => {
    const result = checkEscalation('findings', 'skipped', 'major');
    expect(result.shouldEscalate).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it('escalation_SelfHostedCriticalFinding_CodeRabbitSkipped_Escalates', () => {
    const result = checkEscalation('findings', 'skipped', 'critical');
    expect(result.shouldEscalate).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it('escalation_SelfHostedMinorFinding_CodeRabbitSkipped_NoEscalation', () => {
    const result = checkEscalation('findings', 'skipped', 'minor');
    expect(result.shouldEscalate).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('escalation_SelfHostedMajorFinding_CodeRabbitReviewed_NoEscalation', () => {
    const result = checkEscalation('findings', 'pass', 'major');
    expect(result.shouldEscalate).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('escalation_SelfHostedNone_CodeRabbitSkipped_NoEscalation', () => {
    const result = checkEscalation('pass', 'skipped', 'none');
    expect(result.shouldEscalate).toBe(false);
    expect(result.reason).toBeUndefined();
  });
});
