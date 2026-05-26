/**
 * reserved-tier-guard — tests (#1489).
 *
 * `dev`/`INV-N` is exarchos's OWN reserved substrate namespace. A consumer who
 * authors into `tier: dev` silently collides their `INV-N` ids with exarchos's
 * built-in `INV-1..6` in the merged `invariants_effective` projection — and the
 * `doctor` `invariants-catalog` check can't catch it, because the catalog is
 * self-declared as dev tier. This guard rejects `tier: dev` at authoring time in
 * any repo that is not exarchos itself, redirecting to `tier: user`.
 */
import { describe, it, expect } from 'vitest';

import {
  EXARCHOS_PACKAGE_NAME,
  isExarchosRepo,
  assertDevTierAllowed,
} from './reserved-tier-guard.js';
import type { ScaffoldDeps } from './scaffold.js';

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
      assertDevTierAllowed({ tier: 'user', repoRoot: '/repo' }, deps),
    ).toBeNull();
  });

  it('assertDevTierAllowed_UndefinedTier_Allows', () => {
    // tier omitted ⇒ defaults to user downstream; nothing to guard.
    const deps = makeDeps({ '/repo/package.json': consumerPkg });
    expect(
      assertDevTierAllowed({ tier: undefined, repoRoot: '/repo' }, deps),
    ).toBeNull();
  });

  it('assertDevTierAllowed_DevTierInExarchosRepo_Allows', () => {
    const deps = makeDeps({ '/repo/package.json': exarchosPkg });
    expect(
      assertDevTierAllowed({ tier: 'dev', repoRoot: '/repo' }, deps),
    ).toBeNull();
  });

  it('assertDevTierAllowed_DevTierInConsumerRepo_Blocks', () => {
    const deps = makeDeps({ '/repo/package.json': consumerPkg });
    const result = assertDevTierAllowed(
      { tier: 'dev', repoRoot: '/repo' },
      deps,
    );
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.error?.code).toBe('RESERVED_TIER');
    // INV-5b carrier shape: redirect to tier: user so the agent self-corrects.
    expect(result!.error?.suggestedFix?.params.tier).toBe('user');
    // The override path is named so a genuine exarchos fork can proceed.
    expect(JSON.stringify(result!.error)).toMatch(/allowReservedTier/);
  });

  it('assertDevTierAllowed_DevTierMissingPackageJson_Blocks', () => {
    // "Unknown" repo is treated as not-exarchos: dev is almost always a mistake.
    const deps = makeDeps({});
    const result = assertDevTierAllowed(
      { tier: 'dev', repoRoot: '/repo' },
      deps,
    );
    expect(result).not.toBeNull();
    expect(result!.error?.code).toBe('RESERVED_TIER');
  });

  it('assertDevTierAllowed_DevTierWithOverride_Allows', () => {
    const deps = makeDeps({ '/repo/package.json': consumerPkg });
    expect(
      assertDevTierAllowed(
        { tier: 'dev', repoRoot: '/repo', allowReservedTier: true },
        deps,
      ),
    ).toBeNull();
  });
});
