import type { VcsProvider } from './provider.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { GitHubProvider } from './github.js';
import { GitLabProvider } from './gitlab.js';
import { AzureDevOpsProvider } from './azure-devops.js';

export function createVcsProvider(config?: ResolvedProjectConfig): VcsProvider {
  const provider = config?.vcs?.provider ?? 'github';
  const settings = config?.vcs?.settings ?? {};

  switch (provider) {
    case 'github': return new GitHubProvider(settings);
    case 'gitlab': return new GitLabProvider(settings);
    case 'azure-devops': return new AzureDevOpsProvider(settings);
    default: return new GitHubProvider(settings);
  }
}
