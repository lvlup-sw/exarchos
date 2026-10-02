/**
 * Tests the onboard lifecycle-hook seam and the `session-start-hook` doctor check.
 * `installHook` writes the SessionStart, SessionEnd, and SubagentStop bindings into `<home>/.claude/settings.json`, and a second run adds nothing.
 * `removeRetiredHooks` removes the retired SessionStart and SessionEnd bindings and keeps SubagentStop and user hooks.
 *
 * The default-on and `--no-hooks` tests run the real `handleOnboard` pipeline with an injected `runDoctorChecks`.
 * That seam fails `session-start-hook` before apply, so the `hook` step is planned, and passes it after apply.
 * Each test uses the real file system with a redirected `home`.
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { CheckResult } from '../../../../src/verbs/doctor/schema.js';
import { buildWriterDeps } from '../../../../src/verbs/init/probes.js';
import type { WriterDeps } from '../../../../src/verbs/init/probes.js';
import { makeStubProbes } from '../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';

import { handleOnboard, type HandleOnboardArgs, type OnboardDeps } from '../../../../src/verbs/onboard/index.js';
import {
  installHook,
  removeRetiredHooks,
  RETIRED_HOOKS_CHECK_NAME,
  SESSION_START_SETTINGS_PATH,
} from '../../../../src/verbs/onboard/hooks.js';
import { sessionStartHook } from '../../../../src/verbs/doctor/checks/session-start-hook.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

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
  await rmrfAsync(fx.base).catch(
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

/** Count command hooks under `event` whose command includes `marker`. */
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

describe('DR-8 SessionStart hook install (#1485, task 012)', () => {
  it('Hooks_DefaultOn_InstallsSessionStartBinding', async () => {
    const fx = await createFixture();
    try {
      const args: HandleOnboardArgs = { surface: 'cli' };
      const result = await handleOnboard(args, fx.ctx, makeDeps(fx));

      expect(result.success).toBe(true);

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

      const settings = await readSettings(fx);
      expect(exarchosBindingCount(settings)).toBe(0);
    } finally {
      await cleanup(fx);
    }
  });

  /** After one onboard run, the test calls `installHook` twice more to isolate idempotency. */
  it('Hooks_Rerun_NoDuplicateRegistration', async () => {
    const fx = await createFixture();
    try {
      const deps = makeDeps(fx);
      await handleOnboard({ surface: 'cli' }, fx.ctx, deps);
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

  /**
   * A settings file that is present but not parseable is not the same as no settings file.
   * The installer throws instead of overwriting it, and the file stays byte for byte.
   * `applyHookStep` turns the throw into a residual step with an advisory.
   */
  it('Hooks_MalformedSettings_RefusesAndPreservesFile', async () => {
    const fx = await createFixture();
    try {
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

      await expect(installHook(step, ctx)).rejects.toThrow(/refusing to overwrite/i);

      const after = await readFile(sp, 'utf8');
      expect(after).toBe(corrupt);
    } finally {
      await cleanup(fx);
    }
  });

  /**
   * With no settings file, the check fails or warns with a fix. After `installHook` runs, the check passes.
   * The check probes the SubagentStop binding, not SessionStart. `installHook` writes both in one pass.
   */
  it('Doctor_DetectsMissingSessionStartHook', async () => {
    const fx = await createFixture();
    try {
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

describe('onboard hook symmetry — SessionEnd + SubagentStop (#1572 Gap-1)', () => {
  const step = {
    kind: 'hook' as const,
    surface: 'any' as const,
    key: 'session-start-hook',
    description: 'install the cross-harness Exarchos bindings',
  };

  /** The SubagentStop binding feeds `subagent.tokens_used`. The installer writes it for standalone-CLI hosts, as the plugin `hooks.json` does. */
  it('InstallHook_WritesSubagentStopBinding', async () => {
    const fx = await createFixture();
    try {
      await installHook(step, {
        repoRoot: fx.repoRoot,
        surface: 'cli',
        writerDeps: fixtureWriterDeps(fx),
      });
      const settings = await readSettings(fx);
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

  /** The seeded settings file holds only a SessionStart binding. The installer adds the two missing bindings and keeps one SessionStart binding. */
  it('InstallHook_PartialPriorState_AddsOnlyMissingBindings', async () => {
    const fx = await createFixture();
    try {
      const ctx = {
        repoRoot: fx.repoRoot,
        surface: 'cli' as const,
        writerDeps: fixtureWriterDeps(fx),
      };
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

/** A minimal ApplyCtx for driving the hook seam directly against the fixture. */
function hookCtx(fx: Fixture) {
  return {
    repoRoot: fx.repoRoot,
    surface: 'cli' as const,
    writerDeps: fixtureWriterDeps(fx),
  };
}

/** The retired-hooks removal PlanStep (routes installHook → removeRetiredHooks). */
const REMOVE_STEP = {
  kind: 'hook' as const,
  surface: 'any' as const,
  key: RETIRED_HOOKS_CHECK_NAME,
  description: 'remove the retired Exarchos lifecycle hooks',
};

/** Seed the fixture home's settings.json with `settings`. */
async function seedSettings(fx: Fixture, settings: unknown): Promise<void> {
  const sp = settingsPath(fx);
  await mkdir(path.dirname(sp), { recursive: true });
  await writeFile(sp, JSON.stringify(settings, null, 2), 'utf8');
}

describe('DR-7 retired-hook uninstall (removeRetiredHooks, Task 017)', () => {
  /**
   * Mixed case: the retired SessionStart and SessionEnd hooks sit next to a user hook and the kept SubagentStop binding.
   * Other top-level keys stay unchanged.
   */
  it('removeRetiredHooks_MixedSettings_RemovesOnlyOurs', async () => {
    const fx = await createFixture();
    try {
      await seedSettings(fx, {
        model: 'opus',
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume',
              hooks: [{ type: 'command', command: "exarchos session-start --directive 'x'" }],
            },
          ],
          SessionEnd: [
            { matcher: 'auto', hooks: [{ type: 'command', command: 'exarchos session-end' }] },
          ],
          SubagentStop: [
            { matcher: '*', hooks: [{ type: 'command', command: 'exarchos subagent-stop' }] },
          ],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-linter' }] }],
        },
      });

      await removeRetiredHooks(REMOVE_STEP, hookCtx(fx));

      const settings = await readSettings(fx);
      expect(bindingCount(settings, 'SessionStart', 'exarchos session-start')).toBe(0);
      expect(bindingCount(settings, 'SessionEnd', 'exarchos session-end')).toBe(0);
      expect(bindingCount(settings, 'SubagentStop', 'exarchos subagent-stop')).toBe(1);
      expect(bindingCount(settings, 'PreToolUse', 'my-own-linter')).toBe(1);
      expect(settings?.model).toBe('opus');
    } finally {
      await cleanup(fx);
    }
  });

  /** User-only case: with no Exarchos hooks, the remover keeps the user hooks. */
  it('removeRetiredHooks_UserOnly_LeavesUserHooksUntouched', async () => {
    const fx = await createFixture();
    try {
      await seedSettings(fx, {
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-linter' }] }],
        },
      });

      await removeRetiredHooks(REMOVE_STEP, hookCtx(fx));

      const settings = await readSettings(fx);
      expect(bindingCount(settings, 'PreToolUse', 'my-own-linter')).toBe(1);
    } finally {
      await cleanup(fx);
    }
  });

  /** Already-clean case: with no settings file, removal does nothing and does not create a file. */
  it('removeRetiredHooks_AlreadyClean_NoWrite_Idempotent', async () => {
    const fx = await createFixture();
    try {
      await removeRetiredHooks(REMOVE_STEP, hookCtx(fx));
      const settings = await readSettings(fx);
      expect(settings).toBeUndefined();
    } finally {
      await cleanup(fx);
    }
  });

  /** Ours-only case, run twice. The first run removes the retired hooks, and the second run leaves the file byte-stable. */
  it('removeRetiredHooks_RepeatedRuns_Idempotent', async () => {
    const fx = await createFixture();
    try {
      await seedSettings(fx, {
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume',
              hooks: [{ type: 'command', command: 'exarchos session-start --directive x' }],
            },
          ],
          SessionEnd: [
            { matcher: 'auto', hooks: [{ type: 'command', command: 'exarchos session-end' }] },
          ],
        },
      });

      await removeRetiredHooks(REMOVE_STEP, hookCtx(fx));
      const afterFirst = await readFile(settingsPath(fx), 'utf8');

      await removeRetiredHooks(REMOVE_STEP, hookCtx(fx));
      const afterSecond = await readFile(settingsPath(fx), 'utf8');

      const settings = JSON.parse(afterFirst) as Record<string, unknown>;
      expect(bindingCount(settings, 'SessionStart', 'exarchos session-start')).toBe(0);
      expect(bindingCount(settings, 'SessionEnd', 'exarchos session-end')).toBe(0);
      expect(afterSecond).toBe(afterFirst);
    } finally {
      await cleanup(fx);
    }
  });

  /** The `hook` seam sends the retired-hooks key to the remover, so `apply` reaches removal without a second seam. */
  it('removeRetiredHooks_ViaInstallHookDispatch_RemovesRetired', async () => {
    const fx = await createFixture();
    try {
      await seedSettings(fx, {
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume',
              hooks: [{ type: 'command', command: 'exarchos session-start --directive x' }],
            },
          ],
        },
      });

      await installHook(REMOVE_STEP, hookCtx(fx));

      const settings = await readSettings(fx);
      expect(bindingCount(settings, 'SessionStart', 'exarchos session-start')).toBe(0);
    } finally {
      await cleanup(fx);
    }
  });

  /** The remover throws on a settings file that is not parseable, and the file stays byte for byte. */
  it('removeRetiredHooks_MalformedSettings_RefusesAndPreservesFile', async () => {
    const fx = await createFixture();
    try {
      const sp = settingsPath(fx);
      await mkdir(path.dirname(sp), { recursive: true });
      const malformed = '{ "hooks": not-json';
      await writeFile(sp, malformed, 'utf8');

      await expect(removeRetiredHooks(REMOVE_STEP, hookCtx(fx))).rejects.toThrow();

      const after = await readFile(sp, 'utf8');
      expect(after).toBe(malformed);
    } finally {
      await cleanup(fx);
    }
  });
});
