import { afterEach, describe, it, expect } from 'vitest';
import { accessSync, constants, realpathSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createVcsProvider } from '../../../src/vcs/factory.js';
import { DEFAULTS } from '../../../src/config/resolve.js';
import { GitHubProvider } from '../../../src/vcs/github.js';
import { GitLabProvider } from '../../../src/vcs/gitlab.js';
import { AzureDevOpsProvider } from '../../../src/vcs/azure-devops.js';
import type { ResolvedProjectConfig } from '../../../src/config/resolve.js';
import type { VcsDetectorDeps } from '../../../src/vcs/detector.js';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** The absolute real path of the fixture Git on the test process PATH. */
function fixtureGit(): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { continue; }
  }
  throw new Error('The fixture needs Git on PATH');
}

const GIT = fixtureGit();

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rmrfAsync(root);
});

/**
 * Detector deps over a fresh repository whose `origin` URL is `remoteUrl`, or that has no origin when it is null.
 * The remote read goes through the constrained reader with the real Git path. Each CLI version check throws, so no CLI is available. The env is empty.
 */
async function fakeDetectorDeps(remoteUrl: string | null): Promise<VcsDetectorDeps> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'vcs-factory-')));
  roots.push(root);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
  await execFileAsync(GIT, ['-C', root, 'init', '-q', '-b', 'main'], { env });
  if (remoteUrl !== null) await execFileAsync(GIT, ['-C', root, 'config', 'remote.origin.url', remoteUrl], { env });
  return {
    cwd: root,
    gitPath: GIT,
    exec: async () => {
      throw new Error('not found');
    },
    env: {},
  };
}

describe('createVcsProvider', () => {
  /** The provider of `DEFAULTS` is `github`. */
  it('createVcsProvider_GitHub_ReturnsGitHubProvider', async () => {
    const provider = await createVcsProvider({ config: DEFAULTS });
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.name).toBe('github');
  });

  it('createVcsProvider_GitLab_ReturnsGitLabProvider', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      vcs: { provider: 'gitlab', settings: {} },
    };
    const provider = await createVcsProvider({ config });
    expect(provider).toBeInstanceOf(GitLabProvider);
    expect(provider.name).toBe('gitlab');
  });

  it('createVcsProvider_AzureDevOps_ReturnsAzureProvider', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      vcs: { provider: 'azure-devops', settings: {} },
    };
    const provider = await createVcsProvider({ config });
    expect(provider).toBeInstanceOf(AzureDevOpsProvider);
    expect(provider.name).toBe('azure-devops');
  });

  it('createVcsProvider_PassesSettings_ToProvider', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      vcs: { provider: 'github', settings: { 'auto-merge-strategy': 'rebase' } },
    };
    const provider = await createVcsProvider({ config });
    expect(provider).toBeInstanceOf(GitHubProvider);
  });

  /** The injected deps have no remote, so detection returns null on every host. */
  it('createVcsProvider_NoOpts_DefaultsToGitHub', async () => {
    const provider = await createVcsProvider({
      detectorDeps: await fakeDetectorDeps(null),
    });
    expect(provider).toBeInstanceOf(GitHubProvider);
  });

  it('CreateVcsProvider_AutoDetect_UsesDetectedProvider', async () => {
    const provider = await createVcsProvider({
      detectorDeps: await fakeDetectorDeps('git@gitlab.com:org/repo.git'),
    });
    expect(provider).toBeInstanceOf(GitLabProvider);
    expect(provider.name).toBe('gitlab');
  });

  /** The config names `github` and the remote is a GitLab URL. The config must win. */
  it('CreateVcsProvider_ExplicitConfig_SkipsDetection', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      vcs: { provider: 'github', settings: {} },
    };
    const provider = await createVcsProvider({
      config,
      detectorDeps: await fakeDetectorDeps('git@gitlab.com:org/repo.git'),
    });
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.name).toBe('github');
  });

  it('CreateVcsProvider_NoRemote_DefaultsToGitHub', async () => {
    const provider = await createVcsProvider({
      detectorDeps: await fakeDetectorDeps(null),
    });
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.name).toBe('github');
  });

  it('CreateVcsProvider_AutoDetect_AzureDevOps', async () => {
    const provider = await createVcsProvider({
      detectorDeps: await fakeDetectorDeps('https://dev.azure.com/org/project/_git/repo'),
    });
    expect(provider).toBeInstanceOf(AzureDevOpsProvider);
    expect(provider.name).toBe('azure-devops');
  });

  it('CreateVcsProvider_AutoDetect_GitHub', async () => {
    const provider = await createVcsProvider({
      detectorDeps: await fakeDetectorDeps('git@github.com:org/repo.git'),
    });
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.name).toBe('github');
  });

  it('CreateVcsProvider_AutoDetect_UnknownHost_DefaultsToGitHub', async () => {
    const provider = await createVcsProvider({
      detectorDeps: await fakeDetectorDeps('git@bitbucket.org:org/repo.git'),
    });
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.name).toBe('github');
  });
});
