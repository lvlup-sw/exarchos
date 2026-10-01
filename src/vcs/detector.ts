/**
 * Detects the VCS provider (GitHub, GitLab, or Azure DevOps) from the git remote URL
 * or an env var override, and checks whether the provider CLI is available.
 * `VcsDetectorDeps` injects the side effects (`exec` and env).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  const httpsMatch = remoteUrl.match(/^https?:\/\/([^/]+)/);
  if (httpsMatch) return httpsMatch[1]!;

  const sshMatch = remoteUrl.match(/^[^@]+@([^:]+):/);
  if (sshMatch) return sshMatch[1]!;

  return null;
}

/**
 * Maps the remote hostname to a VCS provider: `github.com`, `gitlab.com` or a
 * `gitlab.` host, and `dev.azure.com` or a `*.visualstudio.com` host.
 */
function parseRemoteUrl(remoteUrl: string): VcsProviderName | null {
  const hostname = extractHostname(remoteUrl);
  if (!hostname) return null;

  if (hostname === 'github.com') return 'github';

  if (hostname === 'gitlab.com' || hostname.startsWith('gitlab.')) return 'gitlab';

  if (hostname === 'dev.azure.com' || hostname.endsWith('.visualstudio.com')) return 'azure-devops';

  return null;
}

const VALID_PROVIDERS: readonly VcsProviderName[] = ['github', 'gitlab', 'azure-devops'];

/** Parse env var override, returning null if absent or invalid. */
function parseEnvOverride(env: Record<string, string | undefined>): VcsProviderName | null {
  const raw = env.EXARCHOS_VCS_PROVIDER;
  if (!raw) return null;
  return (VALID_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as VcsProviderName)
    : null;
}

/** Map provider → CLI command and version args. */
function cliCommandFor(provider: VcsProviderName): { cmd: string; args: string[] } {
  switch (provider) {
    case 'github':      return { cmd: 'gh',   args: ['--version'] };
    case 'gitlab':      return { cmd: 'glab', args: ['--version'] };
    case 'azure-devops': return { cmd: 'az',  args: ['--version'] };
  }
}

/**
 * Extract a semver-like version string from CLI output.
 * Matches patterns like "2.45.0", "1.36.0", "2.58.0".
 */
function parseCliVersion(output: string): string | undefined {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match?.[1];
}

/**
 * Check if the CLI tool for the given provider is available on PATH.
 * Returns `{ cliAvailable, cliVersion }`.
 */
async function checkCliAvailability(
  exec: (cmd: string, args: string[]) => Promise<string>,
  provider: VcsProviderName,
): Promise<{ cliAvailable: boolean; cliVersion?: string | undefined }> {
  const { cmd, args } = cliCommandFor(provider);
  try {
    const output = await exec(cmd, args);
    const cliVersion = parseCliVersion(output);
    return { cliAvailable: true, cliVersion };
  } catch {
    return { cliAvailable: false };
  }
}

/**
 * Detects the VCS environment of the current repo. A valid `EXARCHOS_VCS_PROVIDER`
 * wins over the remote URL. If the `origin` URL cannot be read, the result has an
 * empty URL when the override is set, and is null when it is not.
 */
export async function detectVcsProvider(
  deps?: VcsDetectorDeps,
): Promise<VcsEnvironment | null> {
  const exec = deps?.exec ?? DEFAULT_EXEC;
  const env = deps?.env ?? process.env;

  const envOverride = parseEnvOverride(env);

  let remoteUrl: string;
  try {
    remoteUrl = (await exec('git', ['remote', 'get-url', 'origin'])).trim();
  } catch {
    if (envOverride) {
      remoteUrl = '';
    } else {
      return null;
    }
  }

  const provider = envOverride ?? parseRemoteUrl(remoteUrl);
  if (!provider) return null;

  const { cliAvailable, cliVersion } = await checkCliAvailability(exec, provider);

  return {
    provider,
    remoteUrl,
    cliAvailable,
    ...(cliVersion !== undefined ? { cliVersion } : {}),
  };
}
