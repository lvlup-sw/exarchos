import { describe, it, expect } from 'vitest';
import type {
  PRDiffMetadata,
  RiskFactor,
  PRRiskScore,
  VelocityTier,
  ReviewContext,
  ReviewDispatch,
} from './types.js';
import { scorePR } from './scoring.js';
import { detectVelocity } from './velocity.js';
import { dispatchReviews, THRESHOLDS } from './dispatch.js';

// =============================================================================
// T1 & T2: Type construction tests
// =============================================================================

describe('types', () => {
  describe('PRDiffMetadata', () => {
    it('should accept a valid PRDiffMetadata object', () => {
      const metadata: PRDiffMetadata = {
        number: 42,
        paths: ['src/auth/middleware.ts'],
        linesChanged: 150,
        filesChanged: 3,
        newFiles: 1,
      };
      expect(metadata.number).toBe(42);
      expect(metadata.paths).toHaveLength(1);
      expect(metadata.linesChanged).toBe(150);
      expect(metadata.filesChanged).toBe(3);
      expect(metadata.newFiles).toBe(1);
    });
  });

  describe('RiskFactor', () => {
    it('should accept a valid RiskFactor object', () => {
      const factor: RiskFactor = {
        name: 'security-path',
        weight: 0.3,
        matched: true,
        detail: 'Matched auth path',
      };
      expect(factor.name).toBe('security-path');
      expect(factor.weight).toBe(0.3);
      expect(factor.matched).toBe(true);
      expect(factor.detail).toBe('Matched auth path');
    });
  });

  describe('PRRiskScore', () => {
    it('should accept a valid PRRiskScore object', () => {
      const score: PRRiskScore = {
        pr: 42,
        score: 0.65,
        factors: [
          { name: 'security-path', weight: 0.3, matched: true, detail: 'auth path' },
        ],
        recommendation: 'coderabbit',
      };
      expect(score.pr).toBe(42);
      expect(score.score).toBe(0.65);
      expect(score.factors).toHaveLength(1);
      expect(score.recommendation).toBe('coderabbit');
    });
  });

  describe('VelocityTier', () => {
    it('should accept valid velocity tier values', () => {
      const tiers: VelocityTier[] = ['normal', 'elevated', 'high'];
      expect(tiers).toHaveLength(3);
      expect(tiers).toContain('normal');
      expect(tiers).toContain('elevated');
      expect(tiers).toContain('high');
    });
  });

  describe('ReviewContext', () => {
    it('should accept a valid ReviewContext object', () => {
      const context: ReviewContext = {
        activeWorkflows: [{ phase: 'delegate' }, { phase: 'review' }],
        pendingCodeRabbitReviews: 3,
      };
      expect(context.activeWorkflows).toHaveLength(2);
      expect(context.pendingCodeRabbitReviews).toBe(3);
    });
  });

  describe('ReviewDispatch', () => {
    it('should accept a valid ReviewDispatch object', () => {
      const dispatch: ReviewDispatch = {
        pr: 42,
        riskScore: {
          pr: 42,
          score: 0.5,
          factors: [],
          recommendation: 'coderabbit',
        },
        coderabbit: true,
        selfHosted: true,
        velocity: 'normal',
        reason: 'Risk 0.50 >= threshold 0.0 (normal)',
      };
      expect(dispatch.pr).toBe(42);
      expect(dispatch.coderabbit).toBe(true);
      expect(dispatch.selfHosted).toBe(true);
      expect(dispatch.velocity).toBe('normal');
    });
  });
});

// =============================================================================
// T4: scorePR tests
// =============================================================================

describe('scorePR', () => {
  it('should return high score for security paths', () => {
    const pr: PRDiffMetadata = {
      number: 1,
      paths: ['src/auth/middleware.ts'],
      linesChanged: 50,
      filesChanged: 1,
      newFiles: 0,
    };
    const result = scorePR(pr);
    expect(result.score).toBeGreaterThanOrEqual(0.30);
    const securityFactor = result.factors.find(f => f.name === 'security-path');
    expect(securityFactor?.matched).toBe(true);
  });

  it('should include API surface weight for API paths', () => {
    const pr: PRDiffMetadata = {
      number: 2,
      paths: ['src/api/users/controller.ts'],
      linesChanged: 30,
      filesChanged: 1,
      newFiles: 0,
    };
    const result = scorePR(pr);
    const apiFactor = result.factors.find(f => f.name === 'api-surface');
    expect(apiFactor?.matched).toBe(true);
    expect(apiFactor?.weight).toBe(0.20);
  });

  it('should include diff-complexity weight for large changes', () => {
    const pr: PRDiffMetadata = {
      number: 3,
      paths: ['src/utils/helper.ts'],
      linesChanged: 400,
      filesChanged: 12,
      newFiles: 0,
    };
    const result = scorePR(pr);
    const complexityFactor = result.factors.find(f => f.name === 'diff-complexity');
    expect(complexityFactor?.matched).toBe(true);
    expect(complexityFactor?.weight).toBe(0.15);
  });

  it('should include new-files weight when new files exist', () => {
    const pr: PRDiffMetadata = {
      number: 4,
      paths: ['src/utils/helper.ts'],
      linesChanged: 20,
      filesChanged: 1,
      newFiles: 2,
    };
    const result = scorePR(pr);
    const newFilesFactor = result.factors.find(f => f.name === 'new-files');
    expect(newFilesFactor?.matched).toBe(true);
    expect(newFilesFactor?.weight).toBe(0.10);
  });

  it('should include infra-config weight for infrastructure paths', () => {
    const pr: PRDiffMetadata = {
      number: 5,
      paths: ['Dockerfile'],
      linesChanged: 10,
      filesChanged: 1,
      newFiles: 0,
    };
    const result = scorePR(pr);
    const infraFactor = result.factors.find(f => f.name === 'infra-config');
    expect(infraFactor?.matched).toBe(true);
    expect(infraFactor?.weight).toBe(0.15);
  });

  it('should include cross-module weight for paths spanning multiple directories', () => {
    const pr: PRDiffMetadata = {
      number: 6,
      paths: ['src/utils/helper.ts', 'lib/core/engine.ts', 'test/fixtures/data.ts'],
      linesChanged: 50,
      filesChanged: 3,
      newFiles: 0,
    };
    const result = scorePR(pr);
    const crossModuleFactor = result.factors.find(f => f.name === 'cross-module');
    expect(crossModuleFactor?.matched).toBe(true);
    expect(crossModuleFactor?.weight).toBe(0.10);
  });

  it('should return score 1.0 when all factors match', () => {
    const pr: PRDiffMetadata = {
      number: 7,
      paths: [
        'src/auth/login.ts',          // security-path
        'lib/api/users/controller.ts', // api-surface + cross-module (src, lib, infra)
        'infra/deploy/config.yml',     // infra-config
      ],
      linesChanged: 500,              // diff-complexity (>300)
      filesChanged: 15,               // diff-complexity (>10)
      newFiles: 3,                    // new-files
    };
    const result = scorePR(pr);
    expect(result.score).toBe(1.0);
  });

  it('should return score 0.0 when no factors match', () => {
    const pr: PRDiffMetadata = {
      number: 8,
      paths: ['src/utils/format.test.ts'],
      linesChanged: 10,
      filesChanged: 1,
      newFiles: 0,
    };
    const result = scorePR(pr);
    expect(result.score).toBe(0.0);
  });

  it('should recommend coderabbit when score >= 0.4', () => {
    const pr: PRDiffMetadata = {
      number: 9,
      paths: ['src/auth/middleware.ts', 'src/api/handler.ts'],
      linesChanged: 50,
      filesChanged: 2,
      newFiles: 0,
    };
    const result = scorePR(pr);
    // security-path (0.30) + api-surface (0.20) = 0.50 >= 0.4
    expect(result.score).toBeGreaterThanOrEqual(0.4);
    expect(result.recommendation).toBe('coderabbit');
  });

  it('should recommend self-hosted when score < 0.4', () => {
    const pr: PRDiffMetadata = {
      number: 10,
      paths: ['src/utils/format.ts'],
      linesChanged: 20,
      filesChanged: 1,
      newFiles: 1,
    };
    const result = scorePR(pr);
    // Only new-files (0.10) matches → 0.10 < 0.4
    expect(result.score).toBeLessThan(0.4);
    expect(result.recommendation).toBe('self-hosted');
  });
});

// =============================================================================
// T5: detectVelocity tests
// =============================================================================

describe('detectVelocity', () => {
  it('should return normal when no pressure', () => {
    const context: ReviewContext = {
      activeWorkflows: [],
      pendingCodeRabbitReviews: 0,
    };
    expect(detectVelocity(context)).toBe('normal');
  });

  it('should return elevated when multiple stacks are active', () => {
    const context: ReviewContext = {
      activeWorkflows: [{ phase: 'review' }, { phase: 'delegate' }],
      pendingCodeRabbitReviews: 3,
    };
    expect(detectVelocity(context)).toBe('elevated');
  });

  it('should return high when pending reviews exceed 6', () => {
    const context: ReviewContext = {
      activeWorkflows: [{ phase: 'delegate' }],
      pendingCodeRabbitReviews: 7,
    };
    expect(detectVelocity(context)).toBe('high');
  });

  it('should return high when pending reviews override active stacks', () => {
    const context: ReviewContext = {
      activeWorkflows: [{ phase: 'review' }, { phase: 'synthesize' }],
      pendingCodeRabbitReviews: 8,
    };
    expect(detectVelocity(context)).toBe('high');
  });

  it('should return normal with single stack in delegate phase', () => {
    const context: ReviewContext = {
      activeWorkflows: [{ phase: 'delegate' }],
      pendingCodeRabbitReviews: 2,
    };
    expect(detectVelocity(context)).toBe('normal');
  });
});

// =============================================================================
// T6: dispatchReviews tests
// =============================================================================

describe('dispatchReviews', () => {
  const lowRiskPR: PRDiffMetadata = {
    number: 100,
    paths: ['src/utils/format.test.ts'],
    linesChanged: 10,
    filesChanged: 1,
    newFiles: 0,
  };

  const highRiskPR: PRDiffMetadata = {
    number: 200,
    paths: ['src/auth/login.ts', 'src/api/handler.ts'],
    linesChanged: 400,
    filesChanged: 12,
    newFiles: 2,
  };

  it('should send all PRs to CodeRabbit at normal velocity', () => {
    const dispatches = dispatchReviews([lowRiskPR, highRiskPR], 'normal', false);
    expect(dispatches).toHaveLength(2);
    expect(dispatches.every(d => d.coderabbit)).toBe(true);
  });

  it('should filter by threshold at elevated velocity', () => {
    const dispatches = dispatchReviews([lowRiskPR, highRiskPR], 'elevated', false);
    const lowRiskDispatch = dispatches.find(d => d.pr === 100);
    const highRiskDispatch = dispatches.find(d => d.pr === 200);
    // lowRiskPR score = 0.0 < 0.3 threshold → no CodeRabbit
    expect(lowRiskDispatch?.coderabbit).toBe(false);
    // highRiskPR score is high → CodeRabbit
    expect(highRiskDispatch?.coderabbit).toBe(true);
  });

  it('should only send high-risk PRs to CodeRabbit at high velocity', () => {
    const dispatches = dispatchReviews([lowRiskPR, highRiskPR], 'high', false);
    const lowRiskDispatch = dispatches.find(d => d.pr === 100);
    const highRiskDispatch = dispatches.find(d => d.pr === 200);
    expect(lowRiskDispatch?.coderabbit).toBe(false);
    expect(highRiskDispatch?.coderabbit).toBe(true);
  });

  it('should always set selfHosted to true for all PRs', () => {
    const dispatches = dispatchReviews([lowRiskPR, highRiskPR], 'high', false);
    expect(dispatches.every(d => d.selfHosted === true)).toBe(true);
  });

  it('should include score and threshold in reason', () => {
    const dispatches = dispatchReviews([highRiskPR], 'elevated', false);
    const dispatch = dispatches[0];
    expect(dispatch.reason).toContain(dispatch.riskScore.score.toFixed(2));
    expect(dispatch.reason).toContain(String(THRESHOLDS.elevated));
  });

  it('should work normally when basileusConnected is false', () => {
    const dispatches = dispatchReviews([lowRiskPR], 'normal', false);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].coderabbit).toBe(true);
    expect(dispatches[0].selfHosted).toBe(true);
  });
});
