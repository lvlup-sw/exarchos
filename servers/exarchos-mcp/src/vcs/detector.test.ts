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
