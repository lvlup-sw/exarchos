/**
 * Spec for the editor MCP launch written by onboard and doctor --fix.
 *
 * A generate step runs every production init writer. The Cursor and Copilot
 * writers publish a project mcp.json whose exarchos stdio entry is the command
 * the editor spawns. The entry must be the local `exarchos mcp` binary, or a
 * package spec with an exact version and an integrity digest and without the
 * automatic-yes flag. A name-only package with `-y` is a floating registry
 * install. The editor's stdio spawn is not a TTY, so npx installs that
 * package and runs its bin.
 *
 * These tests fail while that floating entry is what the writers publish.
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { CheckResult } from '../../../../src/verbs/doctor/schema.js';
import { buildWriterDeps } from '../../../../src/verbs/init/probes.js';
import type { WriterDeps } from '../../../../src/verbs/init/probes.js';
import { getAllWriters } from '../../../../src/verbs/init/index.js';
import { checkBlockDrift } from '../../../../src/verbs/onboard/block-drift.js';
import { handleOnboard } from '../../../../src/verbs/onboard/index.js';
import { handleDoctorWithChecks } from '../../../../src/verbs/doctor/index.js';
import { makeStubProbes } from '../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

interface Fixture {
  readonly repoRoot: string;
  readonly homeDir: string;
  readonly base: string;
  readonly eventStore: EventStore;
  readonly ctx: DispatchContext;
}

/** A temp project with no on-ramp block, and a home directory that is not the user home. */
async function createFixture(prefix: string): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), prefix));
  const repoRoot = path.join(base, 'repo');
  const homeDir = path.join(base, 'home');
  const stateDir = path.join(base, 'state');
  await mkdir(repoRoot, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0' }),
    'utf8',
  );
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false, cwd: repoRoot };
  return { repoRoot, homeDir, base, eventStore, ctx };
}

/** Real filesystem writers, with cwd and home confined to the fixture. */
function fixtureWriterDeps(fx: Fixture): WriterDeps {
  const real = buildWriterDeps();
  return { ...real, cwd: () => fx.repoRoot, home: () => fx.homeDir };
}

/**
 * The on-ramp check for this project. A project without `AGENTS.md` is a
 * Warning with a fix, which the reconciler classifies as a generate step.
 */
function blockDriftCheck(repoRoot: string): Promise<CheckResult> {
  return Promise.resolve(checkBlockDrift(repoRoot));
}

interface StdioLaunch {
  readonly where: string;
  readonly command: unknown;
  readonly args: unknown;
}

/**
 * Stdio launches in an editor MCP file.
 * Cursor reads `mcpServers` in `.cursor/mcp.json`. VS Code's editor file reads `servers`.
 */
function stdioLaunches(parsed: unknown): StdioLaunch[] {
  if (typeof parsed !== 'object' || parsed === null) return [];
  const root = parsed as Record<string, unknown>;
  const launches: StdioLaunch[] = [];
  for (const key of ['mcpServers', 'servers'] as const) {
    const map = root[key];
    if (typeof map !== 'object' || map === null) continue;
    for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.url === 'string') continue;
      launches.push({ where: `${key}.${name}`, command: entry.command, args: entry.args });
    }
  }
  return launches;
}

/** True when the flag tells npm to answer yes, or when `-y` is the npx shorthand for that flag. */
function isAutomaticYes(arg: string): boolean {
  return arg === '-y' || arg === '--yes' || arg === '--yes=true';
}

/**
 * True for a registry spec that resolves to a moving target.
 * A name with no version is the range `*`, which selects the `latest` dist-tag.
 * A tag, a range, or a missing version does the same class of resolution.
 */
function isFloatingPackageSpec(spec: string): boolean {
  const versionAt = spec.lastIndexOf('@');
  if (!spec.startsWith('@') && versionAt <= 0) return true;
  if (spec.startsWith('@') && versionAt <= 0) return true;
  const version = spec.slice(versionAt + 1);
  return !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

/** True when the argument list carries an integrity digest for the installed package. */
function hasIntegrityPin(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith('--integrity=')) return true;
    if (arg === '--integrity') {
      const next = args[i + 1];
      return typeof next === 'string' && next.startsWith('sha');
    }
  }
  return false;
}

/** The local `exarchos mcp` launch, read-only or with the orchestrator `--operator` flag. */
function isLocalMcpLaunch(argv: readonly string[]): boolean {
  return argv[0] === 'mcp' && argv.length <= 2 && argv.slice(1).every((arg) => arg === '--operator');
}

/**
 * A launch is safe when it is the local exarchos binary.
 * A package runner is also safe when its positional specs are exact versions,
 * with an integrity pin and without the automatic-yes flag.
 */
function isPinnedEditorLaunch(command: unknown, args: unknown): boolean {
  if (typeof command !== 'string' || !Array.isArray(args)) return false;
  if (args.some((arg) => typeof arg !== 'string')) return false;
  const argv = args as string[];
  if (command === 'exarchos' && isLocalMcpLaunch(argv)) return true;
  if (argv.some(isAutomaticYes)) return false;
  const blob = [command, ...argv].join(' ');
  if (command !== 'npx' && command !== 'npm') {
    return !/\bnpx\b/.test(blob) && !isFloatingPackageSpec(blob);
  }
  if (!hasIntegrityPin(argv)) return false;
  const positional = argv.filter((arg) => !arg.startsWith('-'));
  if (positional.length === 0) return false;
  return positional.every((spec) => !isFloatingPackageSpec(spec));
}

/** Problems in one editor config. An empty list means every stdio launch, including exarchos, is pinned. */
async function unpinnedLaunchProblems(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, 'utf8');
  const launches = stdioLaunches(JSON.parse(raw) as unknown);
  const problems: string[] = [];
  const exarchos = launches.filter((launch) => launch.where.endsWith('.exarchos'));
  if (exarchos.length === 0) {
    problems.push(`${filePath} has no exarchos stdio launch: ${raw}`);
  }
  for (const launch of launches) {
    if (!isPinnedEditorLaunch(launch.command, launch.args)) {
      problems.push(
        `${filePath} ${launch.where} is an unpinned editor launch: ${JSON.stringify({ command: launch.command, args: launch.args })}`,
      );
    }
  }
  return problems;
}

/** Both project files the Cursor and Copilot writers publish. */
async function assertPinnedProjectLaunches(repoRoot: string): Promise<void> {
  const problems = [
    ...(await unpinnedLaunchProblems(path.join(repoRoot, '.cursor', 'mcp.json'))),
    ...(await unpinnedLaunchProblems(path.join(repoRoot, '.vscode', 'mcp.json'))),
  ];
  expect(problems).toEqual([]);
}

describe('editor MCP launch written by generate', () => {
  it('Onboard_FreshRepo_DoesNotPublishFloatingRegistryLaunch', async () => {
    const fx = await createFixture('onboard-mcp-launch-');
    try {
      const drift = await blockDriftCheck(fx.repoRoot);
      expect(drift.status).toBe('Warning');
      expect(drift.fix).toBeDefined();

      const result = await handleOnboard(
        { surface: 'cli', format: 'json' },
        fx.ctx,
        {
          repoRoot: fx.repoRoot,
          writerDeps: fixtureWriterDeps(fx),
          writers: getAllWriters(),
          runDoctorChecks: async () => [drift],
          detectOptions: { detectRuntimes: async () => [], vcs: 'none' },
        },
      );

      const data = result.data as {
        plan?: { steps: { kind: string; key: string }[] };
      };
      expect(data.plan?.steps.some((step) => step.kind === 'generate' && step.key === 'onramp-block-drift')).toBe(true);
      await assertPinnedProjectLaunches(fx.repoRoot);
    } finally {
      fx.eventStore.close();
      await rmrfAsync(fx.base);
    }
  });

  it('DoctorFix_FreshRepo_DoesNotPublishFloatingRegistryLaunch', async () => {
    const fx = await createFixture('doctor-mcp-launch-');
    try {
      const drift = await blockDriftCheck(fx.repoRoot);
      expect(drift.status).toBe('Warning');

      const result = await handleDoctorWithChecks(
        { fix: true, format: 'json' },
        fx.ctx,
        [async () => blockDriftCheck(fx.repoRoot)],
        () => makeStubProbes(),
        {
          repoRoot: fx.repoRoot,
          writerDeps: fixtureWriterDeps(fx),
          writers: getAllWriters(),
          runDoctorChecks: async () => [await blockDriftCheck(fx.repoRoot)],
          detectOptions: { detectRuntimes: async () => [], vcs: 'none' },
        },
      );

      const data = result.data as {
        postFix?: { plan?: { steps: { kind: string; key: string }[] } };
      };
      expect(data.postFix?.plan?.steps.some((step) => step.kind === 'generate' && step.key === 'onramp-block-drift')).toBe(true);
      await assertPinnedProjectLaunches(fx.repoRoot);
    } finally {
      fx.eventStore.close();
      await rmrfAsync(fx.base);
    }
  });
});
