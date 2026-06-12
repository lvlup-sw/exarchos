import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectDesiredState } from './reconcile.js';
import {
  resolveTestRuntime,
  resolveVerificationRuntime,
} from '../../config/test-runtime-resolver.js';
import { DesiredStateSchema } from './types.js';

/**
 * DR-1 / INV-6: `detectDesiredState` must derive `commands` PURELY from the
 * Bundle B layered resolver (`resolveTestRuntime`) — never a string-rewrite.
 *
 * The contract these tests pin:
 *  1. Each derived command equals exactly what `resolveTestRuntime` returns for
 *     the same repo (same source of truth → proves no parallel derivation).
 *  2. A field the resolver leaves unresolved (`null`) is ABSENT from
 *     `commands` — never fabricated into a string (Task 004 omit-never-fabricate).
 *  3. A non-Node (dotnet) fixture resolves dotnet commands via the resolver,
 *     proving the path is workload-agnostic and not an npm-rewrite.
 */
describe('DetectDesiredState_DerivesCommands_FromLayeredResolver', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'detect-desired-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('derives test/typecheck/install from the layered resolver for a node repo', async () => {
    // A node repo whose package.json declares the test:run script the resolver
    // keys on. The resolver should produce npm commands for all three fields.
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const resolved = resolveTestRuntime(dir);
    const desired = await detectDesiredState(dir, { detectRuntimes: async () => [] });

    // Whatever the resolver returns is exactly what detect surfaces — same
    // source of truth, no independent derivation.
    expect(desired.commands.test).toBe(resolved.test ?? undefined);
    expect(desired.commands.typecheck).toBe(resolved.typecheck ?? undefined);
    expect(desired.commands.install).toBe(resolved.install ?? undefined);

    // Sanity: this fixture resolves to the npm shape (proves the resolver ran).
    expect(desired.commands.test).toBe('npm run test:run');
    expect(desired.commands.install).toBe('npm install');

    // The whole DesiredState is schema-valid (Task 004 contract).
    expect(DesiredStateSchema.safeParse(desired).success).toBe(true);
  });

  it('omits (never fabricates) a command field the resolver leaves unresolved', async () => {
    // A dotnet repo: the resolver returns `test: 'dotnet test'` but
    // `typecheck: null` and `install: null`. Those nulls MUST be omitted, not
    // turned into a fabricated command string.
    writeFileSync(join(dir, 'Foo.csproj'), '<Project/>');

    const resolved = resolveTestRuntime(dir);
    const desired = await detectDesiredState(dir, { detectRuntimes: async () => [] });

    // Precondition on the resolver's shape (guards against a registry change
    // silently invalidating this test's intent).
    expect(resolved.test).toBe('dotnet test');
    expect(resolved.typecheck).toBeNull();
    expect(resolved.install).toBeNull();

    // test is present and equals the resolver output …
    expect(desired.commands.test).toBe('dotnet test');
    // … and the unresolved fields are ABSENT (not `null`, not a fabricated
    // string like 'npm install' from an npm-rewrite).
    expect('typecheck' in desired.commands).toBe(false);
    expect('install' in desired.commands).toBe(false);
    expect(desired.commands.typecheck).toBeUndefined();
    expect(desired.commands.install).toBeUndefined();

    // Proves no npm-rewrite leaked dotnet → npm anywhere.
    expect(desired.commands.install).not.toBe('npm install');
  });

  it('reports vcs as git when a .git dir is present, none otherwise', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:run': 'vitest run' } }));
    // No .git → vcs is 'none'.
    expect((await detectDesiredState(dir, { detectRuntimes: async () => [] })).vcs).toBe('none');

    // With a .git directory → 'git'.
    const gitDir = mkdtempSync(join(tmpdir(), 'detect-desired-git-'));
    try {
      writeFileSync(join(gitDir, 'package.json'), '{}');
      // Materialize a .git directory marker.
      mkdirSync(join(gitDir, '.git'));
      expect((await detectDesiredState(gitDir, { detectRuntimes: async () => [] })).vcs).toBe('git');
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });

  it('DetectDesiredState_NodeFixtureWithStryker_ResolvesMutationCommand', async () => {
    // Task 007 (design §4.5-detect): detect now flows command derivation through
    // `resolveVerificationRuntime`, which seeds a node repo's mutation command
    // from the built-in registry tier (the node toolchain canonical
    // `npx stryker run`). The fixture triggers the REAL registry tier — a node
    // marker (package.json) — with NO stubbing of the resolver itself.
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    // Provenance precondition: the REAL widened resolver resolves the node
    // mutation command (guards against a registry change silently breaking intent).
    const resolved = resolveVerificationRuntime(dir);
    expect(resolved.mutation).toBe('npx stryker run');

    const desired = await detectDesiredState(dir, { detectRuntimes: async () => [] });

    // detect surfaces EXACTLY what the widened resolver returns — same source of
    // truth, no parallel derivation.
    expect(desired.commands.mutation).toBe(resolved.mutation ?? undefined);
    expect(desired.commands.mutation).toBe('npx stryker run');

    // The whole DesiredState remains schema-valid with the new field present.
    expect(DesiredStateSchema.safeParse(desired).success).toBe(true);
  });

  it('DetectDesiredState_UnresolvableMutation_LeavesFieldAbsent', async () => {
    // A bare directory (no toolchain markers): the widened resolver leaves
    // `mutation: null`. Per the omit-never-fabricate contract (INV-6), an
    // unresolved mutation field is ABSENT from commands — not `null`, not a
    // fabricated string.
    const resolved = resolveVerificationRuntime(dir);
    expect(resolved.mutation).toBeNull();

    const desired = await detectDesiredState(dir, { detectRuntimes: async () => [] });

    expect('mutation' in desired.commands).toBe(false);
    expect(desired.commands.mutation).toBeUndefined();

    // Lint is also unresolved here and must likewise be absent.
    expect('lint' in desired.commands).toBe(false);
    expect(desired.commands.lint).toBeUndefined();
  });

  it('DetectDesiredState_ExistingFields_ByteIdenticalToT0Pin', async () => {
    // The T0 characterization fixture: a node repo declaring `test:run` +
    // `typecheck`. Widening to `resolveVerificationRuntime` must NOT perturb the
    // legacy test/typecheck/install fields — they stay byte-identical to the
    // pre-change behavior (which `resolveTestRuntime` still defines verbatim,
    // since `resolveVerificationRuntime` delegates the legacy three to it).
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const legacy = resolveTestRuntime(dir);
    const desired = await detectDesiredState(dir, { detectRuntimes: async () => [] });

    // Byte-identical to the legacy resolver output (the pre-change source of truth).
    expect(desired.commands.test).toBe(legacy.test ?? undefined);
    expect(desired.commands.typecheck).toBe(legacy.typecheck ?? undefined);
    expect(desired.commands.install).toBe(legacy.install ?? undefined);

    // Concrete pin matching the T0 baseline snapshot (reconcile.characterization).
    expect(desired.commands.test).toBe('npm run test:run');
    expect(desired.commands.typecheck).toBe('npm run typecheck');
    expect(desired.commands.install).toBe('npm install');
  });

  it('returns a string[] of runtimes and honors runtime/vcs overrides', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:run': 'vitest run' } }));

    const desired = await detectDesiredState(dir, { detectRuntimes: async () => ['claude-code'] });
    expect(Array.isArray(desired.runtimes)).toBe(true);
    expect(desired.runtimes).toEqual(['claude-code']);

    // An explicit runtime override is surfaced verbatim (DR-2 `--runtime`).
    const overridden = await detectDesiredState(dir, { runtimes: ['codex', 'cursor'] });
    expect(overridden.runtimes).toEqual(['codex', 'cursor']);

    // An explicit vcs override is surfaced verbatim (DR-2 `--vcs`).
    const vcsOverridden = await detectDesiredState(dir, {
      vcs: 'git',
      detectRuntimes: async () => [],
    });
    expect(vcsOverridden.vcs).toBe('git');
  });
});
