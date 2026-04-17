import { describe, it, expect } from 'vitest';
import {
  detectVcsProvider,
  type VcsDetectorDeps,
} from './detector.js';

// ─── T1: URL parsing — GitHub ────────────────────────────────────────────────

describe('detectVcsProvider — GitHub URL parsing', () => {
  it('detectVcsProvider_GitHubHttpsUrl_ReturnsGitHub', async () => {
    const deps: VcsDetectorDeps = {
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://github.com/lvlup-sw/exarchos.git';
        }
        // gh --version: simulate not found
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
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return 'git@github.com:lvlup-sw/exarchos.git';
        }
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

// ─── T2: URL parsing — GitLab + Azure DevOps ─────────────────────────────────

describe('detectVcsProvider — GitLab + Azure DevOps URL parsing', () => {
  it('detectVcsProvider_GitLabUrl_ReturnsGitLab', async () => {
    const deps: VcsDetectorDeps = {
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://gitlab.com/mygroup/myproject.git';
        }
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
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://dev.azure.com/myorg/myproject/_git/myrepo';
        }
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
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://myorg.visualstudio.com/myproject/_git/myrepo';
        }
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
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://gitlab.mycompany.com/team/project.git';
        }
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

// ─── T3: CLI availability check ──────────────────────────────────────────────

describe('detectVcsProvider — CLI availability', () => {
  it('detectVcsProvider_GhNotOnPath_CliAvailableFalse', async () => {
    const deps: VcsDetectorDeps = {
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://github.com/lvlup-sw/exarchos.git';
        }
        // gh --version: simulate not found
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
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://github.com/lvlup-sw/exarchos.git';
        }
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
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://gitlab.com/mygroup/myproject.git';
        }
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
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://dev.azure.com/myorg/myproject/_git/myrepo';
        }
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

// ─── T4: Environment variable override ───────────────────────────────────────

describe('detectVcsProvider — env var override', () => {
  it('detectVcsProvider_ExarchosVcsProviderEnv_OverridesDetection', async () => {
    const deps: VcsDetectorDeps = {
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          // Remote URL points to GitHub...
          return 'https://github.com/lvlup-sw/exarchos.git';
        }
        if (cmd === 'glab' && args.includes('--version')) {
          return 'glab version 1.36.0 (2024-02-20)';
        }
        throw new Error('command not found');
      },
      // ...but env var overrides to gitlab
      env: { EXARCHOS_VCS_PROVIDER: 'gitlab' },
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('gitlab');
    // Remote URL is still reported from git
    expect(result!.remoteUrl).toBe('https://github.com/lvlup-sw/exarchos.git');
    // CLI check uses the overridden provider (glab, not gh)
    expect(result!.cliAvailable).toBe(true);
    expect(result!.cliVersion).toBe('1.36.0');
  });

  it('detectVcsProvider_ExarchosVcsProviderEnvInvalid_IgnoresOverride', async () => {
    const deps: VcsDetectorDeps = {
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://github.com/lvlup-sw/exarchos.git';
        }
        throw new Error('command not found');
      },
      // Invalid provider name — should be ignored
      env: { EXARCHOS_VCS_PROVIDER: 'bitbucket' },
    };

    const result = await detectVcsProvider(deps);

    expect(result).not.toBeNull();
    // Falls back to URL detection
    expect(result!.provider).toBe('github');
  });

  it('detectVcsProvider_ExarchosVcsProviderEnvNoRemote_StillDetectsProvider', async () => {
    const deps: VcsDetectorDeps = {
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          throw new Error('fatal: No such remote');
        }
        if (cmd === 'gh' && args.includes('--version')) {
          return 'gh version 2.45.0 (2024-03-15)';
        }
        throw new Error('command not found');
      },
      env: { EXARCHOS_VCS_PROVIDER: 'github' },
    };

    const result = await detectVcsProvider(deps);

    // Even with no remote, the env override provides a provider
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('github');
    expect(result!.remoteUrl).toBe('');
    expect(result!.cliAvailable).toBe(true);
  });
});

// ─── T5: Edge cases ──────────────────────────────────────────────────────────

describe('detectVcsProvider — edge cases', () => {
  it('detectVcsProvider_NoRemote_ReturnsNull', async () => {
    const deps: VcsDetectorDeps = {
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
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://bitbucket.org/myteam/myrepo.git';
        }
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).toBeNull();
  });

  it('detectVcsProvider_MalformedUrl_ReturnsNull', async () => {
    const deps: VcsDetectorDeps = {
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return 'not-a-valid-url';
        }
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).toBeNull();
  });

  it('detectVcsProvider_EmptyRemoteUrl_ReturnsNull', async () => {
    const deps: VcsDetectorDeps = {
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return '';
        }
        throw new Error('command not found');
      },
      env: {},
    };

    const result = await detectVcsProvider(deps);

    expect(result).toBeNull();
  });

  it('detectVcsProvider_WhitespaceInUrl_TrimsAndParses', async () => {
    const deps: VcsDetectorDeps = {
      exec: async (cmd: string, args: string[]): Promise<string> => {
        if (cmd === 'git' && args.includes('get-url')) {
          return '  https://github.com/lvlup-sw/exarchos.git\n';
        }
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
