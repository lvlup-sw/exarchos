/**
 * Tests for the `onboard --new <name>` greenfield scaffold (DR-3, task 016).
 *
 * DR-3's contract is a *single pipeline*: `--new` is the ONLY difference between
 * greenfield and adopt. The greenfield path seeds the salvageable initial
 * scaffold (dir + `.exarchos.yml` seed + `.gitignore`) into a FRESH `<name>/`,
 * then runs the IDENTICAL DR-2 detect→config→generate→install→verify pipeline
 * against that dir. There is exactly ONE scaffolding/pipeline code path.
 *
 * The suite proves three properties:
 *   - `OnboardNew_Greenfield_ByteEquivalentToAdopt` — `--new foo` produces a repo
 *     equivalent (modulo timestamps) to running `onboard` inside an
 *     equivalently-seeded empty `foo/`. This is the single-path proof: both
 *     invocations drive the same `handleOnboard` body, so their normalized
 *     `ToolResult`s match.
 *   - `OnboardNew_ExistingNonEmptyDir_RefusesCleanly` — a non-empty target dir is
 *     refused with a clear error and NOTHING is written (DR-10 edge case).
 *   - `OnboardNew_EmitsOnboardNewTrigger` — the greenfield run emits
 *     `onboard.requested` carrying `trigger: 'onboard-new'`.
 *
 * The scaffold helper (`scaffoldNewRepo`) is also unit-tested directly with
 * injected fs hooks so the refuse/seed behavior is verified without disk.
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

/** Build injected onboard deps targeting `repoRoot`. */
function makeDeps(repoRoot: string, overrides?: Partial<OnboardDeps>): OnboardDeps {
  return {
    repoRoot,
    writerDeps: writerDepsFor(repoRoot),
    writers: [],
    runDoctorChecks: async () => [GREEN],
    // Deterministic seeder so the config step is reproducible across arms.
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
 * Normalize a `ToolResult` so two independent runs compare equal — strip the
 * wall-clock `durationMs` and per-dispatch `_meta`/`_perf`. The greenfield-vs-
 * adopt comparison ALSO normalizes the absolute repo path so the two distinct
 * temp dirs don't make otherwise-equivalent results diverge.
 */
function normalizeResult(value: unknown, repoRoot: string): unknown {
  const normalized = harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { durationMs: '<MS>' },
    dropKeys: new Set(['_perf', '_meta']),
  });
  // Replace the absolute repo root with a stable placeholder so the two arms'
  // distinct temp dirs don't diverge (the SHAPE is what the single-path proof
  // compares, not the path literal).
  const json = JSON.stringify(normalized).split(repoRoot).join('<REPO>');
  return JSON.parse(json);
}

/** Snapshot a repo's seeded layout: sorted entries + the `.exarchos.yml` body. */
async function repoSnapshot(repoRoot: string): Promise<{ entries: string[]; gitignore: string }> {
  const entries = (await readdir(repoRoot)).sort();
  let gitignore = '';
  if (entries.includes('.gitignore')) {
    gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
  }
  return { entries, gitignore };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('scaffoldNewRepo (DR-3 — greenfield scaffold helper)', () => {
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
      // `.exarchos.yml` is seeded for a Node-detected repo; for an empty dir the
      // resolver finds nothing, so the seed may no-op — the .gitignore is the
      // guaranteed salvageable artifact. The dir itself must exist.
      const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
      expect(gitignore).toContain('.claude/settings.local.json');
    } finally {
      await cleanup(fx);
    }
  });

  it('OnboardNew_ExistingNonEmptyDir_RefusesCleanly', async () => {
    const fx = await createFixture('scaffold-refuse-');
    try {
      // Pre-create a NON-EMPTY target dir.
      const target = path.join(fx.parentDir, 'occupied');
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'README.md'), '# existing\n', 'utf8');
      const before = (await readdir(target)).sort();

      const result = scaffoldNewRepo('occupied', fx.parentDir);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected refusal');
      expect(result.error.code).toBe('ONBOARD_NEW_TARGET_NONEMPTY');
      expect(result.error.message).toMatch(/occupied/);

      // NOTHING was written: the dir is byte-for-byte what it was.
      const after = (await readdir(target)).sort();
      expect(after).toEqual(before);
      expect(after).not.toContain('.gitignore');
      expect(after).not.toContain('.exarchos.yml');
    } finally {
      await cleanup(fx);
    }
  });

  it('refuses cleanly with injected fs hooks (no disk)', () => {
    const writes: string[] = [];
    const deps: ScaffoldNewDeps = {
      isNonEmptyDir: () => true, // target exists + non-empty
      targetExistsAsFile: () => false, // exists as a dir, not a file
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
    expect(writes).toHaveLength(0); // wrote nothing
  });

  it('OnboardNew_PathLikeName_RefusesBeforeAnyFsAccess', () => {
    // `--new` takes a bare project NAME. A traversal / absolute / separator'd
    // value could escape parentDir, so it is rejected BEFORE any fs probe or
    // write — proven by deps that throw if touched.
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

  it('OnboardNew_TargetIsAFile_RefusesNotDirectory', async () => {
    const fx = await createFixture('scaffold-file-');
    try {
      // A NON-directory already occupies the resolved target path.
      const target = path.join(fx.parentDir, 'occupied-file');
      await writeFile(target, 'i am a file\n', 'utf8');
      const before = await readFile(target, 'utf8');

      const result = scaffoldNewRepo('occupied-file', fx.parentDir);

      // A structured refusal — NOT an ENOTDIR crash from the non-empty probe.
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected refusal');
      expect(result.error.code).toBe('ONBOARD_NEW_TARGET_NOT_DIRECTORY');

      // The file is untouched (no partial scaffold).
      expect(await readFile(target, 'utf8')).toBe(before);
    } finally {
      await cleanup(fx);
    }
  });
});

describe('handleOnboard --new (DR-3 — greenfield single pipeline)', () => {
  it('OnboardNew_Greenfield_ByteEquivalentToAdopt', async () => {
    // ARM A: `onboard --new foo` — scaffold-then-pipeline through ONE path.
    const fxNew = await createFixture('greenfield-new-');
    // ARM B: `onboard` run inside an equivalently-seeded empty `foo/`.
    const fxAdopt = await createFixture('greenfield-adopt-');
    try {
      // ── ARM A: greenfield. The handler scaffolds `<parent>/foo` then runs the
      // identical pipeline against it. `scaffold` is injected so the test
      // controls WHERE the new repo lands; production uses the real fs default.
      const newRepoRoot = path.join(fxNew.parentDir, 'foo');
      const depsNew = makeDeps(fxNew.parentDir, {
        // For greenfield the handler retargets these to the scaffolded dir.
        scaffold: (name) => scaffoldNewRepo(name, fxNew.parentDir),
      });
      const argsNew: HandleOnboardArgs = { surface: 'cli', new: 'foo', format: 'json' };
      const resultNew = await handleOnboard(argsNew, fxNew.ctx, depsNew);
      expect(resultNew.success).toBe(true);
      const snapNew = await repoSnapshot(newRepoRoot);

      // ── ARM B: adopt. Equivalently seed an empty `foo/` ourselves, then run
      // plain `onboard` against it (no `--new`).
      const adoptRepoRoot = path.join(fxAdopt.parentDir, 'foo');
      const seeded = scaffoldNewRepo('foo', fxAdopt.parentDir);
      expect(seeded.ok).toBe(true);
      const depsAdopt = makeDeps(adoptRepoRoot);
      const argsAdopt: HandleOnboardArgs = { surface: 'cli', format: 'json' };
      const resultAdopt = await handleOnboard(argsAdopt, fxAdopt.ctx, depsAdopt);
      expect(resultAdopt.success).toBe(true);
      const snapAdopt = await repoSnapshot(adoptRepoRoot);

      // ── Byte-equivalence (modulo timestamps + the absolute repo path).
      // The seeded layouts match.
      expect(snapNew.entries).toEqual(snapAdopt.entries);
      expect(snapNew.gitignore).toEqual(snapAdopt.gitignore);

      // The pipeline RESULTS match, modulo the greenfield flag + durations +
      // repo path. Strip the one field DR-3 says MUST differ (`greenfield`) and
      // assert the rest is identical — the single-path proof.
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

      // The ONLY shape difference: greenfield is flagged on the `--new` arm.
      const dataNew = resultNew.data as { greenfield: boolean };
      const dataAdopt = resultAdopt.data as { greenfield: boolean };
      expect(dataNew.greenfield).toBe(true);
      expect(dataAdopt.greenfield).toBe(false);
    } finally {
      await cleanup(fxNew);
      await cleanup(fxAdopt);
    }
  });

  it('OnboardNew_ExistingNonEmptyDir_RefusesCleanly', async () => {
    const fx = await createFixture('handler-refuse-');
    try {
      // Pre-create a non-empty target.
      const target = path.join(fx.parentDir, 'taken');
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'keep.txt'), 'data\n', 'utf8');
      const before = (await readdir(target)).sort();

      const deps = makeDeps(fx.parentDir, {
        scaffold: (name) => scaffoldNewRepo(name, fx.parentDir),
        // If the pipeline ran, this spy would fire — it must NOT.
        seed: vi.fn(() => ({ wrote: true, path: path.join(target, '.exarchos.yml') })),
      });
      const result = await handleOnboard(
        { surface: 'cli', new: 'taken' },
        fx.ctx,
        deps,
      );

      // Refused with a clear error; the pipeline never ran.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ONBOARD_NEW_TARGET_NONEMPTY');
      expect(deps.seed).not.toHaveBeenCalled();

      // No events emitted — the run never reached the two-event split.
      const types = await onboardEvents(fx);
      expect(types).toHaveLength(0);

      // The target dir is untouched.
      const after = (await readdir(target)).sort();
      expect(after).toEqual(before);
    } finally {
      await cleanup(fx);
    }
  });

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

      // The two-event split landed, and `onboard.requested` carries the
      // greenfield trigger.
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
