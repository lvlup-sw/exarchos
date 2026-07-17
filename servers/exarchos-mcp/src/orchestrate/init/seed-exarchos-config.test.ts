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

import type { ResolvedVerificationRuntime } from '../../config/test-runtime-resolver.js';
import { loadExarchosConfig } from '../../config/load-exarchos-config.js';
import { seedExarchosConfig } from './seed-exarchos-config.js';

// The seeder resolves the WIDENED verification field set (§4.5-seed): the legacy
// test/typecheck/install PLUS mutation/lint/contract. These stubs mirror the
// resolver's `ResolvedVerificationRuntime` shape — mutation/lint default to null
// (the unresolved-no-fields gate now considers them too).
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
    expect(writes[0]!.p).toBe(path.join('/repo', '.exarchos.yml'));
    expect(writes[0]!.contents).toContain('test: npm run test:run');
    expect(writes[0]!.contents).toContain('typecheck: tsc --noEmit');
    expect(writes[0]!.contents).toContain('install: npm install');
    expect(writes[0]!.contents).toContain('# .exarchos.yml');
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
    expect(writes[0]!.contents).toContain('test: bun test');
    expect(writes[0]!.contents).toContain('install: bun install');
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
    const body = writes[0]!.contents;
    expect(body).toContain('test: pytest');
    expect(body).not.toMatch(/^typecheck:/m);
    expect(body).not.toMatch(/^install:/m);
  });

  it('seed_NoExistingConfig_VerificationCommandsResolved_WritesMutationAndLint', () => {
    // §4.5-seed: when the widened resolver resolves mutation + lint, the seeder
    // writes them as top-level direct keys (tier 2) alongside the legacy triple.
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
    const body = writes[0]!.contents;
    expect(body).toContain('test: pytest');
    expect(body).toContain('mutation: mutmut run');
    expect(body).toContain('lint: ruff check');
    // NEGATIVE GUARANTEE (§4.5): commands only — no `verification:` policy block.
    expect(body).not.toMatch(/^verification:/m);
  });

  it('seed_NoExistingConfig_OnlyVerificationCommandResolves_StillWrites', () => {
    // mutation/lint can resolve even when the legacy triple is unresolved (a
    // toolchain with a mutation runner but no conventional test command). The
    // unresolved-no-fields gate must consider the widened fields, else a
    // resolvable verification command would be silently dropped.
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
    const body = writes[0]!.contents;
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

    const body = writes[0]!.contents;
    expect(body).toContain('# .exarchos.yml — Exarchos project configuration.');
    expect(body).toContain('# This file declares the commands Exarchos uses for gates and worktree setup —');
    expect(body).toContain('# test, typecheck, install, plus the verification-ladder commands mutation and');
    expect(body).toContain('# at workflow init time. Edit freely; subsequent inits will not overwrite it.');
    expect(body).toContain('https://github.com/lvlup-sw/exarchos/issues/1199');
  });

  // ─── #1479: commented invariants: onboarding stanza ─────────────────────

  it('seed_AppendsCommentedInvariantsStanza', () => {
    const writes: Array<{ p: string; contents: string }> = [];
    seedExarchosConfig('/repo', {
      exists: () => false,
      write: (p, contents) => writes.push({ p, contents }),
      resolve: () => npmResolve(),
    });

    const body = writes[0]!.contents;
    // The stanza is emitted COMMENTED so it documents the opt-in without
    // changing behaviour (devCatalog stays effectively disabled until the
    // operator uncomments it). The block carries a one-line explanation, a
    // `devCatalog: disabled` line, and a stubbed `catalogs:` example.
    expect(body).toContain('# invariants:');
    expect(body).toMatch(/#\s*devCatalog:\s*disabled/);
    expect(body).toMatch(/#\s*catalogs:/);
    // The explanatory comment must mention what enabling the dev catalog does.
    expect(body).toMatch(/dev[- ]catalog|architectural invariant/i);
  });

  it('seed_InvariantsStanza_IsCommentedNotActive', () => {
    // The seeded stanza must not change the parsed/active config: a fresh
    // seed should still load with no `invariants` block set (it is all
    // comments), so behaviour is unchanged until the operator opts in.
    const writes: Array<{ p: string; contents: string }> = [];
    seedExarchosConfig('/repo', {
      exists: () => false,
      write: (p, contents) => writes.push({ p, contents }),
      resolve: () => npmResolve(),
    });
    const body = writes[0]!.contents;
    // No ACTIVE (uncommented) invariants: key at column 0.
    expect(body).not.toMatch(/^invariants:/m);
  });

  it('seed_InvariantsStanza_IsIdempotent_NeverOverwrites', () => {
    // Re-running on an existing config must not write at all (never
    // overwrite, never duplicate the stanza).
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

  it('seed_RoundTripsThroughLoader', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'seed-roundtrip-'));
    try {
      // Capture seeded contents using the injected write hook. The resolver stub
      // also resolves mutation/lint so the round-trip covers the WIDENED command
      // surface — a regression where `loadExarchosConfig` drops or rejects
      // mutation/lint must fail here, not pass against the legacy keys alone.
      let seeded = '';
      const result = seedExarchosConfig(tempDir, {
        exists: () => false,
        write: (_p, contents) => {
          seeded = contents;
        },
        resolve: () => ({ ...npmResolve(), mutation: 'npx stryker run', lint: 'eslint .' }),
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
      // The widened verification-ladder commands survive the seed → load round-trip.
      expect(load!.config.mutation).toBe('npx stryker run');
      expect(load!.config.lint).toBe('eslint .');
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
