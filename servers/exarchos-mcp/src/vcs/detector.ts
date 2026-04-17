// ─── VCS Provider Detector ───────────────────────────────────────────────────
//
// Auto-detects the VCS provider from git remote URLs.
// Used by the factory when no explicit provider is configured.

import { exec } from './shell.js';

/**
 * Injectable dependencies for testing — avoids shelling out to git in tests.
 */
export interface VcsDetectorDeps {
  readonly getRemoteUrl: () => Promise<string | null>;
}

export type DetectedProvider = 'github' | 'gitlab' | 'azure-devops';

/**
 * Default deps: reads `git remote get-url origin`.
 */
export function defaultDetectorDeps(): VcsDetectorDeps {
  return {
    getRemoteUrl: async () => {
      try {
        return await exec('git', ['remote', 'get-url', 'origin']);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Parses a remote URL and returns the matching VCS provider, or null.
 */
export function parseProvider(url: string): DetectedProvider | null {
  if (/github\.com/i.test(url)) return 'github';
  if (/gitlab\.com/i.test(url) || /gitlab\./i.test(url)) return 'gitlab';
  if (/dev\.azure\.com/i.test(url) || /visualstudio\.com/i.test(url)) return 'azure-devops';
  return null;
}

/**
 * Detects the VCS provider from the git remote URL.
 * Returns null if no remote is configured or the host is unrecognized.
 */
export async function detectVcsProvider(
  deps?: VcsDetectorDeps,
): Promise<DetectedProvider | null> {
  const d = deps ?? defaultDetectorDeps();
  const url = await d.getRemoteUrl();
  if (!url) return null;
  return parseProvider(url);
}
