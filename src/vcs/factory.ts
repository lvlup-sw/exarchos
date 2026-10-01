import type { VcsProvider } from './provider.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { detectVcsProvider, type VcsDetectorDeps } from './detector.js';
import { GitHubProvider } from './github.js';
import { GitLabProvider } from './gitlab.js';
import { AzureDevOpsProvider } from './azure-devops.js';

export interface CreateVcsProviderOpts {
  readonly config?: ResolvedProjectConfig | undefined;
  readonly detectorDeps?: VcsDetectorDeps | undefined;
}

/**
 * Creates the VCS provider. An explicit `config.vcs.provider` wins with no detection.
 * Otherwise `detectVcsProvider()` reads the git remote URL. When detection returns null, the provider is `'github'`.
 */
export async function createVcsProvider(
  opts?: CreateVcsProviderOpts,
): Promise<VcsProvider> {
  const config = opts?.config;
  const settings = config?.vcs?.settings ?? {};

  if (config?.vcs?.provider) {
    return instantiate(config.vcs.provider, settings);
  }

  const detected = await detectVcsProvider(opts?.detectorDeps);
  const provider = detected?.provider ?? 'github';

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
