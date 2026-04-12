// ─── Prune Safeguards (DI-friendly) ─────────────────────────────────────────
//
// Production implementations for the open-PR and recent-commits safeguards
// used by `handlePruneStaleWorkflows`. Both shell out to `gh`/`git` through
// `execSync`; the handler takes these as injectable deps so unit tests can
// swap stubs rather than shelling out.
//
// Isolation rationale: keeping the IO helpers in a separate module lets
// `prune-stale-workflows.ts` stay focused on orchestration + pure-selection
// composition, and makes the tests explicit about which IO is being bypassed.
// ────────────────────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process';

/**
 * Pluggable safeguard backends. Both accept optional `branchName` so callers
 * can hand through `undefined` for pre-delegation workflows — the handler
 * short-circuits those checks rather than invoking the safeguard at all.
 */
export interface PruneSafeguards {
  /** Returns true if there is an OPEN pull request whose head is `branchName`. */
  hasOpenPR: (featureId: string, branchName: string | undefined) => Promise<boolean>;
  /** Returns true if `branchName` has commits inside the last `windowHours`. */
  hasRecentCommits: (branchName: string | undefined, windowHours: number) => Promise<boolean>;
}

/** Sanitize a branch name before embedding it in a shell argument. */
function isSafeBranchName(branch: string): boolean {
  // Matches git's allowed ref characters: alphanumerics, slash, dash, dot, underscore.
  return /^[A-Za-z0-9/_.\-]+$/.test(branch) && !branch.includes('..');
}

async function defaultHasOpenPR(
  _featureId: string,
  branchName: string | undefined,
): Promise<boolean> {
  if (!branchName || !isSafeBranchName(branchName)) return false;
  try {
    const output = execSync(
      `gh pr list --head ${branchName} --state open --json number`,
      {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
    if (!output) return false;
    const parsed: unknown = JSON.parse(output);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    // When `gh` fails, be conservative: report "no open PR" rather than
    // blocking the prune. The handler's `force` flag is the escape hatch
    // for environments where `gh` is unavailable.
    return false;
  }
}

async function defaultHasRecentCommits(
  branchName: string | undefined,
  windowHours: number,
): Promise<boolean> {
  if (!branchName || !isSafeBranchName(branchName)) return false;
  try {
    const output = execSync(
      `git log --since "${windowHours} hours ago" --format=%H origin/${branchName}`,
      {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
    return output.length > 0;
  } catch {
    // If the remote branch doesn't exist or git errors out, treat as no
    // recent activity (conservative toward allowing prune; `force` is the
    // override if the user wants to bypass both safeguards anyway).
    return false;
  }
}

/**
 * Build the default production safeguard bundle. Tests pass their own
 * `PruneSafeguards` object instead of calling this.
 */
export function defaultSafeguards(): PruneSafeguards {
  return {
    hasOpenPR: defaultHasOpenPR,
    hasRecentCommits: defaultHasRecentCommits,
  };
}
