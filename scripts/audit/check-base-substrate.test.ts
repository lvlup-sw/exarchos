import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { checkBaseSubstrate, type SubstrateCheckDeps } from './check-base-substrate.js';

function captureDeps(overrides: {
  fileExists?: (filePath: string) => boolean;
}): { deps: SubstrateCheckDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: SubstrateCheckDeps = {
    fileExists: overrides.fileExists ?? (() => true),
    log: (m) => out.push(m),
    errlog: (m) => err.push(m),
  };
  return { deps, out, err };
}

describe('checkBaseSubstrate', () => {
  it('PASSES (exit 0) when both substrate files exist', () => {
    const { deps, out } = captureDeps({
      fileExists: () => true,
    });
    expect(checkBaseSubstrate(deps, '/repo')).toBe(0);
    expect(out.join('\n')).toMatch(/OK/);
  });

  it('FAILS (exit 1) when coverage-baseline.json is missing', () => {
    const { deps, err } = captureDeps({
      fileExists: (filePath: string) => !filePath.includes('coverage-baseline.json'),
    });
    expect(checkBaseSubstrate(deps, '/repo')).toBe(1);
    expect(err.join('\n')).toMatch(/coverage-baseline\.json/);
    expect(err.join('\n')).toMatch(/Substrate file missing/);
  });

  it('FAILS (exit 1) when check-coverage-ratchet.mjs is missing', () => {
    const { deps, err } = captureDeps({
      fileExists: (filePath: string) => !filePath.includes('check-coverage-ratchet.mjs'),
    });
    expect(checkBaseSubstrate(deps, '/repo')).toBe(1);
    expect(err.join('\n')).toMatch(/check-coverage-ratchet\.mjs/);
    expect(err.join('\n')).toMatch(/Substrate file missing/);
  });

  it('FAILS (exit 1) when both substrate files are missing', () => {
    const { deps, err } = captureDeps({
      fileExists: () => false,
    });
    expect(checkBaseSubstrate(deps, '/repo')).toBe(1);
    expect(err.join('\n')).toMatch(/Both substrate files are missing/);
    expect(err.join('\n')).toMatch(/coverage-baseline\.json/);
    expect(err.join('\n')).toMatch(/check-coverage-ratchet\.mjs/);
  });

  it('uses the provided repoRoot to resolve file paths', () => {
    const fileChecks: string[] = [];
    const { deps } = captureDeps({
      fileExists: (filePath: string) => {
        fileChecks.push(filePath);
        return true;
      },
    });
    checkBaseSubstrate(deps, '/custom/repo');
    // Build expected paths with path.join so the assertion matches the source's
    // native separators on every OS (Windows uses `\`, not `/`) — #1699 lane fix.
    expect(fileChecks).toContainEqual(path.join('/custom/repo', 'tools', 'audit', 'coverage-baseline.json'));
    expect(fileChecks).toContainEqual(path.join('/custom/repo', 'scripts', 'check-coverage-ratchet.mjs'));
  });

  it('logs a clear message naming each missing file', () => {
    const { deps, err } = captureDeps({
      fileExists: () => false,
    });
    checkBaseSubstrate(deps, '/repo');
    const errMsg = err.join('\n');
    expect(errMsg).toMatch(/coverage-baseline\.json/);
    expect(errMsg).toMatch(/check-coverage-ratchet\.mjs/);
  });

  it('mentions #1719 in the error message when substrate is missing', () => {
    const { deps, err } = captureDeps({
      fileExists: () => false,
    });
    checkBaseSubstrate(deps, '/repo');
    expect(err.join('\n')).toMatch(/#1719/);
  });
});
