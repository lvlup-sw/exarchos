import type { VcsProvider } from './provider.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { detectVcsProvider, type VcsDetectorDeps } from './detector.js';
import { GitHubProvider } from './github.js';
import { GitLabProvider } from './gitlab.js';
import { AzureDevOpsProvider } from './azure-devops.js';

export interface CreateVcsProviderOpts {
  readonly config?: ResolvedProjectConfig;
  readonly detectorDeps?: VcsDetectorDeps;
}

/**
 * Creates the appropriate VCS provider.
 *
 * Resolution order:
 *  1. Explicit `config.vcs.provider` — used as-is (no detection).
 *  2. Auto-detection via `detectVcsProvider()` on the git remote URL.
 *  3. Fallback to `'github'` when detection returns null.
 */
export async function createVcsProvider(
  opts?: CreateVcsProviderOpts,
): Promise<VcsProvider> {
  const config = opts?.config;
  const settings = config?.vcs?.settings ?? {};

  // If an explicit provider is configured, use it directly.
  if (config?.vcs?.provider) {
    return instantiate(config.vcs.provider, settings);
  }

  // Otherwise, auto-detect from git remote.
  const detected = await detectVcsProvider(opts?.detectorDeps);
  const provider = detected ?? 'github';

  return instantiate(provider, settings);
}

function instantiate(
  provider: 'github' | 'gitlab' | 'azure-devops',
  settings: Readonly<Record<string, unknown>>,
): VcsProvider {
  switch (provider) {
    case 'github': return new GitHubProvider(settings);
    case 'gitlab': return new GitLabProvider(settings);
    case 'azure-devops': return new AzureDevOpsProvider(settings);
    default: return new GitHubProvider(settings);
  }
}
