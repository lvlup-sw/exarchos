import { describe, it, expect } from 'vitest';
import { proposeDesignDepth, resolveFrozenDepth } from '../../../src/workflow/depth-proposal.js';
import type { DesignDepth } from '../../../src/workflow/plan-depth-policy.js';

describe('proposeDesignDepth (DR-3, #1581 task 006)', () => {
  /**
   * A deep proposal must ask for author confirmation. High blast radius and a large task count
   * each propose deep too.
   */
  it('DepthProposal_HighUncertaintySignal_ProposesDeep', () => {
    const proposal = proposeDesignDepth({ uncertainty: 'high' });
    expect(proposal.proposed).toBe('deep');
    expect(proposal.requiresAuthorConfirmation).toBe(true);

    expect(proposeDesignDepth({ blastRadius: 'high' }).proposed).toBe('deep');
    expect(proposeDesignDepth({ taskCount: 20 }).proposed).toBe('deep');
  });

  /** An empty brief proposes `'standard'`. An all-low brief with few tasks proposes `'thin'`. */
  it('DepthProposal_SparseBrief_ConservativeDefaults', () => {
    expect(proposeDesignDepth({}).proposed).toBe('standard');
    expect(proposeDesignDepth({}).requiresAuthorConfirmation).toBe(false);
    const thin = proposeDesignDepth({ uncertainty: 'low', blastRadius: 'low', taskCount: 2 });
    expect(thin.proposed).toBe('thin');
    expect(thin.requiresAuthorConfirmation).toBe(false);
  });

  /** The author override freezes in both directions, because an explicit override is the confirmation. */
  it('DepthProposal_AuthorOverride_FreezesOverrideNotProposal', () => {
    const proposal = proposeDesignDepth({ uncertainty: 'high' });
    expect(proposal.proposed).toBe('deep');
    expect(resolveFrozenDepth('thin', proposal)).toBe('thin');

    const standard = proposeDesignDepth({});
    expect(standard.proposed).toBe('standard');
    expect(resolveFrozenDepth('deep', standard)).toBe('deep');
  });

  /**
   * Without an override, a deep proposal freezes as `'standard'`. Other proposals freeze as
   * proposed.
   */
  it('ResolveFrozenDepth_UnconfirmedDeepProposal_FreezesStandardNotDeep', () => {
    const deep = proposeDesignDepth({ blastRadius: 'high' });
    expect(deep.proposed).toBe('deep');
    expect(resolveFrozenDepth(undefined, deep)).toBe('standard');

    expect(resolveFrozenDepth(undefined, proposeDesignDepth({ taskCount: 2 }))).toBe('thin');
    expect(resolveFrozenDepth(undefined, proposeDesignDepth({}))).toBe('standard');
  });

  it('ResolveFrozenDepth_HonorsEveryExplicitOverride', () => {
    const proposal = proposeDesignDepth({ uncertainty: 'high' });
    const depths: DesignDepth[] = ['thin', 'standard', 'deep'];
    for (const d of depths) {
      expect(resolveFrozenDepth(d, proposal)).toBe(d);
    }
  });
});
