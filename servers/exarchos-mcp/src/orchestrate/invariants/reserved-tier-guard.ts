/**
 * reserved-tier-guard — keep consumers out of exarchos's reserved namespace (#1489).
 *
 * `dev`/`INV-N` is exarchos's OWN substrate catalog. Its built-in `INV-1..6`
 * ship inside the tool and merge into every `invariants_effective` projection.
 * A consumer who authors into `tier: dev` allocates `INV-N` ids that collide
 * with those built-ins — a SILENT namespace clash, not a validation error: the
 * `doctor` `invariants-catalog` check only flags `INV-*` ids in a catalog
 * registered as USER tier, so a self-declared dev catalog evades it entirely.
 *
 * The tier choice is not "which maintainer" — it is "exarchos-substrate vs
 * project-authored". Outside the exarchos repo, `dev` is almost always a
 * mistake. This guard makes that loud at authoring time: it rejects `tier: dev`
 * in any repo whose `package.json` name is not exarchos's, returning an INV-5b
 * carrier-shape error that redirects to `tier: user`. The rare legitimate case
 * (a maintainer working in an exarchos fork) opts in via `allowReservedTier`.
 *
 * Pure-by-default: the `package.json` read flows through the injected
 * `ScaffoldDeps` hooks, so the guard is exercisable without touching disk.
 */
import * as path from 'node:path';
import { toPosix } from '../../utils/paths.js';

import type { ToolResult } from '../../format.js';
import type { ScaffoldDeps } from './scaffold.js';

/** The npm package name of the exarchos repo itself. */
export const EXARCHOS_PACKAGE_NAME = '@lvlup-sw/exarchos';

/**
 * Is `repoRoot` the exarchos repo itself? True iff its `package.json` parses and
 * declares `name === EXARCHOS_PACKAGE_NAME`. A missing, unreadable, or
 * unparseable `package.json` — or any other name — yields `false`: we treat an
 * unidentifiable repo as "not exarchos", because authoring into the reserved
 * `dev` tier there is almost always a mistake.
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
  readonly tier?: 'dev' | 'user';
  /** Repo root the `package.json` heuristic resolves against. */
  readonly repoRoot: string;
  /** Explicit opt-in for a genuine exarchos fork — bypasses the guard. */
  readonly allowReservedTier?: boolean;
  /**
   * The orchestrate action this guard is protecting. Echoed into
   * `suggestedFix.params.action` so the carrier-shape fix is directly
   * re-invokable (the guard is shared across both verbs, so the caller names
   * its own action).
   */
  readonly action: 'invariants_scaffold' | 'invariants_add';
}

/**
 * Returns `null` when the call may proceed, or a `RESERVED_TIER` error
 * `ToolResult` when a consumer is authoring into exarchos's reserved `dev`
 * namespace. The guard fires only when ALL hold: `tier === 'dev'`, no
 * `allowReservedTier` override, and the repo is not exarchos itself.
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
