/**
 * Tests for the `onboard --new <name>` greenfield scaffold.
 *
 * Greenfield and adopt share one pipeline. `--new` seeds a fresh `<name>/` with the scaffold,
 * then runs the adopt pipeline against it.
 *
 * The suite checks three properties:
 *   - `OnboardNew_Greenfield_ByteEquivalentToAdopt`: `--new foo` gives the same result as `onboard`
 *     inside an equally seeded empty `foo/`, apart from timestamps, paths and the `greenfield` flag.
 *   - `OnboardNew_ExistingNonEmptyDir_RefusesCleanly`: the handler refuses a non-empty target and writes nothing.
 *   - `OnboardNew_EmitsOnboardNewTrigger`: `onboard.requested` carries `trigger: 'onboard-new'`.
 * Tests with injected fs hooks also check `scaffoldNewRepo` without disk access.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { ONBOARD_STREAM_ID } from '../../../../src/dispatch/core/infra-streams.js';
import type { CheckResult } from '../../../../src/verbs/doctor/schema.js';
import { buildWriterDeps } from '../../../../src/verbs/init/probes.js';
import type { WriterDeps } from '../../../../src/verbs/init/probes.js';
import { normalize as harnessNormalize } from '../../parity-harness.js';

import { handleOnboard, type HandleOnboardArgs, type OnboardDeps } from '../../../../src/verbs/onboard/index.js';
import { scaffoldNewRepo, type ScaffoldNewDeps } from '../../../../src/verbs/onboard/new.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

interface Fixture {
  /** The cwd the greenfield run resolves `<name>` against (the parent dir). */
  readonly parentDir: string;
  readonly base: string;
  readonly stateDir: string;
  readonly ctx: DispatchContext;
  readonly eventStore: EventStore;
}

/** A temp parent dir + an isolated EventStore wired into a DispatchContext. */
async function createFixture(prefix = 'onboard-new-'): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), prefix));
  const parentDir = path.join(base, 'parent');
  const stateDir = path.join(base, 'state');
  await mkdir(parentDir, { recursive: true });
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
  return { parentDir, base, stateDir, ctx, eventStore };
}

async function cleanup(fx: Fixture): Promise<void> {
  await rmrfAsync(fx.base).catch(
    () => {},
  );
}

/** A WriterDeps pointed at a specific repo root (real fs, redirected cwd/home). */
function writerDepsFor(repoRoot: string): WriterDeps {
  const real = buildWriterDeps();
  return { ...real, cwd: () => repoRoot, home: () => repoRoot };
}

/** A passing check contributes no plan step (green doctor → empty plan). */
const GREEN: CheckResult = {
  category: 'storage',
  name: 'state-dir',
  status: 'Pass',
  message: 'state dir present',
  durationMs: 0,
};

/** Builds injected onboard deps for `repoRoot`. The seeder is deterministic, so the config step gives the same result in both arms. */
function makeDeps(repoRoot: string, overrides?: Partial<OnboardDeps>): OnboardDeps {
  return {
    repoRoot,
    writerDeps: writerDepsFor(repoRoot),
    writers: [],
    runDoctorChecks: async () => [GREEN],
    seed: () => ({ wrote: true, path: path.join(repoRoot, '.exarchos.yml') }),
    installStep: vi.fn().mockResolvedValue(undefined),
    installHook: vi.fn().mockResolvedValue(undefined),
    detectOptions: { detectRuntimes: async () => [], vcs: 'git' },
    ...overrides,
  };
}

/** Read the onboard stream's event types. */
async function onboardEvents(fx: Fixture): Promise<string[]> {
  const events = await fx.eventStore.query(ONBOARD_STREAM_ID);
  return events.map((e) => e.type);
}

/**
 * Normalizes a `ToolResult` so that two separate runs compare equal.
 * It replaces timestamps, UUIDs and `durationMs` with placeholders, and drops `_meta` and `_perf`.
 * It also replaces the absolute repo root with `<REPO>`, because the two arms use different temporary directories.
 */
function normalizeResult(value: unknown, repoRoot: string): unknown {
  const normalized = harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { durationMs: '<MS>' },
    dropKeys: new Set(['_perf', '_meta']),
  });
  const json = JSON.stringify(normalized).split(repoRoot).join('<REPO>');
  return JSON.parse(json);
}

/** Snapshots the seeded layout of a repo: the sorted entries and the `.gitignore` body. */
async function repoSnapshot(repoRoot: string): Promise<{ entries: string[]; gitignore: string }> {
  const entries = (await readdir(repoRoot)).sort();
  let gitignore = '';
  if (entries.includes('.gitignore')) {
    gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
  }
  return { entries, gitignore };
}

describe('scaffoldNewRepo (DR-3 — greenfield scaffold helper)', () => {
  /**
   * For an empty directory, the config resolver finds nothing, and the `.exarchos.yml` seed can skip the write.
   * Thus the test checks only the directory and the `.gitignore`.
   */
  it('seeds a fresh dir with .exarchos.yml + .gitignore', async () => {
    const fx = await createFixture('scaffold-seed-');
    try {
      const result = scaffoldNewRepo('foo', fx.parentDir);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');

      const repoRoot = result.repoRoot;
      expect(repoRoot).toBe(path.join(fx.parentDir, 'foo'));

      const dirStat = await stat(repoRoot);
      expect(dirStat.isDirectory()).toBe(true);

      const entries = (await readdir(repoRoot)).sort();
      expect(entries).toContain('.gitignore');
      const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
      expect(gitignore).toContain('.claude/settings.local.json');
    } finally {
      await cleanup(fx);
    }
  });

  it('OnboardNew_ExistingNonEmptyDir_RefusesCleanly', async () => {
    const fx = await createFixture('scaffold-refuse-');
    try {
      const target = path.join(fx.parentDir, 'occupied');
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'README.md'), '# existing\n', 'utf8');
      const before = (await readdir(target)).sort();

      const result = scaffoldNewRepo('occupied', fx.parentDir);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected refusal');
      expect(result.error.code).toBe('ONBOARD_NEW_TARGET_NONEMPTY');
      expect(result.error.message).toMatch(/occupied/);

      const after = (await readdir(target)).sort();
      expect(after).toEqual(before);
      expect(after).not.toContain('.gitignore');
      expect(after).not.toContain('.exarchos.yml');
    } finally {
      await cleanup(fx);
    }
  });

  /** The target exists as a non-empty directory, so the scaffold refuses and writes nothing. */
  it('refuses cleanly with injected fs hooks (no disk)', () => {
    const writes: string[] = [];
    const deps: ScaffoldNewDeps = {
      isNonEmptyDir: () => true,
      targetExistsAsFile: () => false,
      mkdir: () => {
        throw new Error('mkdir must not run when refusing');
      },
      seed: () => {
        throw new Error('seed must not run when refusing');
      },
      writeGitignore: (p) => {
        writes.push(p);
      },
    };

    const result = scaffoldNewRepo('bar', '/tmp/parent', deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error.code).toBe('ONBOARD_NEW_TARGET_NONEMPTY');
    expect(writes).toHaveLength(0);
  });

  /**
   * `--new` takes a bare project name. A traversal, an absolute path or a separator can escape `parentDir`.
   * The scaffold refuses such a name before any fs probe or write. The trap deps throw if a call reaches them.
   */
  it('OnboardNew_PathLikeName_RefusesBeforeAnyFsAccess', () => {
    const trap: ScaffoldNewDeps = {
      isNonEmptyDir: () => {
        throw new Error('must not probe on an invalid name');
      },
      targetExistsAsFile: () => {
        throw new Error('must not probe on an invalid name');
      },
      mkdir: () => {
        throw new Error('must not mkdir on an invalid name');
      },
      seed: () => {
        throw new Error('must not seed on an invalid name');
      },
      writeGitignore: () => {
        throw new Error('must not write on an invalid name');
      },
    };

    for (const bad of ['../escape', '/tmp/abs', 'a/b', '.', '..', '']) {
      const result = scaffoldNewRepo(bad, '/tmp/parent', trap);
      expect(result.ok, `name ${JSON.stringify(bad)} must be refused`).toBe(false);
      if (result.ok) throw new Error('expected refusal');
      expect(result.error.code).toBe('ONBOARD_NEW_INVALID_NAME');
    }
  });

  /**
   * A file at the target path gives a structured refusal, not an ENOTDIR crash from the non-empty probe.
   * The file stays the same, with no partial scaffold.
   */
  it('OnboardNew_TargetIsAFile_RefusesNotDirectory', async () => {
    const fx = await createFixture('scaffold-file-');
    try {
      const target = path.join(fx.parentDir, 'occupied-file');
      await writeFile(target, 'i am a file\n', 'utf8');
      const before = await readFile(target, 'utf8');

      const result = scaffoldNewRepo('occupied-file', fx.parentDir);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected refusal');
      expect(result.error.code).toBe('ONBOARD_NEW_TARGET_NOT_DIRECTORY');

      expect(await readFile(target, 'utf8')).toBe(before);
    } finally {
      await cleanup(fx);
    }
  });
});

describe('handleOnboard --new (DR-3 — greenfield single pipeline)', () => {
  /**
   * Arm A runs `onboard --new foo`. The test injects `scaffold` to control where the new repo lands,
   * and the handler points the deps at the scaffolded directory.
   * Arm B seeds an empty `foo/` with the same scaffold, then runs plain `onboard` against it.
   * The layouts and the normalized results must match. The only difference is the `greenfield` flag.
   */
  it('OnboardNew_Greenfield_ByteEquivalentToAdopt', async () => {
    const fxNew = await createFixture('greenfield-new-');
    const fxAdopt = await createFixture('greenfield-adopt-');
    try {
      const newRepoRoot = path.join(fxNew.parentDir, 'foo');
      const depsNew = makeDeps(fxNew.parentDir, {
        scaffold: (name) => scaffoldNewRepo(name, fxNew.parentDir),
      });
      const argsNew: HandleOnboardArgs = { surface: 'cli', new: 'foo', format: 'json' };
      const resultNew = await handleOnboard(argsNew, fxNew.ctx, depsNew);
      expect(resultNew.success).toBe(true);
      const snapNew = await repoSnapshot(newRepoRoot);

      const adoptRepoRoot = path.join(fxAdopt.parentDir, 'foo');
      const seeded = scaffoldNewRepo('foo', fxAdopt.parentDir);
      expect(seeded.ok).toBe(true);
      const depsAdopt = makeDeps(adoptRepoRoot);
      const argsAdopt: HandleOnboardArgs = { surface: 'cli', format: 'json' };
      const resultAdopt = await handleOnboard(argsAdopt, fxAdopt.ctx, depsAdopt);
      expect(resultAdopt.success).toBe(true);
      const snapAdopt = await repoSnapshot(adoptRepoRoot);

      expect(snapNew.entries).toEqual(snapAdopt.entries);
      expect(snapNew.gitignore).toEqual(snapAdopt.gitignore);

      const stripGreenfield = (r: unknown, repoRoot: string): unknown => {
        const n = normalizeResult(r, repoRoot) as { data?: Record<string, unknown> };
        if (n.data && typeof n.data === 'object') {
          const { greenfield: _g, ...rest } = n.data as Record<string, unknown>;
          return { ...n, data: rest };
        }
        return n;
      };
      expect(stripGreenfield(resultNew, newRepoRoot)).toEqual(
        stripGreenfield(resultAdopt, adoptRepoRoot),
      );

      const dataNew = resultNew.data as { greenfield: boolean };
      const dataAdopt = resultAdopt.data as { greenfield: boolean };
      expect(dataNew.greenfield).toBe(true);
      expect(dataAdopt.greenfield).toBe(false);
    } finally {
      await cleanup(fxNew);
      await cleanup(fxAdopt);
    }
  });

  /**
   * The handler refuses a non-empty target before the pipeline runs. The seed spy gets no call,
   * no event goes to the onboard stream, and the target stays the same.
   */
  it('OnboardNew_ExistingNonEmptyDir_RefusesCleanly', async () => {
    const fx = await createFixture('handler-refuse-');
    try {
      const target = path.join(fx.parentDir, 'taken');
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'keep.txt'), 'data\n', 'utf8');
      const before = (await readdir(target)).sort();

      const deps = makeDeps(fx.parentDir, {
        scaffold: (name) => scaffoldNewRepo(name, fx.parentDir),
        seed: vi.fn(() => ({ wrote: true, path: path.join(target, '.exarchos.yml') })),
      });
      const result = await handleOnboard(
        { surface: 'cli', new: 'taken' },
        fx.ctx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ONBOARD_NEW_TARGET_NONEMPTY');
      expect(deps.seed).not.toHaveBeenCalled();

      const types = await onboardEvents(fx);
      expect(types).toHaveLength(0);

      const after = (await readdir(target)).sort();
      expect(after).toEqual(before);
    } finally {
      await cleanup(fx);
    }
  });

  /** The greenfield run emits `onboard.requested` with `trigger: 'onboard-new'`. */
  it('OnboardNew_EmitsOnboardNewTrigger', async () => {
    const fx = await createFixture('trigger-');
    try {
      const deps = makeDeps(fx.parentDir, {
        scaffold: (name) => scaffoldNewRepo(name, fx.parentDir),
      });
      const result = await handleOnboard(
        { surface: 'cli', new: 'fresh' },
        fx.ctx,
        deps,
      );
      expect(result.success).toBe(true);

      const events = await fx.eventStore.query(ONBOARD_STREAM_ID);
      const requested = events.find((e) => e.type === 'onboard.requested');
      expect(requested).toBeDefined();
      const data = requested?.data as { trigger?: string } | undefined;
      expect(data?.trigger).toBe('onboard-new');
    } finally {
      await cleanup(fx);
    }
  });
});
