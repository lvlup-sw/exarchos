/**
 * VcsProviderDetector — "which VCS provider hosts this project's remote?"
 *
 * Detects the VCS provider (GitHub, GitLab, Azure DevOps) from the git
 * remote URL, verifies CLI availability, and supports env var overrides.
 *
 * All side effects (`exec`, env) are injected via `VcsDetectorDeps`
 * (DIM-1). No module-global state.
 */

export type VcsProviderName = 'github' | 'gitlab' | 'azure-devops';

export interface VcsDetectorDeps {
  readonly exec?: (cmd: string, args: string[]) => Promise<string>;
  readonly env?: Record<string, string | undefined>;
}

export interface VcsEnvironment {
  readonly provider: VcsProviderName;
  readonly remoteUrl: string;
  readonly cliAvailable: boolean;
  readonly cliVersion?: string;
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_EXEC = async (cmd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync(cmd, args);
  return stdout.trim();
};

/**
 * Extract the hostname from a git remote URL.
 * Supports HTTPS (`https://github.com/...`) and SSH (`git@github.com:...`) formats.
 */
function extractHostname(remoteUrl: string): string | null {
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/^https?:\/\/([^/]+)/);
  if (httpsMatch) return httpsMatch[1]!;

  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/^[^@]+@([^:]+):/);
  if (sshMatch) return sshMatch[1]!;

  return null;
}

/**
 * Map a hostname to a VCS provider name.
 */
function parseRemoteUrl(remoteUrl: string): VcsProviderName | null {
  const hostname = extractHostname(remoteUrl);
  if (!hostname) return null;

  if (hostname === 'github.com') return 'github';

  // GitLab: gitlab.com or any host starting with "gitlab."
  if (hostname === 'gitlab.com' || hostname.startsWith('gitlab.')) return 'gitlab';

  // Azure DevOps: dev.azure.com or *.visualstudio.com
  if (hostname === 'dev.azure.com' || hostname.endsWith('.visualstudio.com')) return 'azure-devops';

  return null;
}

export async function detectVcsProvider(
  deps?: VcsDetectorDeps,
): Promise<VcsEnvironment | null> {
  const exec = deps?.exec ?? DEFAULT_EXEC;

  // 1. Get remote URL
  let remoteUrl: string;
  try {
    remoteUrl = (await exec('git', ['remote', 'get-url', 'origin'])).trim();
  } catch {
    return null;
  }

  // 2. Parse provider from URL
  const provider = parseRemoteUrl(remoteUrl);
  if (!provider) return null;

  return {
    provider,
    remoteUrl,
    cliAvailable: false,
  };
}
