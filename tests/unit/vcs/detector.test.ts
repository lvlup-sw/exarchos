import { afterEach, describe, it, expect } from 'vitest';
import { accessSync, constants, realpathSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  detectVcsProvider,
  type VcsDetectorDeps,
} from '../../../src/vcs/detector.js';
import { observationalReader } from '../../../src/utils/git-tree.js';
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

/** Fixture Git in `cwd` through the absolute executable, with no global or system configuration. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync(GIT, ['-C', cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull }, timeout: 30_000,
  })).trim();
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rmrfAsync(root);
});

/**
 * A fresh repository whose `origin` URL is `url`, or that has no origin when it is null.
 * The result is the detector deps that read it: the start directory and the absolute fixture Git.
 */
async function originRepo(url: string | null): Promise<{ readonly cwd: string; readonly gitPath: string }> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'vcs-detector-')));
  roots.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  if (url !== null) await git(root, 'config', 'remote.origin.url', url);
  return { cwd: root, gitPath: GIT };
}

describe('detectVcsProvider — GitHub URL parsing', () => {
  it('detectVcsProvider_GitHubHttpsUrl_ReturnsGitHub', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('https://github.com/lvlup-sw/exarchos.git')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('github');
    expect(result!.remoteUrl).toBe('https://github.com/lvlup-sw/exarchos.git');
  });

  it('detectVcsProvider_GitHubSshUrl_ReturnsGitHub', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('git@github.com:lvlup-sw/exarchos.git')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('github');
    expect(result!.remoteUrl).toBe('git@github.com:lvlup-sw/exarchos.git');
  });
});

describe('detectVcsProvider — GitLab + Azure DevOps URL parsing', () => {
  it('detectVcsProvider_GitLabUrl_ReturnsGitLab', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('https://gitlab.com/mygroup/myproject.git')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('gitlab');
    expect(result!.remoteUrl).toBe('https://gitlab.com/mygroup/myproject.git');
  });

  it('detectVcsProvider_AzureDevOpsUrl_ReturnsAzureDevOps', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('https://dev.azure.com/myorg/myproject/_git/myrepo')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('azure-devops');
    expect(result!.remoteUrl).toBe('https://dev.azure.com/myorg/myproject/_git/myrepo');
  });

  it('detectVcsProvider_AzureDevOpsVisualStudioUrl_ReturnsAzureDevOps', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('https://myorg.visualstudio.com/myproject/_git/myrepo')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('azure-devops');
    expect(result!.remoteUrl).toBe('https://myorg.visualstudio.com/myproject/_git/myrepo');
  });

  it('detectVcsProvider_SelfHostedGitLab_ReturnsGitLab', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('https://gitlab.mycompany.com/team/project.git')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('gitlab');
    expect(result!.remoteUrl).toBe('https://gitlab.mycompany.com/team/project.git');
  });
});

describe('detectVcsProvider — CLI availability', () => {
  it('detectVcsProvider_GhNotOnPath_CliAvailableFalse', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('https://github.com/lvlup-sw/exarchos.git')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('github');
    expect(result!.cliAvailable).toBe(false);
    expect(result!.cliVersion).toBeUndefined();
  });

  it('detectVcsProvider_GhOnPath_CliAvailableTrue', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('https://github.com/lvlup-sw/exarchos.git')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'gh' && args.includes('--version')) {
          return 'gh version 2.45.0 (2024-03-15)';
        }
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('github');
    expect(result!.cliAvailable).toBe(true);
    expect(result!.cliVersion).toBe('2.45.0');
  });

  it('detectVcsProvider_GlabOnPath_CliAvailableTrue', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('https://gitlab.com/mygroup/myproject.git')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'glab' && args.includes('--version')) {
          return 'glab version 1.36.0 (2024-02-20)';
        }
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('gitlab');
    expect(result!.cliAvailable).toBe(true);
    expect(result!.cliVersion).toBe('1.36.0');
  });

  it('detectVcsProvider_AzOnPath_CliAvailableTrue', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('https://dev.azure.com/myorg/myproject/_git/myrepo')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'az' && args.includes('--version')) {
          return 'azure-cli                         2.58.0';
        }
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('azure-devops');
    expect(result!.cliAvailable).toBe(true);
    expect(result!.cliVersion).toBe('2.58.0');
  });
});

describe('detectVcsProvider — env var override', () => {
  /**
   * The remote is a GitHub URL and the env var names `gitlab`.
   * The result keeps the remote URL from git, and the CLI check runs `glab`, not `gh`.
   */
  it('detectVcsProvider_ExarchosVcsProviderEnv_OverridesDetection', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('https://github.com/lvlup-sw/exarchos.git')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'glab' && args.includes('--version')) {
          return 'glab version 1.36.0 (2024-02-20)';
        }
        throw new Error('command not found');
      },
      env: { EXARCHOS_VCS_PROVIDER: 'gitlab' },
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('gitlab');
    expect(result!.remoteUrl).toBe('https://github.com/lvlup-sw/exarchos.git');
    expect(result!.cliAvailable).toBe(true);
    expect(result!.cliVersion).toBe('1.36.0');
  });

  /** `bitbucket` is not a valid provider name, so detection uses the remote URL. */
  it('detectVcsProvider_ExarchosVcsProviderEnvInvalid_IgnoresOverride', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('https://github.com/lvlup-sw/exarchos.git')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        throw new Error('command not found');
      },
      env: { EXARCHOS_VCS_PROVIDER: 'bitbucket' },
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('github');
  });

  /** With no remote, the env override still gives a provider, and the remote URL is empty. */
  it('detectVcsProvider_ExarchosVcsProviderEnvNoRemote_StillDetectsProvider', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo(null)),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'gh' && args.includes('--version')) {
          return 'gh version 2.45.0 (2024-03-15)';
        }
        throw new Error('command not found');
      },
      env: { EXARCHOS_VCS_PROVIDER: 'github' },
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('github');
    expect(result!.remoteUrl).toBe('');
    expect(result!.cliAvailable).toBe(true);
  });
});

describe('detectVcsProvider — edge cases', () => {
  it('detectVcsProvider_NoRemote_ReturnsNull', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo(null)),
      exec: async (_cmd: string, _args: string[]): Promise<string> => {
        throw new Error('fatal: No such remote \'origin\'');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).toBeNull();
  });

  it('detectVcsProvider_UnknownHost_ReturnsNull', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('https://bitbucket.org/myteam/myrepo.git')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).toBeNull();
  });

  it('detectVcsProvider_MalformedUrl_ReturnsNull', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('not-a-valid-url')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).toBeNull();
  });

  it('detectVcsProvider_EmptyRemoteUrl_ReturnsNull', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).toBeNull();
  });

  it('detectVcsProvider_WhitespaceInUrl_TrimsAndParses', async () => {
    const deps: VcsDetectorDeps = {
      ...(await originRepo('  https://github.com/lvlup-sw/exarchos.git\n')),
      exec: async (cmd: string, args: string[]): Promise<string> => {
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('github');
    expect(result!.remoteUrl).toBe('https://github.com/lvlup-sw/exarchos.git');
  });
});

describe('detectVcsProvider — constrained remote read', () => {
  /** The injected exec serves only the CLI probe. A Git call through it fails the test, and the remote still comes from the repository. */
  it('DetectVcsProvider_ConstrainedRead_NeverRunsGitThroughExec', async () => {
    const calls: string[] = [];
    const repo = await originRepo('https://gitlab.com/group/project.git');

    const result = await detectVcsProvider({
      ...repo,
      exec: async (cmd: string) => { calls.push(cmd); throw new Error('not found'); },
      env: {},
    });

    expect(result).toMatchObject({ provider: 'gitlab', remoteUrl: 'https://gitlab.com/group/project.git', cliAvailable: false });
    expect(calls).toEqual(['glab']);
  });

  /** The climb starts at `cwd`, so a subdirectory finds the repository root. */
  it('DetectVcsProvider_SubdirectoryCwd_ClimbsToTheCheckout', async () => {
    const repo = await originRepo('git@github.com:org/repo.git');
    await mkdir(join(repo.cwd, 'nested', 'deeper'), { recursive: true });

    const result = await detectVcsProvider({ ...repo, cwd: join(repo.cwd, 'nested', 'deeper'), exec: async () => 'gh version 2.45.0', env: {} });

    expect(result?.provider).toBe('github');
  });

  /** A refused config, an unusable Git path and a path outside any checkout give null, and the override keeps the empty URL. */
  it('DetectVcsProvider_UnreadableRead_GivesNullOrTheOverrideWithAnEmptyUrl', async () => {
    const refused = await originRepo('https://gitlab.com/group/project.git');
    await git(refused.cwd, 'config', 'include.path', '/untrusted/config');
    const readable = await originRepo('https://gitlab.com/group/project.git');
    const outside = realpathSync(await mkdtemp(join(tmpdir(), 'vcs-detector-outside-')));
    roots.push(outside);
    const exec = async (): Promise<string> => { throw new Error('not found'); };

    expect(await detectVcsProvider({ ...refused, exec, env: {} })).toBeNull();
    expect(await detectVcsProvider({ ...readable, gitPath: join(outside, 'no-git'), exec, env: {} })).toBeNull();
    expect(await detectVcsProvider({ cwd: outside, gitPath: GIT, exec, env: {} })).toBeNull();
    expect(await detectVcsProvider({ ...refused, exec, env: { EXARCHOS_VCS_PROVIDER: 'azure-devops' } }))
      .toMatchObject({ provider: 'azure-devops', remoteUrl: '' });
  });

  /** A reader that the caller already created serves the read, so detection creates no reader of its own. */
  it('DetectVcsProvider_InjectedReader_IsTheOnlyReader', async () => {
    const repo = await originRepo('https://dev.azure.com/org/project/_git/repo');
    const source = observationalReader(GIT);
    let calls = 0;
    const reader = () => { calls += 1; return source(); };

    const result = await detectVcsProvider({ cwd: repo.cwd, gitPath: join(repo.cwd, 'never-used'), reader, exec: async () => { throw new Error('none'); }, env: {} });

    expect(result?.provider).toBe('azure-devops');
    expect(calls).toBe(1);
  });
});
