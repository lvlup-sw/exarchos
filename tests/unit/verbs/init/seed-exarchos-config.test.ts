/**
 * Tests that `seedExarchosConfig` writes a starter `.exarchos.yml` from
 * detection results, never overwrites an existing file, and writes YAML that
 * `loadExarchosConfig` reads back.
 */
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import type { ResolvedVerificationRuntime } from '../../../../src/config/test-runtime-resolver.js';
import { loadExarchosConfig } from '../../../../src/config/load-exarchos-config.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedExarchosConfig } from '../../../../src/verbs/init/seed-exarchos-config.js';
/** A resolver result for an npm project, with `mutation`, `lint` and `contract` set to null. */
function npmResolve(): ResolvedVerificationRuntime {
  return {
    test: 'npm run test:run',
    typecheck: 'tsc --noEmit',
    install: 'npm install',
    mutation: null,
    lint: null,
    contract: null,
    source: 'detection',
  };
}

function bunResolve(): ResolvedVerificationRuntime {
  return {
    test: 'bun test',
    typecheck: 'tsc --noEmit',
    install: 'bun install',
    mutation: null,
    lint: null,
    contract: null,
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
        mutation: null,
        lint: null,
        contract: null,
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
        mutation: null,
        lint: null,
        contract: null,
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

  /**
   * When the resolver resolves `mutation` and `lint`, the seeder writes them as
   * top-level keys. It writes commands only, with no `verification:` policy block.
   */
  it('seed_NoExistingConfig_VerificationCommandsResolved_WritesMutationAndLint', () => {
    const writes: Array<{ p: string; contents: string }> = [];
    const result = seedExarchosConfig('/repo', {
      exists: () => false,
      write: (p, contents) => writes.push({ p, contents }),
      resolve: () => ({
        test: 'pytest',
        typecheck: null,
        install: null,
        mutation: 'mutmut run',
        lint: 'ruff check',
        contract: null,
        source: 'detection',
      }),
    });

    expect(result.wrote).toBe(true);
    const body = writes[0].contents;
    expect(body).toContain('test: pytest');
    expect(body).toContain('mutation: mutmut run');
    expect(body).toContain('lint: ruff check');
    expect(body).not.toMatch(/^verification:/m);
  });

  /**
   * `mutation` can resolve when the test, typecheck and install commands do not.
   * The unresolved-no-fields check must count it, so the seeder still writes the file.
   */
  it('seed_NoExistingConfig_OnlyVerificationCommandResolves_StillWrites', () => {
    const writes: Array<{ p: string; contents: string }> = [];
    const result = seedExarchosConfig('/repo', {
      exists: () => false,
      write: (p, contents) => writes.push({ p, contents }),
      resolve: () => ({
        test: null,
        typecheck: null,
        install: null,
        mutation: 'npx stryker run',
        lint: null,
        contract: null,
        source: 'unresolved',
        remediation: 'No test command, but mutation resolved.',
      }),
    });

    expect(result.wrote).toBe(true);
    const body = writes[0].contents;
    expect(body).toContain('mutation: npx stryker run');
    expect(body).not.toMatch(/^test:/m);
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
    expect(body).toContain('# This file declares the commands Exarchos uses for gates and worktree setup —');
    expect(body).toContain('# test, typecheck, install, plus the verification-ladder commands mutation and');
    expect(body).toContain('# at workflow init time. Edit freely; subsequent inits will not overwrite it.');
    expect(body).toContain('https://github.com/lvlup-sw/exarchos/issues/1199');
  });

  /**
   * The seeder writes the invariants stanza as comments, so nothing loads until
   * the operator uncomments it. The stanza says what a catalog registration does
   * and shows a `catalogs:` example.
   */
  it('seed_AppendsCommentedInvariantsStanza', () => {
    const writes: Array<{ p: string; contents: string }> = [];
    seedExarchosConfig('/repo', {
      exists: () => false,
      write: (p, contents) => writes.push({ p, contents }),
      resolve: () => npmResolve(),
    });

    const body = writes[0].contents;
    expect(body).toContain('# invariants:');
    expect(body).toMatch(/#\s*catalogs:/);
    expect(body).toMatch(/dev[- ]catalog|architectural invariant/i);
  });

  /**
   * `devCatalog` is retired. The seed must not emit it, not even as a comment,
   * because an operator uncomments a commented line and `exarchos doctor` then
   * flags the key. The positive control proves that the seed ran, so the
   * absence check is not vacuous.
   */
  it('seed_NeverEmitsRetiredDevCatalogFlag', () => {
    const writes: Array<{ p: string; contents: string }> = [];
    seedExarchosConfig('/repo', {
      exists: () => false,
      write: (p, contents) => writes.push({ p, contents }),
      resolve: () => npmResolve(),
    });
    const body = writes[0].contents;

    expect(writes).toHaveLength(1);
    expect(body).toContain('# invariants:');
    expect(body).toMatch(/#\s*catalogs:/);

    expect(body.toLowerCase()).not.toContain('devcatalog');
  });

  /**
   * A fresh seed has no active `invariants:` key, so the loaded configuration
   * does not change until the operator opts in.
   */
  it('seed_InvariantsStanza_IsCommentedNotActive', () => {
    const writes: Array<{ p: string; contents: string }> = [];
    seedExarchosConfig('/repo', {
      exists: () => false,
      write: (p, contents) => writes.push({ p, contents }),
      resolve: () => npmResolve(),
    });
    const body = writes[0].contents;
    expect(body).not.toMatch(/^invariants:/m);
  });

  it('seed_InvariantsStanza_IsIdempotent_NeverOverwrites', () => {
    const writeSpy = vi.fn<(p: string, contents: string) => void>();
    const result = seedExarchosConfig('/repo', {
      exists: () => true,
      write: writeSpy,
      resolve: () => npmResolve(),
    });
    expect(result.wrote).toBe(false);
    expect(result.reason).toBe('already-exists');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  /**
   * The stub also resolves `mutation` and `lint`, so a loader that drops them
   * fails here. `findRepoRoot` returns the temp directory, which skips the git lookup.
   */
  it('seed_RoundTripsThroughLoader', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'seed-roundtrip-'));
    try {
      let seeded = '';
      const result = seedExarchosConfig(tempDir, {
        exists: () => false,
        write: (_p, contents) => {
          seeded = contents;
        },
        resolve: () => ({ ...npmResolve(), mutation: 'npx stryker run', lint: 'eslint .' }),
      });
      expect(result.wrote).toBe(true);

      const cfgPath = path.join(tempDir, '.exarchos.yml');
      await writeFile(cfgPath, seeded, 'utf8');

      const load = loadExarchosConfig(tempDir, {
        findRepoRoot: () => tempDir,
      });
      expect(load).not.toBeNull();
      expect(load!.config.test).toBe('npm run test:run');
      expect(load!.config.typecheck).toBe('tsc --noEmit');
      expect(load!.config.install).toBe('npm install');
      expect(load!.config.mutation).toBe('npx stryker run');
      expect(load!.config.lint).toBe('eslint .');
    } finally {
      await rmrfAsync(tempDir).catch(() => {});
    }
  });
});
