/**
 * Tests for the reserved-tier guard. The `dev` tier holds the invariant ids that
 * exarchos itself ships. A consumer catalog in `tier: dev` collides with them in
 * the merged `invariants_effective` projection, and the `doctor` catalog check
 * cannot see it. Outside the exarchos repo, the guard refuses `tier: dev` at
 * authoring time and redirects to `tier: user`.
 */
import { describe, it, expect } from 'vitest';

import {
  EXARCHOS_PACKAGE_NAME,
  isExarchosRepo,
  assertDevTierAllowed,
} from '../../../../src/verbs/invariants/reserved-tier-guard.js';
import type { ScaffoldDeps } from '../../../../src/verbs/invariants/scaffold.js';

function makeDeps(files: Record<string, string>): ScaffoldDeps {
  const map = new Map<string, string>(Object.entries(files));
  return {
    exists: (p) => map.has(p),
    read: (p) => {
      const c = map.get(p);
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    },
    write: () => {
      throw new Error('guard must not write');
    },
  };
}

const exarchosPkg = JSON.stringify({ name: EXARCHOS_PACKAGE_NAME });
const consumerPkg = JSON.stringify({ name: '@acme/basileus' });

describe('isExarchosRepo', () => {
  it('isExarchosRepo_ExarchosPackageName_True', () => {
    const deps = makeDeps({ '/repo/package.json': exarchosPkg });
    expect(isExarchosRepo('/repo', deps)).toBe(true);
  });

  it('isExarchosRepo_ConsumerPackageName_False', () => {
    const deps = makeDeps({ '/repo/package.json': consumerPkg });
    expect(isExarchosRepo('/repo', deps)).toBe(false);
  });

  it('isExarchosRepo_MissingPackageJson_False', () => {
    const deps = makeDeps({});
    expect(isExarchosRepo('/repo', deps)).toBe(false);
  });

  it('isExarchosRepo_UnparseablePackageJson_False', () => {
    const deps = makeDeps({ '/repo/package.json': '{ not valid json' });
    expect(isExarchosRepo('/repo', deps)).toBe(false);
  });
});

describe('assertDevTierAllowed', () => {
  it('assertDevTierAllowed_UserTier_AllowsRegardlessOfRepo', () => {
    const deps = makeDeps({ '/repo/package.json': consumerPkg });
    expect(
      assertDevTierAllowed(
        { tier: 'user', repoRoot: '/repo', action: 'invariants_add' },
        deps,
      ),
    ).toBeNull();
  });

  /** An omitted tier defaults to `user`, so the guard allows it. */
  it('assertDevTierAllowed_UndefinedTier_Allows', () => {
    const deps = makeDeps({ '/repo/package.json': consumerPkg });
    expect(
      assertDevTierAllowed(
        { tier: undefined, repoRoot: '/repo', action: 'invariants_add' },
        deps,
      ),
    ).toBeNull();
  });

  it('assertDevTierAllowed_DevTierInExarchosRepo_Allows', () => {
    const deps = makeDeps({ '/repo/package.json': exarchosPkg });
    expect(
      assertDevTierAllowed(
        { tier: 'dev', repoRoot: '/repo', action: 'invariants_add' },
        deps,
      ),
    ).toBeNull();
  });

  /**
   * The refusal carries a `suggestedFix` with `tier: user` and the caller's
   * action, so the agent can invoke it again. It also names the
   * `allowReservedTier` override.
   */
  it('assertDevTierAllowed_DevTierInConsumerRepo_Blocks', () => {
    const deps = makeDeps({ '/repo/package.json': consumerPkg });
    const result = assertDevTierAllowed(
      { tier: 'dev', repoRoot: '/repo', action: 'invariants_scaffold' },
      deps,
    );
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.error?.code).toBe('RESERVED_TIER');
    expect(result!.error?.suggestedFix?.params.tier).toBe('user');
    expect(result!.error?.suggestedFix?.params.action).toBe(
      'invariants_scaffold',
    );
    expect(JSON.stringify(result!.error)).toMatch(/allowReservedTier/);
  });

  /** A repo without `package.json` counts as not exarchos. */
  it('assertDevTierAllowed_DevTierMissingPackageJson_Blocks', () => {
    const deps = makeDeps({});
    const result = assertDevTierAllowed(
      { tier: 'dev', repoRoot: '/repo', action: 'invariants_add' },
      deps,
    );
    expect(result).not.toBeNull();
    expect(result!.error?.code).toBe('RESERVED_TIER');
    expect(result!.error?.suggestedFix?.params.action).toBe('invariants_add');
  });

  it('assertDevTierAllowed_DevTierWithOverride_Allows', () => {
    const deps = makeDeps({ '/repo/package.json': consumerPkg });
    expect(
      assertDevTierAllowed(
        {
          tier: 'dev',
          repoRoot: '/repo',
          allowReservedTier: true,
          action: 'invariants_add',
        },
        deps,
      ),
    ).toBeNull();
  });
});
