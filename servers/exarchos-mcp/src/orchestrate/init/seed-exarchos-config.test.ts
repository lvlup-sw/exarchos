/**
 * seedExarchosConfig — T14 (#1199 Stage 2).
 *
 * Verifies that workflow init writes a starter `.exarchos.yml` from
 * detection results, never overwriting an existing one, and produces
 * YAML that round-trips through the T12 loader.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { ResolvedRuntime } from '../../config/test-runtime-resolver.js';
import { loadExarchosConfig } from '../../config/load-exarchos-config.js';
import { seedExarchosConfig } from './seed-exarchos-config.js';

function npmResolve(): ResolvedRuntime {
  return {
    test: 'npm run test:run',
    typecheck: 'tsc --noEmit',
    install: 'npm install',
    source: 'detection',
  };
}

function bunResolve(): ResolvedRuntime {
  return {
    test: 'bun test',
    typecheck: 'tsc --noEmit',
    install: 'bun install',
    source: 'detection',
  };
}

describe('seedExarchosConfig', () => {
  it('seed_NoExistingConfig_NpmDetection_WritesYamlWithCommands', () => {
    const writes: Array<{ p: string; contents: string }> = [];
    const result = seedExarchosConfig('/repo', {
      exists: () => false,
      write: (p, contents) => writes.push({ p, contents }),
      resolve: () => npmResolve(),
    });

    expect(result.wrote).toBe(true);
    expect(result.reason).toBe('created');
    expect(result.path).toBe(path.join('/repo', '.exarchos.yml'));
    expect(writes).toHaveLength(1);
    expect(writes[0].p).toBe(path.join('/repo', '.exarchos.yml'));
    expect(writes[0].contents).toContain('test: npm run test:run');
    expect(writes[0].contents).toContain('typecheck: tsc --noEmit');
    expect(writes[0].contents).toContain('install: npm install');
    expect(writes[0].contents).toContain('# .exarchos.yml');
  });

  it('seed_NoExistingConfig_BunDetection_WritesYamlWithBunCommands', () => {
    const writes: Array<{ p: string; contents: string }> = [];
    const result = seedExarchosConfig('/repo', {
      exists: () => false,
      write: (p, contents) => writes.push({ p, contents }),
      resolve: () => bunResolve(),
    });

    expect(result.wrote).toBe(true);
    expect(result.reason).toBe('created');
    expect(writes).toHaveLength(1);
    expect(writes[0].contents).toContain('test: bun test');
    expect(writes[0].contents).toContain('install: bun install');
  });

  it('seed_ExistingConfig_DoesNotOverwrite', () => {
    const writeSpy = vi.fn<(p: string, contents: string) => void>();
    const result = seedExarchosConfig('/repo', {
      exists: () => true,
      write: writeSpy,
      resolve: () => npmResolve(),
    });

    expect(result.wrote).toBe(false);
    expect(result.reason).toBe('already-exists');
    expect(result.path).toBe(path.join('/repo', '.exarchos.yml'));
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('seed_NoExistingConfig_UnresolvedNoFields_DoesNotWriteEmptyConfig', () => {
    const writeSpy = vi.fn<(p: string, contents: string) => void>();
    const result = seedExarchosConfig('/repo', {
      exists: () => false,
      write: writeSpy,
      resolve: () => ({
        test: null,
        typecheck: null,
        install: null,
        source: 'unresolved',
        remediation: 'No project markers detected.',
      }),
    });

    expect(result.wrote).toBe(false);
    expect(result.reason).toBe('unresolved-no-fields');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('seed_NoExistingConfig_PartialDetection_WritesOnlyResolvedFields', () => {
    const writes: Array<{ p: string; contents: string }> = [];
    const result = seedExarchosConfig('/repo', {
      exists: () => false,
      write: (p, contents) => writes.push({ p, contents }),
      resolve: () => ({
        test: 'pytest',
        typecheck: null,
        install: null,
        source: 'detection',
      }),
    });

    expect(result.wrote).toBe(true);
    expect(writes).toHaveLength(1);
    const body = writes[0].contents;
    expect(body).toContain('test: pytest');
    expect(body).not.toMatch(/^typecheck:/m);
    expect(body).not.toMatch(/^install:/m);
  });

  it('seed_HeaderCommentPresent', () => {
    const writes: Array<{ p: string; contents: string }> = [];
    seedExarchosConfig('/repo', {
      exists: () => false,
      write: (p, contents) => writes.push({ p, contents }),
      resolve: () => npmResolve(),
    });

    const body = writes[0].contents;
    expect(body).toContain('# .exarchos.yml — Exarchos project configuration.');
    expect(body).toContain('# use for gates and worktree setup. Auto-seeded from detection at workflow');
    expect(body).toContain('# init time. Edit freely; subsequent inits will not overwrite it.');
    expect(body).toContain('https://github.com/lvlup-sw/exarchos/issues/1199');
  });

  it('seed_RoundTripsThroughLoader', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'seed-roundtrip-'));
    try {
      // Capture seeded contents using the injected write hook.
      let seeded = '';
      const result = seedExarchosConfig(tempDir, {
        exists: () => false,
        write: (_p, contents) => {
          seeded = contents;
        },
        resolve: () => npmResolve(),
      });
      expect(result.wrote).toBe(true);

      // Persist to disk and load via T12.
      const cfgPath = path.join(tempDir, '.exarchos.yml');
      await writeFile(cfgPath, seeded, 'utf8');

      const load = loadExarchosConfig(tempDir, {
        // Skip the git-rev-parse fallback by reporting tempDir as repo root.
        findRepoRoot: () => tempDir,
      });
      expect(load).not.toBeNull();
      expect(load!.config.test).toBe('npm run test:run');
      expect(load!.config.typecheck).toBe('tsc --noEmit');
      expect(load!.config.install).toBe('npm install');
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
