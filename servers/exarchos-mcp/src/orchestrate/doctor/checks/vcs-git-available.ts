/**
 * vcs-git-available — reports whether a git binary is on PATH and the
 * current working directory sits inside a repository. Short-circuits:
 * when the binary is missing, isRepo/version are not probed because the
 * fix (install git) is the same regardless. Prose follows the
 * `<observed state>. <imperative fix>` convention.
 */

import type { CheckResult } from '../schema.js';
import type { DoctorProbes } from '../probes.js';

export async function vcsGitAvailable(
  probes: DoctorProbes,
  _signal: AbortSignal,
): Promise<CheckResult> {
  const start = Date.now();
  const binary = await probes.git.which('git');
  if (binary === null) {
    return {
      category: 'vcs',
      name: 'git-available',
      status: 'Warning',
      message: 'Git binary not found on PATH.',
      fix: 'Install git from https://git-scm.com',
      durationMs: Date.now() - start,
    };
  }

  const inRepo = await probes.git.isRepo(process.cwd());
  if (!inRepo) {
    return {
      category: 'vcs',
      name: 'git-available',
      status: 'Warning',
      message: 'Git binary present but current directory is not a repository.',
      fix: 'Run git init in project root',
      durationMs: Date.now() - start,
    };
  }

  const version = (await probes.git.version()) ?? 'unknown';
  return {
    category: 'vcs',
    name: 'git-available',
    status: 'Pass',
    message: `Git ${version} detected in repository.`,
    durationMs: Date.now() - start,
  };
}
