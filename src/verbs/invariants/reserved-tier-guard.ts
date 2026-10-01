/**
 * Keeps consumers out of the reserved `dev` invariant tier of exarchos.
 * The `dev` tier holds the built-in `INV-N` catalog, which merges into each
 * `invariants_effective` projection. A consumer `dev` catalog makes colliding ids, and the
 * doctor `invariants-catalog` check flags `INV-*` ids only in user-tier catalogs. Thus this
 * guard rejects `tier: dev` in a repo whose `package.json` name is not the exarchos name, and
 * points to `tier: user`. An exarchos fork opts in with `allowReservedTier`. The `package.json`
 * read goes through the injected `ScaffoldDeps`.
 */
import * as path from 'node:path';
import { toPosix } from '../../utils/paths.js';

import type { ToolResult } from '../../format.js';
import type { ScaffoldDeps } from './scaffold.js';

/** The npm package name of the exarchos repo itself. */
export const EXARCHOS_PACKAGE_NAME = '@lvlup-sw/exarchos';

/**
 * True when the `package.json` of `repoRoot` parses and its `name` is `EXARCHOS_PACKAGE_NAME`.
 * A missing or bad `package.json` gives `false`, because a `dev` tier in an unknown repo is
 * almost always a mistake.
 */
export function isExarchosRepo(repoRoot: string, deps: ScaffoldDeps): boolean {
  const pkgPath = toPosix(path.join(repoRoot, 'package.json'));
  if (!deps.exists(pkgPath)) return false;
  try {
    const parsed = JSON.parse(deps.read(pkgPath)) as { name?: unknown };
    return parsed.name === EXARCHOS_PACKAGE_NAME;
  } catch {
    return false;
  }
}

export interface DevTierGuardArgs {
  /** Target tier. `undefined` defaults to `user` downstream — nothing to guard. */
  readonly tier?: 'dev' | 'user' | undefined;
  /** Repo root the `package.json` heuristic resolves against. */
  readonly repoRoot: string;
  /** Explicit opt-in for a genuine exarchos fork — bypasses the guard. */
  readonly allowReservedTier?: boolean | undefined;
  /**
   * The orchestrate action under guard. The error copies it into `suggestedFix.params.action`,
   * so the caller can run the fix directly.
   */
  readonly action: 'invariants_scaffold' | 'invariants_add' | 'invariants_amend';
}

/**
 * Returns a `RESERVED_TIER` error when `tier` is `dev`, `allowReservedTier` is not set, and the
 * repo is not exarchos. Otherwise it returns `null`.
 */
export function assertDevTierAllowed(
  args: DevTierGuardArgs,
  deps: ScaffoldDeps,
): ToolResult | null {
  if (args.tier !== 'dev') return null;
  if (args.allowReservedTier) return null;
  if (isExarchosRepo(args.repoRoot, deps)) return null;

  return {
    success: false,
    error: {
      code: 'RESERVED_TIER',
      message:
        "tier: 'dev' is exarchos's own reserved substrate namespace (INV-N). " +
        "Its built-in INV-1..6 merge into invariants_effective, so authoring " +
        "here from a consumer repo collides your INV-N with exarchos's own. " +
        "Use tier: 'user' (U-N) — the default for every repo consuming " +
        'exarchos. Only pass allowReservedTier: true when working inside an ' +
        'exarchos fork itself.',
      expectedShape: { tier: "'user'" },
      suggestedFix: {
        tool: 'exarchos_orchestrate',
        params: {
          action: args.action,
          tier: 'user',
          note:
            "Re-run with tier: 'user' to author into your project's own " +
            'namespace (U-N). The dev/INV-N tier is reserved for exarchos ' +
            'itself; pass allowReservedTier: true only inside an exarchos fork.',
        },
      },
    },
  };
}
