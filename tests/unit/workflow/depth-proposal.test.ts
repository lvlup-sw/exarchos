import { describe, it, expect } from 'vitest';
import { proposeDesignDepth, resolveFrozenDepth } from '../../../src/workflow/depth-proposal.js';
import type { DesignDepth } from '../../../src/workflow/plan-depth-policy.js';

describe('proposeDesignDepth (DR-3, #1581 task 006)', () => {
  it('DepthProposal_HighUncertaintySignal_ProposesDeep', () => {
    const proposal = proposeDesignDepth({ uncertainty: 'high' });
    expect(proposal.proposed).toBe('deep');
    // A deep proposal must flag that it needs explicit author confirmation —
    // it is never silently escalated/frozen.
    expect(proposal.requiresAuthorConfirmation).toBe(true);

    // High blast radius and a large task count independently propose deep too.
    expect(proposeDesignDepth({ blastRadius: 'high' }).proposed).toBe('deep');
    expect(proposeDesignDepth({ taskCount: 20 }).proposed).toBe('deep');
  });

  it('DepthProposal_SparseBrief_ConservativeDefaults', () => {
    // Empty / unknown brief ⇒ the behavior-neutral 'standard' default, never deep.
    expect(proposeDesignDepth({}).proposed).toBe('standard');
    expect(proposeDesignDepth({}).requiresAuthorConfirmation).toBe(false);
    // All-low, small scope ⇒ thin (minimal preamble), non-escalating.
    const thin = proposeDesignDepth({ uncertainty: 'low', blastRadius: 'low', taskCount: 2 });
    expect(thin.proposed).toBe('thin');
    expect(thin.requiresAuthorConfirmation).toBe(false);
  });

  it('DepthProposal_AuthorOverride_FreezesOverrideNotProposal', () => {
    // The auto-proposal says deep; the author overrides to thin — the FROZEN
    // value is the override, not the proposal.
    const proposal = proposeDesignDepth({ uncertainty: 'high' });
    expect(proposal.proposed).toBe('deep');
    expect(resolveFrozenDepth('thin', proposal)).toBe('thin');

    // Override wins in the other direction too: a 'standard' proposal with a
    // 'deep' author override freezes deep (explicit override IS confirmation).
    const standard = proposeDesignDepth({});
    expect(standard.proposed).toBe('standard');
    expect(resolveFrozenDepth('deep', standard)).toBe('deep');
  });

  it('ResolveFrozenDepth_UnconfirmedDeepProposal_FreezesStandardNotDeep', () => {
    // No author override + a deep proposal ⇒ NO silent escalation: freeze the
    // conservative 'standard', never 'deep'.
    const deep = proposeDesignDepth({ blastRadius: 'high' });
    expect(deep.proposed).toBe('deep');
    expect(resolveFrozenDepth(undefined, deep)).toBe('standard');

    // Non-escalating proposals freeze directly when there is no override.
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
