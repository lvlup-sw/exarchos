/**
 * Tests for the DR-8 SessionStart binding hook installer (task 012, #1485).
 *
 * Two surfaces are under test, wired end-to-end through the REAL onboard
 * pipeline so the default-on / `--no-hooks` behavior is exercised exactly as
 * production runs it:
 *
 *   1. `installHook` (this module) — the idempotent installer that writes the
 *      #1485 SessionStart binding into the Claude Code agent-host settings
 *      (`<home>/.claude/settings.json`, `hooks.SessionStart[]`). Re-running must
 *      not duplicate the entry.
 *   2. The new `session-start-hook` doctor check — Fails/Warns (with a `fix`)
 *      when the binding is absent, Passes when present. Its `name` is the stable
 *      key the DR-4 CHECK_CLASSIFICATION maps to a `hook` PlanStep, so without it
 *      the default-on hook step never lands.
 *
 * The pipeline is driven through `handleOnboard` with an injected
 * `runDoctorChecks` seam: a `session-start-hook` Fail BEFORE apply (so the
 * `hook` step is planned) and a green check AFTER (the VERIFY re-diff converges).
 * The real `installHook` is the side effect; we assert against the settings
 * file the installer actually wrote (real fs, redirected `home`).
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import type { CheckResult } from '../doctor/schema.js';
import { buildWriterDeps } from '../init/probes.js';
import type { WriterDeps } from '../init/probes.js';
import { makeStubProbes } from '../doctor/checks/__shared__/make-stub-probes.js';

import { handleOnboard, type HandleOnboardArgs, type OnboardDeps } from './index.js';
import { installHook, SESSION_START_SETTINGS_PATH } from './hooks.js';
import { sessionStartHook } from '../doctor/checks/session-start-hook.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface Fixture {
  readonly repoRoot: string;
  readonly home: string;
  readonly stateDir: string;
  readonly base: string;
  readonly ctx: DispatchContext;
  readonly eventStore: EventStore;
}

/** A temp repo + isolated home (the settings target) + isolated EventStore. */
async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'onboard-hooks-'));
  const repoRoot = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const stateDir = path.join(base, 'state');
  await mkdir(repoRoot, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0' }, null, 2),
    'utf8',
  );
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
  return { repoRoot, home, stateDir, base, ctx, eventStore };
}

async function cleanup(fx: Fixture): Promise<void> {
  await rm(fx.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
    () => {},
  );
}

/** WriterDeps redirected so `home` points at the fixture home (settings target). */
function fixtureWriterDeps(fx: Fixture): WriterDeps {
  const real = buildWriterDeps();
  return { ...real, cwd: () => fx.repoRoot, home: () => fx.home };
}

/** The absolute settings path the installer/check target for this fixture. */
function settingsPath(fx: Fixture): string {
  return path.join(fx.home, SESSION_START_SETTINGS_PATH);
}

/** Read the fixture's settings.json (or undefined when not yet written). */
async function readSettings(fx: Fixture): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(settingsPath(fx), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Count SessionStart command hooks whose command references the exarchos binding. */
function exarchosBindingCount(settings: Record<string, unknown> | undefined): number {
  return bindingCount(settings, 'SessionStart', 'exarchos session-start');
}

/** Count command hooks under `event` whose command includes `marker` (#1572 Gap-1). */
function bindingCount(
  settings: Record<string, unknown> | undefined,
  event: string,
  marker: string,
): number {
  if (!settings) return 0;
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const groups = hooks?.[event];
  if (!Array.isArray(groups)) return 0;
  let count = 0;
  for (const group of groups) {
    const inner = (group as { hooks?: unknown })?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      const cmd = (h as { command?: unknown })?.command;
      if (typeof cmd === 'string' && cmd.includes(marker)) count += 1;
    }
  }
  return count;
}

/** A remediable `session-start-hook` Fail → exactly one `hook` PlanStep. */
const HOOK_FAIL: CheckResult = {
  category: 'agent',
  name: 'session-start-hook',
  status: 'Fail',
  message: 'SessionStart binding (#1485) is not installed',
  fix: 'run exarchos onboard (or doctor --fix) to install the SessionStart binding',
  durationMs: 0,
};

/** A passing hook check contributes no plan step. */
const HOOK_PASS: CheckResult = {
  category: 'agent',
  name: 'session-start-hook',
  status: 'Pass',
  message: 'SessionStart binding (#1485) present',
  durationMs: 0,
};

/** Two-phase `runDoctorChecks`: `before` first call, `after` second. */
function twoPhaseChecks(
  before: readonly CheckResult[],
  after: readonly CheckResult[],
): OnboardDeps['runDoctorChecks'] {
  let n = 0;
  return async () => {
    n += 1;
    return n === 1 ? [...before] : [...after];
  };
}

/** Default deps: real installHook, fixture-redirected writer deps. */
function makeDeps(fx: Fixture, overrides?: Partial<OnboardDeps>): OnboardDeps {
  return {
    repoRoot: fx.repoRoot,
    writerDeps: fixtureWriterDeps(fx),
    writers: [],
    runDoctorChecks: twoPhaseChecks([HOOK_FAIL], [HOOK_PASS]),
    seed: () => ({ wrote: true, path: path.join(fx.repoRoot, '.exarchos.yml') }),
    installHook,
    detectOptions: { detectRuntimes: async () => [], vcs: 'git' },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DR-8 SessionStart hook install (#1485, task 012)', () => {
  it('Hooks_DefaultOn_InstallsSessionStartBinding', async () => {
    const fx = await createFixture();
    try {
      const args: HandleOnboardArgs = { surface: 'cli' };
      const result = await handleOnboard(args, fx.ctx, makeDeps(fx));

      expect(result.success).toBe(true);

      // The binding landed in the fixture home's settings.json.
      const settings = await readSettings(fx);
      expect(exarchosBindingCount(settings)).toBe(1);
    } finally {
      await cleanup(fx);
    }
  });

  it('Hooks_NoHooksFlag_SuppressesBinding', async () => {
    const fx = await createFixture();
    try {
      const args: HandleOnboardArgs = { surface: 'cli', noHooks: true };
      const result = await handleOnboard(args, fx.ctx, makeDeps(fx));

      expect(result.success).toBe(true);

      // --no-hooks neutralizes the installer: no binding written.
      const settings = await readSettings(fx);
      expect(exarchosBindingCount(settings)).toBe(0);
    } finally {
      await cleanup(fx);
    }
  });

  it('Hooks_Rerun_NoDuplicateRegistration', async () => {
    const fx = await createFixture();
    try {
      // Two back-to-back installs against the same settings file.
      const deps = makeDeps(fx);
      await handleOnboard({ surface: 'cli' }, fx.ctx, deps);
      // Second run: the binding is already present, so the installer is a
      // no-op (idempotent). Drive `installHook` directly to isolate idempotency.
      const ctx = {
        repoRoot: fx.repoRoot,
        surface: 'cli' as const,
        writerDeps: fixtureWriterDeps(fx),
      };
      const step = {
        kind: 'hook' as const,
        surface: 'any' as const,
        key: 'session-start-hook',
        description: 'install the #1485 SessionStart binding',
      };
      await installHook(step, ctx);
      await installHook(step, ctx);

      const settings = await readSettings(fx);
      expect(exarchosBindingCount(settings)).toBe(1);
    } finally {
      await cleanup(fx);
    }
  });

  it('Hooks_MalformedSettings_RefusesAndPreservesFile', async () => {
    const fx = await createFixture();
    try {
      // A present-but-malformed settings.json the installer must NOT clobber.
      const sp = settingsPath(fx);
      await mkdir(path.dirname(sp), { recursive: true });
      const corrupt = '{ "hooks": { not valid json ';
      await writeFile(sp, corrupt, 'utf8');

      const step = {
        kind: 'hook' as const,
        surface: 'any' as const,
        key: 'session-start-hook',
        description: 'install the #1485 SessionStart binding',
      };
      const ctx = {
        repoRoot: fx.repoRoot,
        surface: 'cli' as const,
        writerDeps: fixtureWriterDeps(fx),
      };

      // INV-14 (refuse-to-discard): rather than overwriting a file it could not
      // parse, the installer throws — a present-but-unreadable settings.json is
      // not "no settings".
      await expect(installHook(step, ctx)).rejects.toThrow(/refusing to overwrite/i);

      // The user's malformed file is preserved byte-for-byte (no destructive
      // rewrite). The throw is what `applyHookStep` turns into a residual +
      // advisory (forward-only), never a silent clobber.
      const after = await readFile(sp, 'utf8');
      expect(after).toBe(corrupt);
    } finally {
      await cleanup(fx);
    }
  });

  it('Doctor_DetectsMissingSessionStartHook', async () => {
    const fx = await createFixture();
    try {
      // No settings file at all → the check Fails/Warns and carries a fix.
      const probes = makeStubProbes({
        fs: {
          readFile: async () => {
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
          },
          stat: async () => {
            throw new Error('not used');
          },
          access: async () => {
            throw new Error('not used');
          },
        },
        env: { HOME: fx.home },
      });

      const result = await sessionStartHook(probes, new AbortController().signal);

      expect(result.name).toBe('session-start-hook');
      expect(result.category).toBe('agent');
      expect(['Fail', 'Warning']).toContain(result.status);
      expect(typeof result.fix).toBe('string');
      expect(result.fix && result.fix.length).toBeGreaterThan(0);

      // And the present-binding path Passes.
      await installHook(
        {
          kind: 'hook',
          surface: 'any',
          key: 'session-start-hook',
          description: 'install',
        },
        { repoRoot: fx.repoRoot, surface: 'cli', writerDeps: fixtureWriterDeps(fx) },
      );
      const okProbes = makeStubProbes({
        fs: {
          readFile: (p) => readFile(p, 'utf8'),
          stat: async () => ({ isDirectory: () => false, isFile: () => true }),
          access: async () => undefined,
        },
        env: { HOME: fx.home },
      });
      const ok = await sessionStartHook(okProbes, new AbortController().signal);
      expect(ok.status).toBe('Pass');
      expect(ok.fix).toBeUndefined();
    } finally {
      await cleanup(fx);
    }
  });
});

// ─── #1572 Gap-1: SubagentStop + SessionEnd binding symmetry ────────────────
describe('onboard hook symmetry — SessionEnd + SubagentStop (#1572 Gap-1)', () => {
  const step = {
    kind: 'hook' as const,
    surface: 'any' as const,
    key: 'session-start-hook',
    description: 'install the cross-harness Exarchos bindings',
  };

  it('InstallHook_WritesSubagentStopBinding', async () => {
    const fx = await createFixture();
    try {
      await installHook(step, {
        repoRoot: fx.repoRoot,
        surface: 'cli',
        writerDeps: fixtureWriterDeps(fx),
      });
      const settings = await readSettings(fx);
      // The SubagentStop binding — the seam that feeds subagent.tokens_used — is
      // now written for standalone-CLI hosts, symmetric with the plugin hooks.json.
      expect(bindingCount(settings, 'SubagentStop', 'exarchos subagent-stop')).toBe(1);
    } finally {
      await cleanup(fx);
    }
  });

  it('InstallHook_WritesSessionEndBinding', async () => {
    const fx = await createFixture();
    try {
      await installHook(step, {
        repoRoot: fx.repoRoot,
        surface: 'cli',
        writerDeps: fixtureWriterDeps(fx),
      });
      const settings = await readSettings(fx);
      expect(bindingCount(settings, 'SessionEnd', 'exarchos session-end')).toBe(1);
    } finally {
      await cleanup(fx);
    }
  });

  it('InstallHook_WritesAllThreeBindings_Once', async () => {
    const fx = await createFixture();
    try {
      const ctx = {
        repoRoot: fx.repoRoot,
        surface: 'cli' as const,
        writerDeps: fixtureWriterDeps(fx),
      };
      await installHook(step, ctx);
      const settings = await readSettings(fx);
      expect(bindingCount(settings, 'SessionStart', 'exarchos session-start')).toBe(1);
      expect(bindingCount(settings, 'SessionEnd', 'exarchos session-end')).toBe(1);
      expect(bindingCount(settings, 'SubagentStop', 'exarchos subagent-stop')).toBe(1);
    } finally {
      await cleanup(fx);
    }
  });

  it('InstallHook_Reonboard_NoDuplicateBindings', async () => {
    const fx = await createFixture();
    try {
      const ctx = {
        repoRoot: fx.repoRoot,
        surface: 'cli' as const,
        writerDeps: fixtureWriterDeps(fx),
      };
      // Two installs against the same file: every binding stays at exactly one.
      await installHook(step, ctx);
      await installHook(step, ctx);
      const settings = await readSettings(fx);
      expect(bindingCount(settings, 'SessionStart', 'exarchos session-start')).toBe(1);
      expect(bindingCount(settings, 'SessionEnd', 'exarchos session-end')).toBe(1);
      expect(bindingCount(settings, 'SubagentStop', 'exarchos subagent-stop')).toBe(1);
    } finally {
      await cleanup(fx);
    }
  });

  it('InstallHook_PartialPriorState_AddsOnlyMissingBindings', async () => {
    const fx = await createFixture();
    try {
      const ctx = {
        repoRoot: fx.repoRoot,
        surface: 'cli' as const,
        writerDeps: fixtureWriterDeps(fx),
      };
      // Seed a settings.json carrying ONLY the legacy SessionStart binding (the
      // pre-#1572 state). The installer must add the two missing bindings and
      // leave SessionStart untouched (still one).
      const sp = settingsPath(fx);
      await mkdir(path.dirname(sp), { recursive: true });
      await writeFile(
        sp,
        JSON.stringify({
          hooks: {
            SessionStart: [
              { matcher: 'startup|resume', hooks: [{ type: 'command', command: 'exarchos session-start --directive x' }] },
            ],
          },
        }),
        'utf8',
      );

      await installHook(step, ctx);
      const settings = await readSettings(fx);
      expect(bindingCount(settings, 'SessionStart', 'exarchos session-start')).toBe(1);
      expect(bindingCount(settings, 'SessionEnd', 'exarchos session-end')).toBe(1);
      expect(bindingCount(settings, 'SubagentStop', 'exarchos subagent-stop')).toBe(1);
    } finally {
      await cleanup(fx);
    }
  });
});
