import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectDesiredState } from '../../../../../src/dispatch/core/onboarding/reconcile.js';
import {
  resolveTestRuntime,
  resolveVerificationRuntime,
} from '../../../../../src/config/test-runtime-resolver.js';
import { DesiredStateSchema } from '../../../../../src/dispatch/core/onboarding/types.js';
import { rmrf } from '../../../../../tools/test-helpers/temp-dir.js';

/**
 * `detectDesiredState` takes `commands` only from the layered resolver. Each command equals the
 * resolver output for the same repo, and an unresolved (`null`) field is absent from `commands`.
 * Each test runs the real resolver over a temp-dir fixture.
 */
describe('DetectDesiredState_DerivesCommands_FromLayeredResolver', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'detect-desired-'));
  });

  afterEach(() => {
    rmrf(dir);
  });

  /** The npm literals prove that the resolver resolved this fixture. */
  it('derives test/typecheck/install from the layered resolver for a node repo', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const resolved = resolveTestRuntime(dir);
    const desired = await detectDesiredState(dir, { detectRuntimes: async () => [] });

    expect(desired.commands.test).toBe(resolved.test ?? undefined);
    expect(desired.commands.typecheck).toBe(resolved.typecheck ?? undefined);
    expect(desired.commands.install).toBe(resolved.install ?? undefined);

    expect(desired.commands.test).toBe('npm run test:run');
    expect(desired.commands.install).toBe('npm install');

    expect(DesiredStateSchema.safeParse(desired).success).toBe(true);
  });

  /**
   * For a dotnet repo the resolver gives `dotnet test` and leaves `typecheck` and `install` as
   * `null`. The test asserts that resolver shape first, so a registry change fails as a
   * precondition.
   */
  it('omits (never fabricates) a command field the resolver leaves unresolved', async () => {
    writeFileSync(join(dir, 'Foo.csproj'), '<Project/>');

    const resolved = resolveTestRuntime(dir);
    const desired = await detectDesiredState(dir, { detectRuntimes: async () => [] });

    expect(resolved.test).toBe('dotnet test');
    expect(resolved.typecheck).toBeNull();
    expect(resolved.install).toBeNull();

    expect(desired.commands.test).toBe('dotnet test');
    expect('typecheck' in desired.commands).toBe(false);
    expect('install' in desired.commands).toBe(false);
    expect(desired.commands.typecheck).toBeUndefined();
    expect(desired.commands.install).toBeUndefined();

    expect(desired.commands.install).not.toBe('npm install');
  });

  it('reports vcs as git when a .git dir is present, none otherwise', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:run': 'vitest run' } }));
    expect((await detectDesiredState(dir, { detectRuntimes: async () => [] })).vcs).toBe('none');

    const gitDir = mkdtempSync(join(tmpdir(), 'detect-desired-git-'));
    try {
      writeFileSync(join(gitDir, 'package.json'), '{}');
      mkdirSync(join(gitDir, '.git'));
      expect((await detectDesiredState(gitDir, { detectRuntimes: async () => [] })).vcs).toBe('git');
    } finally {
      rmrf(gitDir);
    }
  });

  /**
   * The built-in registry gives a node repo the mutation command `npx stryker run`. The
   * `package.json` marker is the only trigger: the fixture holds no Stryker config.
   */
  it('DetectDesiredState_NodeFixtureWithStryker_ResolvesMutationCommand', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const resolved = resolveVerificationRuntime(dir);
    expect(resolved.mutation).toBe('npx stryker run');

    const desired = await detectDesiredState(dir, { detectRuntimes: async () => [] });

    expect(desired.commands.mutation).toBe(resolved.mutation ?? undefined);
    expect(desired.commands.mutation).toBe('npx stryker run');

    expect(DesiredStateSchema.safeParse(desired).success).toBe(true);
  });

  /** A directory with no toolchain marker leaves `mutation` and `lint` unresolved. */
  it('DetectDesiredState_UnresolvableMutation_LeavesFieldAbsent', async () => {
    const resolved = resolveVerificationRuntime(dir);
    expect(resolved.mutation).toBeNull();

    const desired = await detectDesiredState(dir, { detectRuntimes: async () => [] });

    expect('mutation' in desired.commands).toBe(false);
    expect(desired.commands.mutation).toBeUndefined();

    expect('lint' in desired.commands).toBe(false);
    expect(desired.commands.lint).toBeUndefined();
  });

  /**
   * `resolveVerificationRuntime` delegates `test`, `typecheck` and `install` to
   * `resolveTestRuntime`, so detection returns the same three values. The literals match the pin in
   * `reconcile.characterization.test.ts`.
   */
  it('DetectDesiredState_ExistingFields_ByteIdenticalToT0Pin', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const legacy = resolveTestRuntime(dir);
    const desired = await detectDesiredState(dir, { detectRuntimes: async () => [] });

    expect(desired.commands.test).toBe(legacy.test ?? undefined);
    expect(desired.commands.typecheck).toBe(legacy.typecheck ?? undefined);
    expect(desired.commands.install).toBe(legacy.install ?? undefined);

    expect(desired.commands.test).toBe('npm run test:run');
    expect(desired.commands.typecheck).toBe('npm run typecheck');
    expect(desired.commands.install).toBe('npm install');
  });

  it('returns a string[] of runtimes and honors runtime/vcs overrides', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:run': 'vitest run' } }));

    const desired = await detectDesiredState(dir, { detectRuntimes: async () => ['claude-code'] });
    expect(Array.isArray(desired.runtimes)).toBe(true);
    expect(desired.runtimes).toEqual(['claude-code']);

    const overridden = await detectDesiredState(dir, { runtimes: ['codex', 'cursor'] });
    expect(overridden.runtimes).toEqual(['codex', 'cursor']);

    const vcsOverridden = await detectDesiredState(dir, {
      vcs: 'git',
      detectRuntimes: async () => [],
    });
    expect(vcsOverridden.vcs).toBe('git');
  });
});
